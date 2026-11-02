"""Session renewal security contracts using synthetic signed IAM tokens only.

The PostgreSQL-only case exercises two independent database sessions competing
for the same refresh token, as happens on the two production service instances.
No test contacts a real IAM provider or sends a customer's token.
"""

import json
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient
from jose import jwt
from sqlalchemy import create_engine, delete
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool
from starlette.requests import Request as StarletteRequest

from app.core import security
from app.core.auth_logging import audit_auth_request, auth_failure
from app.core.config import settings
from app.db.base import Base
from app.models import IAMSession, PortalSession
from app.services import iam_sessions
from app.services.oidc_logout import apply_revocation


def request_for(cookie="session-test", *, portal=False, path="/api/v1/solutions"):
    name = "mbportal_iam_session" if portal else "mbpm_iam_session"
    return StarletteRequest(
        {
            "type": "http",
            "method": "GET",
            "scheme": "https",
            "server": ("pms.test", 443),
            "path": path,
            "query_string": b"",
            "headers": [(b"cookie", f"{name}={cookie}".encode())] if cookie else [],
        }
    )


@pytest.fixture
def renewal_db(token_factory, monkeypatch):
    monkeypatch.setattr(settings, "IAM_SESSION_SECONDS", 3600)
    monkeypatch.setattr(settings, "IAM_SESSION_ABSOLUTE_SECONDS", 28800)
    monkeypatch.setattr(settings, "IAM_REFRESH_LEEWAY_SECONDS", 120)
    monkeypatch.setattr(settings, "OIDC_GLOBAL_LOGOUT_ENABLED", False)
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        yield db
    engine.dispose()


def add_session(
    db,
    token_factory,
    *,
    portal=False,
    cookie="session-test",
    expires_in=60,
    started_ago=3540,
    seen_ago=30,
    refresh="synthetic-refresh-old",
    row_deadline=None,
    claims=None,
):
    now = int(time.time())
    audience = settings.portal_client_id if portal else settings.CASDOOR_CLIENT_ID
    access = token_factory(
        **{
            "sub": "renewal-user",
            "name": "renewal-user",
            "aud": [audience],
            "azp": audience,
            "iat": now - started_ago,
            "exp": now + expires_in,
            **(claims or {}),
        }
    )
    payload = {"access_token": access, "id_token": access}
    if refresh is not None:
        payload.update(
            refresh_token=refresh,
            started_at=now - started_ago,
            last_seen_at=now - seen_ago,
            authenticated_iat=now - started_ago,
        )
    model = PortalSession if portal else IAMSession
    row = model(
        id=security.digest(cookie),
        tokens=security.seal(payload),
        expires_at=row_deadline or now + (28800 - started_ago if refresh else expires_in),
    )
    db.add(row)
    db.commit()
    return row, payload


def refreshed_tokens(token_factory, *, portal=False, claims=None, identity=None):
    now = int(time.time())
    audience = settings.portal_client_id if portal else settings.CASDOOR_CLIENT_ID
    fields = {
        "sub": "renewal-user",
        "name": "renewal-user",
        "aud": [audience],
        "azp": audience,
        "iat": now,
        "exp": now + 3600,
        **(claims or {}),
    }
    access = token_factory(**fields)
    identifier = access if identity is None else token_factory(**{**fields, **identity})
    return {
        "access_token": access,
        "id_token": identifier,
        "refresh_token": "synthetic-refresh-rotated",
        "token_type": "Bearer",
        "expires_in": 3600,
    }


def provider_reply(monkeypatch, payload, status=200):
    calls = []

    def post(url, **kwargs):
        calls.append((url, kwargs))
        return httpx.Response(status, json=payload, request=httpx.Request("POST", url))

    monkeypatch.setattr(iam_sessions.httpx, "post", post)
    return calls


def test_new_session_keeps_refresh_server_side_encrypted_and_bounded(renewal_db, token_factory):
    now = int(time.time())
    tokens = refreshed_tokens(token_factory)
    claims = jwt.get_unverified_claims(tokens["access_token"])
    encrypted, deadline = iam_sessions.create_session_payload(tokens, claims, claims)
    assert tokens["refresh_token"] not in encrypted
    assert tokens["access_token"] not in encrypted
    data = security.unseal(encrypted)
    assert data["refresh_token"] == tokens["refresh_token"]
    assert now <= data["started_at"] <= now + 1
    assert data["last_seen_at"] == data["started_at"]
    assert now + 28800 <= deadline <= now + 28801


