"""Malformed IAM evidence is retryable; confirmed revocation remains terminal."""

import time

import httpx
import pytest

from app.core import security
from app.core.config import settings
from app.db.session import SessionLocal
from app.models import IAMSession, PortalSession
from app.services import oidc_status


@pytest.mark.parametrize("portal", [False, True])
@pytest.mark.parametrize(
    "part,field,value",
    [
        ("token", "active", None),
        ("token", "active", "true"),
        ("token", "client_id", None),
        ("token", "sub", ""),
        ("user", "id", None),
        ("user", "owner", ""),
        ("user", "isForbidden", None),
        ("user", "isDeleted", 0),
        ("envelope", "status", "error"),
        ("envelope", "data", None),
    ],
)
def test_malformed_status_preserves_cookie_and_recovers(
    client, iam_user, token_factory, monkeypatch, portal, part, field, value
):
    subject = iam_user("shape-portal" if portal else "shape-pm", "cmc_lead")
    if portal:
        monkeypatch.setattr(settings, "PORTAL_CLIENT_ID", "shape-portal")
        monkeypatch.setattr(settings, "PORTAL_CLIENT_SECRET", "synthetic-secret")
    audience = settings.portal_client_id if portal else settings.CASDOOR_CLIENT_ID
    access = token_factory("cmc_lead", sub=subject, name=subject, aud=[audience])
    monkeypatch.setattr(settings, "OIDC_GLOBAL_LOGOUT_ENABLED", True)
    monkeypatch.setattr(settings, "CASDOOR_ACCOUNT_STATUS_VISIBLE", True)
    malformed = True

    class Provider:
        def __init__(self, **kwargs):
            assert kwargs["trust_env"] is False
            assert kwargs["follow_redirects"] is False

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def post(self, *args, **kwargs):
            data = {"active": True, "client_id": audience, "sub": subject}
            if malformed and part == "token":
                data[field] = value
            return httpx.Response(200, json=data)

        def get(self, *args, **kwargs):
            user = {
                "id": subject,
                "owner": settings.CASDOOR_ORG,
                "isForbidden": False,
                "isDeleted": False,
                "roles": [{"owner": settings.CASDOOR_ORG, "name": "cmc_lead", "isEnabled": True}],
                "needUpdatePassword": False,
                "lastChangePasswordTime": "",
            }
            data = {"status": "ok", "data": user}
            if malformed and part == "user":
                user[field] = value
            if malformed and part == "envelope":
                data[field] = value
            return httpx.Response(200, json=data)

    monkeypatch.setattr(oidc_status.httpx, "Client", Provider)
    model = PortalSession if portal else IAMSession
    cookie = "mbportal_iam_session" if portal else "mbpm_iam_session"
    session_id = f"shape-{portal}-{part}-{field}"
    with SessionLocal() as db:
        db.merge(
            model(
                id=security.digest(session_id),
                tokens=security.seal({"access_token": access}),
                expires_at=int(time.time()) + 600,
            )
        )
        db.commit()
    path = "/api/v1/portal/me" if portal else "/api/v1/auth/me"
    headers = {"Cookie": cookie + "=" + session_id}
    client.cookies.clear()
    try:
        failed = client.get(path, headers=headers)
        assert failed.status_code == 503
        assert "Max-Age=0" not in failed.headers.get("set-cookie", "")
        with SessionLocal() as db:
            assert db.get(model, security.digest(session_id)) is not None
        malformed = False
        assert client.get(path, headers=headers).status_code == 200
    finally:
        client.cookies.clear()
