"""Verified event service semantics; no HTTP/browser claim."""

import time
from uuid import uuid4

import pytest
from fastapi import HTTPException

from app.core.config import settings
from app.db.session import SessionLocal
from app.services.oidc_logout import apply_revocation, ensure_not_revoked


def test_verified_id_token_sid_saved_without_access_sid(monkeypatch):
    from app.core.security import unseal
    from app.services.iam_sessions import create_session_payload

    monkeypatch.setattr(settings, "OIDC_DEVICE_LOGOUT_ENABLED", True)
    monkeypatch.setattr(settings, "APP_SECRET", uuid4().hex + uuid4().hex)
    now = int(time.time())
    # Callers have already verified signature/nonce/at_hash and matching subject.
    access = {"sub": "synthetic", "iat": now, "exp": now + 300}
    identity = {**access, "sid": "verified-id-token-session"}
    encrypted, _ = create_session_payload(
        {"access_token": "synthetic-access", "id_token": "synthetic-id"}, access, identity
    )
    assert unseal(encrypted)["authenticated_sid"] == identity["sid"]


@pytest.mark.parametrize("scope", ["device", "all", "legacy"])
def test_logout_scope_preserves_new_login_and_other_user(monkeypatch, client, scope):
    monkeypatch.setattr(settings, "OIDC_GLOBAL_LOGOUT_ENABLED", True)
    monkeypatch.setitem(settings.__dict__, "OIDC_DEVICE_LOGOUT_ENABLED", scope != "legacy")
    subject = "synthetic-" + uuid4().hex
    now = int(time.time())
    event = {"iss": settings.casdoor_issuer, "sub": subject, "iat": now}
    if scope != "all":
        event["sid"] = "device-a"
    audience = settings.CASDOOR_CLIENT_ID
    claims = {**event, "iat": now - 5, "sid": "device-a"}
    with SessionLocal() as db:
        apply_revocation(db, event, audience)
        db.commit()
        with pytest.raises(HTTPException):
            ensure_not_revoked(db, claims, audience)
        ensure_not_revoked(db, {**claims, "sub": subject + "-other"}, audience)
        ensure_not_revoked(db, {**claims, "iat": now + 1}, audience)
        second = {**claims, "sid": "device-b"}
        if scope == "device":
            ensure_not_revoked(db, second, audience)
        else:
            with pytest.raises(HTTPException):
                ensure_not_revoked(db, second, audience)