def test_legacy_callback_without_refresh_keeps_original_token_deadline(renewal_db, token_factory):
    tokens = refreshed_tokens(token_factory)
    tokens.pop("refresh_token")
    claims = jwt.get_unverified_claims(tokens["access_token"])
    encrypted, deadline = iam_sessions.create_session_payload(tokens, claims, claims)
    assert "refresh_token" not in security.unseal(encrypted)
    assert deadline == claims["exp"]


@pytest.mark.parametrize("portal", [False, True])
def test_active_session_rotates_before_expiry_using_its_own_client(
    renewal_db, token_factory, monkeypatch, portal
):
    if portal:
        monkeypatch.setattr(settings, "PORTAL_CLIENT_ID", "portal-renewal-test")
        monkeypatch.setattr(settings, "PORTAL_CLIENT_SECRET", "portal-secret-test")
    row, old = add_session(renewal_db, token_factory, portal=portal)
    previous_deadline = row.expires_at
    fresh = refreshed_tokens(token_factory, portal=portal)
    calls = provider_reply(monkeypatch, fresh)
    request = request_for(portal=portal)
    claims = iam_sessions.session_claims(request, renewal_db, portal=portal)
    assert claims["sub"] == "renewal-user"
    assert claims["iat"] > jwt.get_unverified_claims(old["access_token"])["iat"]
    assert request.state.auth_refreshed is True
    assert len(calls) == 1
    url, sent = calls[0]
    assert url == settings.casdoor_token_url
    assert sent["trust_env"] is False and sent["follow_redirects"] is False
    assert sent["data"] == {
        "grant_type": "refresh_token",
        "client_id": settings.portal_client_id if portal else settings.CASDOOR_CLIENT_ID,
        "client_secret": settings.portal_client_secret
        if portal
        else settings.CASDOOR_CLIENT_SECRET,
        "refresh_token": old["refresh_token"],
    }
    renewal_db.refresh(row)
    stored = security.unseal(row.tokens)
    assert stored["access_token"] == fresh["access_token"]
    assert stored["refresh_token"] == fresh["refresh_token"]
    assert stored["started_at"] == old["started_at"]
    assert row.expires_at == previous_deadline


def test_recently_expired_access_can_refresh_with_valid_live_session(
    renewal_db, token_factory, monkeypatch
):
    add_session(renewal_db, token_factory, expires_in=-30)
    calls = provider_reply(monkeypatch, refreshed_tokens(token_factory))
    claims = iam_sessions.session_claims(request_for(), renewal_db)
    assert claims["exp"] > int(time.time())
    assert len(calls) == 1


def test_normal_bearer_decoder_never_accepts_expired_access(renewal_db, token_factory):
    access = token_factory(exp=int(time.time()) - 30)
    with pytest.raises(HTTPException) as error:
        security.decode_access_token(access)
    assert error.value.status_code == 401


@pytest.mark.parametrize("boundary", ["absolute", "idle", "row"])
def test_expired_or_idle_session_cannot_be_revived(
    renewal_db, token_factory, monkeypatch, boundary
):
    now = int(time.time())
    monkeypatch.setattr(iam_sessions.time, "time", lambda: now)
    add_session(
        renewal_db,
        token_factory,
        started_ago=28800 if boundary == "absolute" else 3540,
        seen_ago=3600 if boundary == "idle" else 30,
        row_deadline=now if boundary == "row" else now + 100,
    )
    calls = provider_reply(monkeypatch, refreshed_tokens(token_factory))
    with pytest.raises(HTTPException) as error:
        iam_sessions.session_claims(request_for(), renewal_db)
    assert error.value.status_code == 401
    assert error.value.headers["X-Auth-Reason"] == (
        "session_idle" if boundary == "idle" else "session_expired"
    )
    assert calls == []


def test_legacy_session_is_not_extended_or_given_an_implicit_refresh_token(
    renewal_db, token_factory, monkeypatch
):
    row, old = add_session(renewal_db, token_factory, refresh=None, expires_in=600)
    original = row.tokens
    deadline = row.expires_at
    calls = provider_reply(monkeypatch, refreshed_tokens(token_factory))
    iam_sessions.session_claims(request_for(), renewal_db)
    renewal_db.refresh(row)
    assert row.tokens == original and row.expires_at == deadline
    assert calls == [] and "refresh_token" not in old


