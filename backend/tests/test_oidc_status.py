"""Standard provider status contract with explicit transport doubles, not E2E."""

import time
import pytest
import httpx
from fastapi import HTTPException
from app.core.config import settings


@pytest.mark.parametrize("case", ["inactive", "offline", "wrong_client", "wrong_subject", "valid"])
def test_current_provider_status_is_required(case, monkeypatch):
    from app.services.oidc_status import ensure_active_token

    monkeypatch.setattr(settings, "OIDC_GLOBAL_LOGOUT_ENABLED", True)
    monkeypatch.setattr(settings, "CASDOOR_CLIENT_SECRET", "synthetic-test-only")
    claims = {
        "iss": settings.casdoor_issuer,
        "sub": "status-user",
        "aud": [settings.CASDOOR_CLIENT_ID],
        "exp": int(time.time()) + 60,
    }
    seen = []

    class Provider:
        def __init__(self, **kwargs):
            assert kwargs.get("trust_env") is False

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def post(self, url, **kwargs):
            seen.append(
                {
                    "endpoint": url.endswith("/api/login/oauth/introspect"),
                    "hint": kwargs.get("data", {}).get("token_type_hint"),
                    "has_basic": isinstance(kwargs.get("auth"), httpx.BasicAuth),
                }
            )
            if case == "offline":
                raise httpx.ConnectError("synthetic offline")
            payload = {
                "active": case != "inactive",
                "client_id": settings.CASDOOR_CLIENT_ID,
                "sub": "status-user",
            }
            if case == "wrong_client":
                payload["client_id"] = "another-client"
            if case == "wrong_subject":
                payload["sub"] = "another-subject"
            return httpx.Response(200, json=payload)

    monkeypatch.setattr("app.services.oidc_status.httpx.Client", Provider)
    if case == "valid":
        ensure_active_token("synthetic-input", claims, expected_audience=settings.CASDOOR_CLIENT_ID)
    else:
        with pytest.raises(HTTPException) as exc:
            ensure_active_token(
                "synthetic-input", claims, expected_audience=settings.CASDOOR_CLIENT_ID
            )
        assert exc.value.status_code == (503 if case == "offline" else 401)
    assert seen == [{"endpoint": True, "hint": "access_token", "has_basic": True}]


def test_remote_inactive_rejects_pm_cookie_without_local_marker(
    client, iam_user, token_factory, monkeypatch
):
    from app.core.security import digest, seal
    from app.db.session import SessionLocal
    from app.models import IAMSession

    uid = iam_user("p2-status-inactive", "cmc_lead")
    access = token_factory("cmc_lead", sub=uid, name=uid)
    monkeypatch.setattr(settings, "OIDC_GLOBAL_LOGOUT_ENABLED", True)
    monkeypatch.setattr(settings, "CASDOOR_CLIENT_SECRET", "synthetic-test-only")

    class Provider:
        def __init__(self, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def post(self, *args, **kwargs):
            return httpx.Response(200, json={"active": False})

    monkeypatch.setattr("app.services.oidc_status.httpx.Client", Provider)
    with SessionLocal() as db:
        db.add(
            IAMSession(
                id=digest("status-cookie"),
                tokens=seal({"access_token": access}),
                expires_at=int(time.time()) + 60,
            )
        )
        db.commit()
    client.cookies.set("mbpm_iam_session", "status-cookie")
    try:
        response = client.get("/api/v1/auth/me")
    finally:
        client.cookies.clear()
    assert response.status_code == 401
