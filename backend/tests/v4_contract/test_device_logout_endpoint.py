"""Real ASGI endpoint, synthetic JWT/HTTP provider stand-in; not E2E."""

import time
from uuid import uuid4

import httpx
import pytest
from sqlalchemy import select

from app.core.config import settings
from app.core.security import digest, seal
from app.db.session import SessionLocal
from app.models import IAMSession, PortalSession
from app.models.mdm_integration import OIDCRevocation


@pytest.mark.parametrize("path", ["/api/v1/auth/logout/device", "/api/v1/portal/logout/device"])
def test_device_logout_default_off_and_origin(client, monkeypatch, path):
    monkeypatch.setattr(settings, "OIDC_GLOBAL_LOGOUT_ENABLED", True)
    monkeypatch.setattr(settings, "OIDC_DEVICE_LOGOUT_ENABLED", False)
    monkeypatch.setattr(settings, "PORTAL_CLIENT_ID", "synthetic-portal")
    monkeypatch.setattr(settings, "PORTAL_CLIENT_SECRET", "synthetic-unused")
    origin = settings.portal_origin if "/portal/" in path else settings.pms_origin
    assert client.post(path, headers={"Origin": origin}, follow_redirects=False).status_code == 503
    assert (
        client.post(
            path, headers={"Origin": "https://wrong.invalid"}, follow_redirects=False
        ).status_code
        == 403
    )


def test_device_logout_posts_false_and_records_only_verified_sid(
    client, token_factory, monkeypatch
):
    monkeypatch.setattr(settings, "OIDC_GLOBAL_LOGOUT_ENABLED", True)
    monkeypatch.setattr(settings, "OIDC_DEVICE_LOGOUT_ENABLED", True)
    sub = "synthetic-device-" + uuid4().hex
    access = token_factory(
        "cmc_lead", sub=sub, name=sub, sid="own-original-sid", iat=int(time.time()) - 5
    )
    raw = uuid4().hex
    other_raw = uuid4().hex
    other_access = token_factory(
        "cmc_lead",
        sub=sub + "-other",
        name=sub + "-other",
        sid="other-user-device",
        iat=int(time.time()) - 5,
    )
    with SessionLocal() as db:
        db.add(
            IAMSession(
                id=digest(raw),
                tokens=seal({"access_token": access}),
                expires_at=int(time.time()) + 600,
            )
        )
        db.commit()
        db.add(
            PortalSession(
                id=digest(other_raw),
                tokens=seal({"access_token": other_access}),
                expires_at=int(time.time()) + 600,
            )
        )
        db.commit()
    client.cookies.set("mbpm_iam_session", raw)
    client.cookies.set("mbportal_iam_session", other_raw)
    calls = []

    class Provider:
        def __init__(self, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def post(self, url, **kwargs):
            calls.append(url)
            if url.endswith("/introspect"):
                if len(calls) == 3:
                    return httpx.Response(200, json={"active": False})
                return httpx.Response(
                    200, json={"active": True, "client_id": settings.CASDOOR_CLIENT_ID, "sub": sub}
                )
            assert kwargs["params"] == {"logoutAll": "false"}
            assert kwargs["headers"]["Cookie"] == ""
            return httpx.Response(200, json={"status": "ok"})

    monkeypatch.setattr("app.services.oidc_logout.httpx.Client", Provider)
    response = client.post(
        "/api/v1/auth/logout/device",
        headers={"Origin": settings.pms_origin},
        follow_redirects=False,
    )
    assert response.status_code == 303 and "signed_out=1" in response.headers["location"]
    with SessionLocal() as db:
        markers = db.scalars(select(OIDCRevocation).where(OIDCRevocation.subject == sub)).all()
        assert markers and all(x.sid == "own-original-sid" for x in markers)
        assert db.get(PortalSession, digest(other_raw)) is not None
    assert not any("mbportal_iam_session=" in x for x in response.headers.get_list("set-cookie"))
    assert len(calls) == 3