def test_revocation_prevents_refresh_even_if_provider_could_issue_new_tokens(
    renewal_db, token_factory, monkeypatch
):
    _, old = add_session(renewal_db, token_factory)
    old_claims = jwt.get_unverified_claims(old["access_token"])
    apply_revocation(
        renewal_db,
        {**old_claims, "iat": int(time.time())},
        settings.CASDOOR_CLIENT_ID,
    )
    renewal_db.commit()
    monkeypatch.setattr(settings, "OIDC_GLOBAL_LOGOUT_ENABLED", True)
    calls = provider_reply(monkeypatch, refreshed_tokens(token_factory))
    with pytest.raises(HTTPException) as error:
        iam_sessions.session_claims(request_for(), renewal_db)
    assert error.value.status_code == 401
    assert error.value.headers["X-Auth-Reason"] == "revoked"
    assert calls == []


def test_logout_received_during_refresh_cannot_be_hidden_by_newer_token_iat(
    renewal_db, token_factory, monkeypatch
):
    row, _ = add_session(renewal_db, token_factory)
    original = row.tokens
    fresh = refreshed_tokens(token_factory)
    fresh_claims = jwt.get_unverified_claims(fresh["access_token"])
    monkeypatch.setattr(settings, "OIDC_GLOBAL_LOGOUT_ENABLED", True)
    monkeypatch.setattr(iam_sessions.oidc_status, "ensure_active_token", lambda *a, **kw: None)
    marker_received = False

    def check_latest_marker(db, claims, audience):
        if marker_received and claims["iat"] <= fresh_claims["iat"] - 1:
            raise HTTPException(401, "统一身份会话已撤销，请重新登录")

    monkeypatch.setattr(iam_sessions.oidc_logout, "ensure_not_revoked", check_latest_marker)

    def signed_out_while_refreshing(url, **kwargs):
        nonlocal marker_received
        # A verified back-channel event may commit while the provider is issuing
        # a newer token. Checking only the fresh iat would let the old grant live.
        marker_received = True
        return httpx.Response(200, json=fresh, request=httpx.Request("POST", url))

    monkeypatch.setattr(iam_sessions.httpx, "post", signed_out_while_refreshing)
    with pytest.raises(HTTPException) as error:
        iam_sessions.session_claims(request_for(), renewal_db)
    assert error.value.status_code == 401
    assert error.value.headers["X-Auth-Reason"] == "revoked"
    renewal_db.refresh(row)
    assert row.tokens == original


def test_logout_still_applies_to_original_authorization_after_a_prior_rotation(
    renewal_db, token_factory, monkeypatch
):
    now = int(time.time())
    row, payload = add_session(renewal_db, token_factory, expires_in=3000, started_ago=0)
    payload["authenticated_iat"] = now - 3600
    payload["authenticated_sid"] = "original-iam-session"
    row.tokens = security.seal(payload)
    renewal_db.commit()
    claims = jwt.get_unverified_claims(payload["access_token"])
    apply_revocation(
        renewal_db,
        {**claims, "iat": now - 1},
        settings.CASDOOR_CLIENT_ID,
    )
    renewal_db.commit()
    monkeypatch.setattr(settings, "OIDC_GLOBAL_LOGOUT_ENABLED", True)
    calls = provider_reply(monkeypatch, refreshed_tokens(token_factory))
    with pytest.raises(HTTPException) as error:
        iam_sessions.session_claims(request_for(), renewal_db)
    assert error.value.status_code == 401
    assert error.value.headers["X-Auth-Reason"] == "revoked"
    assert calls == []


@pytest.mark.parametrize(
    "overrides,expected",
    [
        ({"sub": "another-person"}, 401),
        ({"aud": ["another-client"]}, 401),
        ({"aud": [settings.CASDOOR_CLIENT_ID, "another-client"]}, 401),
        ({"azp": "another-client"}, 401),
        ({"iss": "https://another-issuer.test"}, 401),
        ({"owner": "another-company"}, 403),
        ({"isForbidden": True}, 403),
        ({"isDeleted": True}, 403),
    ],
)
def test_rotated_access_is_bound_to_original_identity_and_application(
    renewal_db, token_factory, monkeypatch, overrides, expected
):
    row, _ = add_session(renewal_db, token_factory)
    original = row.tokens
    # Resolve the configured audience after the token_factory fixture initializes it.
    if "aud" in overrides and len(overrides["aud"]) == 2:
        overrides = {"aud": [settings.CASDOOR_CLIENT_ID, "another-client"]}
    calls = provider_reply(monkeypatch, refreshed_tokens(token_factory, claims=overrides))
    with pytest.raises(HTTPException) as error:
        iam_sessions.session_claims(request_for(), renewal_db)
    assert error.value.status_code == expected and len(calls) == 1
    renewal_db.refresh(row)
    assert row.tokens == original


