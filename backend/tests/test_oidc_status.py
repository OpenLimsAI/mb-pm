"""Standard provider status contract with explicit transport doubles, not E2E."""

import time
import pytest
import httpx
from fastapi import HTTPException
from app.core.config import settings


@pytest.fixture(autouse=True)
def confirmed_test_status_fields(monkeypatch):
    # Contract fixtures explicitly model an IdP organization with unmasked self fields.
    monkeypatch.setitem(settings.__dict__, "CASDOOR_ACCOUNT_STATUS_VISIBLE", True)


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

        def get(self, *args, **kwargs):
            return httpx.Response(
                200,
                json={
                    "status": "ok",
                    "data": {
                        "id": "status-user",
                        "owner": settings.CASDOOR_ORG,
                        "isForbidden": False,
                        "isDeleted": False,
                    },
                },
            )

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


@pytest.mark.parametrize(
    "case",
    [
        "disabled",
        "deleted",
        "wrong_sub",
        "wrong_owner",
        "missing_flag",
        "typed_flag",
        "offline",
        "timeout",
        "denied",
        "valid",
    ],
)
def test_current_casdoor_user_status_is_checked_without_admin(case, monkeypatch):
    from app.services.oidc_status import ensure_active_token

    monkeypatch.setattr(settings, "OIDC_GLOBAL_LOGOUT_ENABLED", True)
    monkeypatch.setattr(settings, "CASDOOR_CLIENT_SECRET", "synthetic-test-only")
    claims = {
        "iss": settings.casdoor_issuer,
        "sub": "p2-current-user",
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

        def post(self, *args, **kwargs):
            return httpx.Response(
                200,
                json={
                    "active": True,
                    "client_id": settings.CASDOOR_CLIENT_ID,
                    "sub": claims["sub"],
                },
            )

        def get(self, url, **kwargs):
            seen.append(
                {
                    "endpoint": url.endswith("/api/get-user"),
                    "params": kwargs.get("params"),
                    "has_bearer": kwargs.get("headers", {})
                    .get("Authorization", "")
                    .startswith("Bearer "),
                    "has_basic": "auth" in kwargs,
                }
            )
            if case == "offline":
                raise httpx.ConnectError("synthetic offline")
            if case == "timeout":
                raise httpx.ReadTimeout("synthetic timeout")
            if case == "denied":
                return httpx.Response(403, json={"status": "error"})
            user = {
                "id": claims["sub"],
                "owner": settings.CASDOOR_ORG,
                "isForbidden": False,
                "isDeleted": False,
            }
            if case == "disabled":
                user["isForbidden"] = True
            if case == "deleted":
                user["isDeleted"] = True
            if case == "wrong_sub":
                user["id"] = "p2-other-user"
            if case == "wrong_owner":
                user["owner"] = "unrelated-org"
            if case == "missing_flag":
                user.pop("isForbidden")
            if case == "typed_flag":
                user["isForbidden"] = 0
            return httpx.Response(200, json={"status": "ok", "data": user})

    monkeypatch.setattr("app.services.oidc_status.httpx.Client", Provider)
    if case == "valid":
        ensure_active_token("synthetic-input", claims, expected_audience=settings.CASDOOR_CLIENT_ID)
    else:
        with pytest.raises(HTTPException) as exc:
            ensure_active_token(
                "synthetic-input", claims, expected_audience=settings.CASDOOR_CLIENT_ID
            )
        assert exc.value.status_code == (
            503
            if case in {"offline", "timeout"}
            else 403
            if case in {"disabled", "deleted"}
            else 401
        )
    assert seen == [
        {
            "endpoint": True,
            "params": {"owner": settings.CASDOOR_ORG, "userId": claims["sub"]},
            "has_bearer": True,
            "has_basic": False,
        }
    ]


def test_provider_status_requires_explicit_unmasked_fields_confirmation(monkeypatch):
    from app.services.oidc_status import ensure_active_token

    monkeypatch.setattr(settings, "OIDC_GLOBAL_LOGOUT_ENABLED", True)
    monkeypatch.setitem(settings.__dict__, "CASDOOR_ACCOUNT_STATUS_VISIBLE", False)
    monkeypatch.setattr(settings, "CASDOOR_CLIENT_SECRET", "synthetic-test-only")

    class NoProvider:
        def __init__(self, **kwargs):
            raise AssertionError("must reject before contacting provider")

    monkeypatch.setattr("app.services.oidc_status.httpx.Client", NoProvider)
    with pytest.raises(HTTPException) as exc:
        ensure_active_token(
            "synthetic-input",
            {"sub": "p2-current-user"},
            expected_audience=settings.CASDOOR_CLIENT_ID,
        )
    assert exc.value.status_code == 503


@pytest.mark.parametrize("portal", [False, True])
def test_self_status_lifecycle_on_independent_cookie(
    portal, client, iam_user, token_factory, monkeypatch
):
    from app.core.security import digest, seal
    from app.db.session import SessionLocal
    from app.models import IAMSession, PortalSession

    uid = iam_user("p2-state-portal" if portal else "p2-state-pm", "cmc_lead")
    if portal:
        monkeypatch.setattr(settings, "PORTAL_CLIENT_ID", "portal-status-test")
        monkeypatch.setattr(settings, "PORTAL_CLIENT_SECRET", "synthetic-test-only")
    audience = settings.portal_client_id if portal else settings.CASDOOR_CLIENT_ID
    access = token_factory("cmc_lead", sub=uid, name=uid, aud=[audience])
    monkeypatch.setattr(settings, "OIDC_GLOBAL_LOGOUT_ENABLED", True)
    state = {"disabled": False}

    class Provider:
        def __init__(self, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def post(self, *args, **kwargs):
            return httpx.Response(200, json={"active": True, "client_id": audience, "sub": uid})

        def get(self, *args, **kwargs):
            assert kwargs["params"] == {"owner": settings.CASDOOR_ORG, "userId": uid}
            return httpx.Response(
                200,
                json={
                    "status": "ok",
                    "data": {
                        "id": uid,
                        "owner": settings.CASDOOR_ORG,
                        "isForbidden": state["disabled"],
                        "isDeleted": False,
                    },
                },
            )

    monkeypatch.setattr("app.services.oidc_status.httpx.Client", Provider)
    cookie = "mbportal_iam_session" if portal else "mbpm_iam_session"
    model = PortalSession if portal else IAMSession
    session_id = "p2-state-portal-cookie" if portal else "p2-state-pm-cookie"
    with SessionLocal() as db:
        db.add(
            model(
                id=digest(session_id),
                tokens=seal({"access_token": access}),
                expires_at=int(time.time()) + 60,
            )
        )
        db.commit()
    client.cookies.clear()
    client.cookies.set(cookie, session_id)
    path = "/api/v1/portal/me" if portal else "/api/v1/auth/me"
    try:
        response = client.get(path)
        assert response.status_code == 200
        state["disabled"] = True
        response = client.get(path)
        assert response.status_code == 403
        state["disabled"] = False
        response = client.get(path)
        assert response.status_code == 200
    finally:
        client.cookies.clear()
