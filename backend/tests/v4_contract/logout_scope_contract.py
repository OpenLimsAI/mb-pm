"""Pending v4 single-device contract; explicit-run RED, no browser claim.

Not in default test discovery until the documented scope decision is approved.
The event passed to this service is assumed already signature-verified; separate
existing tests cover issuer/audience/signature/time/replay validation.
"""
import time

import pytest
from fastapi import HTTPException

from app.core.config import settings
from app.db.session import SessionLocal
from app.services.oidc_logout import apply_revocation, ensure_not_revoked


def test_verified_sid_event_preserves_other_device(client, monkeypatch):
    monkeypatch.setattr(settings, 'OIDC_GLOBAL_LOGOUT_ENABLED', True)
    monkeypatch.setitem(settings.__dict__, 'OIDC_DEVICE_LOGOUT_ENABLED', True)
    audience = settings.CASDOOR_CLIENT_ID
    now = int(time.time())
    event = {'iss': settings.casdoor_issuer, 'sub': 'synthetic-scope-owner',
             'sid': 'synthetic-device-a', 'iat': now}
    first = {**event, 'iat': now - 5}
    second = {**first, 'sid': 'synthetic-device-b'}
    other = {**first, 'sub': 'synthetic-other-user'}
    with SessionLocal() as db:
        apply_revocation(db, event, audience)
        db.commit()
        with pytest.raises(HTTPException) as rejected:
            ensure_not_revoked(db, first, audience)
        assert rejected.value.status_code == 401
        ensure_not_revoked(db, other, audience)
        # Current subject-wide policy rejects this too. This is the requested
        # precise device contract, not an instruction to weaken that policy.
        ensure_not_revoked(db, second, audience)