def test_refreshed_id_token_must_match_access_subject(renewal_db, token_factory, monkeypatch):
    add_session(renewal_db, token_factory)
    provider_reply(
        monkeypatch,
        refreshed_tokens(token_factory, identity={"sub": "another-person"}),
    )
    with pytest.raises(HTTPException) as error:
        iam_sessions.session_claims(request_for(), renewal_db)
    assert error.value.status_code == 401


@pytest.mark.parametrize(
    "status,body,expected,reason",
    [
        (
            400,
            {"error": "invalid_grant", "error_description": "SECRET-OLD-REFRESH"},
            401,
            "refresh_rejected",
        ),
        (
            401,
            {"error": "invalid_client", "error_description": "SECRET-CLIENT"},
            503,
            "provider_unavailable",
        ),
        (503, {"error": "server_error"}, 503, "provider_unavailable"),
        (302, {"location": "https://evil.test"}, 503, "provider_unavailable"),
        (200, ["unexpected"], 503, "provider_unavailable"),
        (200, {"access_token": "synthetic"}, 503, "refresh_invalid_response"),
    ],
)
def test_refresh_errors_do_not_destroy_the_session_or_leak_provider_payload(
    renewal_db, token_factory, monkeypatch, status, body, expected, reason
):
    row, _ = add_session(renewal_db, token_factory)
    original = row.tokens
    calls = provider_reply(monkeypatch, body, status)
    with pytest.raises(HTTPException) as error:
        iam_sessions.session_claims(request_for(), renewal_db)
    assert error.value.status_code == expected
    assert error.value.headers["X-Auth-Reason"] == reason
    assert "SECRET" not in str(error.value.detail)
    assert len(calls) == 1
    renewal_db.refresh(row)
    assert row.tokens == original


def test_refresh_transport_timeout_is_not_retried_and_can_be_retried_by_user(
    renewal_db, token_factory, monkeypatch
):
    row, _ = add_session(renewal_db, token_factory)
    original = row.tokens
    calls = []

    def failed(*args, **kwargs):
        calls.append(True)
        raise httpx.ReadTimeout("SECRET-TIMEOUT-PAYLOAD")

    monkeypatch.setattr(iam_sessions.httpx, "post", failed)
    with pytest.raises(HTTPException) as error:
        iam_sessions.session_claims(request_for(), renewal_db)
    assert error.value.status_code == 503 and len(calls) == 1
    assert "SECRET" not in str(error.value.detail)
    renewal_db.refresh(row)
    assert row.tokens == original
    provider_reply(monkeypatch, refreshed_tokens(token_factory))
    assert iam_sessions.session_claims(request_for(), renewal_db)["sub"] == "renewal-user"


def test_fresh_provider_account_state_is_required_before_persisting_rotation(
    renewal_db, token_factory, monkeypatch
):
    row, _ = add_session(renewal_db, token_factory)
    original = row.tokens
    provider_reply(monkeypatch, refreshed_tokens(token_factory))

    def disabled(*args, **kwargs):
        raise HTTPException(403, "统一身份账号已停用或删除")

    monkeypatch.setattr(iam_sessions.oidc_status, "ensure_active_token", disabled)
    with pytest.raises(HTTPException) as error:
        iam_sessions.session_claims(request_for(), renewal_db)
    assert error.value.status_code == 403
    assert error.value.headers["X-Auth-Reason"] == "account_disabled"
    renewal_db.refresh(row)
    assert row.tokens == original


def test_status_outage_after_provider_rotation_keeps_new_credentials_for_safe_retry(
    renewal_db, token_factory, monkeypatch
):
    row, _ = add_session(renewal_db, token_factory)
    fresh = refreshed_tokens(token_factory)
    calls = provider_reply(monkeypatch, fresh)
    checks = []

    def temporarily_unavailable(access, claims, **kwargs):
        checks.append(access)
        if len(checks) == 1:
            raise HTTPException(503, "统一身份状态服务暂不可用")

    monkeypatch.setattr(iam_sessions.oidc_status, "ensure_active_token", temporarily_unavailable)
    with pytest.raises(HTTPException) as error:
        iam_sessions.session_claims(request_for(), renewal_db)
    assert error.value.status_code == 503
    renewal_db.refresh(row)
    assert security.unseal(row.tokens)["refresh_token"] == fresh["refresh_token"]
    # An outage must not leave the old, already consumed refresh token behind.
    # Retaining credentials is not authorization: the second request rechecks
    # their live status before returning any authenticated identity.
    assert iam_sessions.session_claims(request_for(), renewal_db)["sub"] == "renewal-user"
    assert checks == [fresh["access_token"], fresh["access_token"]]
    assert len(calls) == 1


@pytest.mark.parametrize("field", ["access_token", "id_token"])
def test_non_string_rotated_tokens_are_safe_provider_errors(
    renewal_db, token_factory, monkeypatch, field
):
    add_session(renewal_db, token_factory)
    payload = {**refreshed_tokens(token_factory), field: 123}
    provider_reply(monkeypatch, payload)
    with pytest.raises(HTTPException) as error:
        iam_sessions.session_claims(request_for(), renewal_db)
    assert error.value.status_code == 503


def test_auth_lock_transaction_does_not_commit_callers_pending_business_changes(
    renewal_db, token_factory, monkeypatch
):
    add_session(renewal_db, token_factory)
    pending = IAMSession(id="pending-business-session", expires_at=123, tokens="not-committed")
    renewal_db.add(pending)
    provider_reply(monkeypatch, refreshed_tokens(token_factory))
    iam_sessions.session_claims(request_for(), renewal_db)
    renewal_db.rollback()
    assert renewal_db.get(IAMSession, "pending-business-session") is None


def test_unknown_cookie_has_precise_safe_diagnostic_code(renewal_db):
    for cookie in ("", "does-not-exist"):
        with pytest.raises(HTTPException) as error:
            iam_sessions.session_claims(request_for(cookie), renewal_db)
        assert error.value.status_code == 401
        assert error.value.headers == {"X-Auth-Reason": "session_missing"}


def test_auth_audit_uses_route_template_and_never_cookies_headers_or_query(caplog):
    app = FastAPI()
    app.middleware("http")(audit_auth_request)

    @app.get("/api/v1/solutions/{report_id}")
    def route(request: Request, report_id: str):
        raise auth_failure(request, "session_expired", "请重新登录")

    caplog.set_level(logging.INFO, logger="auth.audit")
    with TestClient(app) as client:
        response = client.get(
            "/api/v1/solutions/SECRET-REPORT-ID?token=SECRET-QUERY",
            headers={
                "Cookie": "mbportal_iam_session=SECRET-COOKIE",
                "Authorization": "Bearer SECRET-BEARER",
                "X-Request-ID": "SECRET-UNTRUSTED-ID",
            },
        )
    assert response.status_code == 401
    assert response.headers["X-Auth-Reason"] == "session_expired"
    request_id = response.headers["X-Request-ID"]
    assert len(request_id) == 32 and request_id != "SECRET-UNTRUSTED-ID"
    entries = [r.getMessage() for r in caplog.records if r.name == "auth.audit"]
    assert len(entries) == 1
    assert "SECRET" not in entries[0]
    event = json.loads(entries[0].removeprefix("auth_event "))
    assert event["request_id"] == request_id
    assert event["route"] == "/api/v1/solutions/{report_id}"
    assert event["reason"] == "session_expired" and event["status"] == 401


def test_postgres_two_independent_instances_rotate_only_once(client, token_factory, monkeypatch):
    from app.db.session import engine

    if engine.dialect.name != "postgresql":
        pytest.skip("Requires the PostgreSQL CI service for cross-instance row-lock verification")
    monkeypatch.setattr(settings, "OIDC_GLOBAL_LOGOUT_ENABLED", False)
    cookie = "concurrent-session-" + uuid4().hex
    with Session(engine) as db:
        add_session(db, token_factory, cookie=cookie)
    fresh = refreshed_tokens(token_factory)
    barrier = threading.Barrier(2)
    count_lock = threading.Lock()
    calls = []

    def rotating_provider(url, **kwargs):
        with count_lock:
            calls.append(kwargs["data"]["refresh_token"])
        # Keep the first transaction in the renewal window while the second
        # independent instance tries to acquire the same PostgreSQL row lock.
        time.sleep(0.05)
        return httpx.Response(200, json=fresh, request=httpx.Request("POST", url))

    monkeypatch.setattr(iam_sessions.httpx, "post", rotating_provider)

    def instance_request():
        with Session(engine) as db:
            barrier.wait(timeout=10)
            return iam_sessions.session_claims(request_for(cookie), db)

    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(instance_request) for _ in range(2)]
            results = [future.result(timeout=20) for future in futures]
        assert len(calls) == 1
        assert [r["sub"] for r in results] == ["renewal-user", "renewal-user"]
        assert results[0]["iat"] == results[1]["iat"]
        with Session(engine) as db:
            row = db.get(IAMSession, security.digest(cookie))
            assert security.unseal(row.tokens)["refresh_token"] == fresh["refresh_token"]
    finally:
        with Session(engine) as db:
            db.execute(delete(IAMSession).where(IAMSession.id == security.digest(cookie)))
            db.commit()
