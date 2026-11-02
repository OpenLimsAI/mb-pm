"""Live authorization, password lifecycle and history regressions using synthetic identities."""

import copy
import time
from datetime import UTC, datetime
from types import SimpleNamespace

import httpx
import pytest
from fastapi import HTTPException
from jose import jwt
from starlette.requests import Request

from app.core import security
from app.core.config import settings
from app.db.session import SessionLocal
from app.models import IAMSession, PasswordChangeRequired, PortalSession
from app.services import assistant, iam_admin, iam_sessions, oidc_status


@pytest.fixture
def live_provider(monkeypatch, token_factory):
    state = {
        "roles": [{"owner": settings.CASDOOR_ORG, "name": "rd", "isEnabled": True}],
        "needUpdatePassword": False,
        "lastChangePasswordTime": "",
    }
    monkeypatch.setattr(settings, "OIDC_GLOBAL_LOGOUT_ENABLED", True)
    monkeypatch.setattr(settings, "CASDOOR_ACCOUNT_STATUS_VISIBLE", True)

    class Provider:
        def __init__(self, **kwargs):
            assert kwargs["trust_env"] is False
            assert kwargs["follow_redirects"] is False

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def post(self, url, **kwargs):
            token = jwt.get_unverified_claims(kwargs["data"]["token"])
            return httpx.Response(
                200, json={"active": True, "client_id": token["aud"][0], "sub": token["sub"]}
            )

        def get(self, url, **kwargs):
            if state.get("offline"):
                raise httpx.ReadTimeout("synthetic IAM unavailable")
            user = {
                "id": kwargs["params"]["userId"],
                "owner": settings.CASDOOR_ORG,
                "isForbidden": False,
                "isDeleted": False,
                **{k: v for k, v in state.items() if k != "offline"},
            }
            return httpx.Response(200, json={"status": "ok", "data": user})

    monkeypatch.setattr(oidc_status.httpx, "Client", Provider)
    return state


@pytest.mark.parametrize("cookie", [False, True])
def test_demoted_admin_cannot_mutate_with_old_jwt(
    client, iam_user, token_factory, live_provider, cookie
):
    subject = iam_user("hardened-demoted", "rd")
    access = token_factory("admin", sub=subject, name=subject, iat=int(time.time()) - 10)
    headers = {"Authorization": "Bearer " + access}
    if cookie:
        with SessionLocal() as db:
            db.merge(
                IAMSession(
                    id=security.digest("stale-admin-session"),
                    tokens=security.seal({"access_token": access}),
                    expires_at=int(time.time()) + 100,
                )
            )
            db.commit()
        headers = {"Cookie": "mbpm_iam_session=stale-admin-session", "Origin": settings.pms_origin}
    response = client.post(
        "/api/v1/templates",
        headers=headers,
        json={"name": "Must not be created", "product_type": "单抗", "initial_structure": {}},
    )
    assert response.status_code == 403
    me = client.get("/api/v1/auth/me", headers=headers)
    assert me.status_code == 200 and me.json()["role"] == "rd"
    live_provider["offline"] = True
    unavailable = client.get("/api/v1/auth/me", headers=headers)
    assert unavailable.status_code == 503
    assert "Max-Age=0" not in unavailable.headers.get("set-cookie", "")


@pytest.mark.parametrize("portal", [False, True])
@pytest.mark.parametrize("state", ["", "unrelated-state"])
def test_unrelated_callback_preserves_existing_session(portal, state, token_factory):
    from app.api.v1 import auth
    from app.api.v1 import portal as portal_api

    callback = portal_api.handle_callback if portal else auth.callback
    cookie = "mbportal_iam_session" if portal else "mbpm_iam_session"
    request = Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/callback",
            "headers": [(b"cookie", (cookie + "=synthetic-existing-session").encode())],
        }
    )
    response = callback(request, code="untrusted-code", state=state, error="", db=None)
    assert response.status_code == 303
    assert all(
        not value.startswith(cookie + "=") for value in response.headers.getlist("set-cookie")
    )


@pytest.mark.parametrize("metadata", [None, {"version": 1, "used_sources": ["knowledge"]}])
@pytest.mark.parametrize("failure", [403, 503])
def test_knowledge_only_history_is_reauthorized(monkeypatch, metadata, failure):
    def denied(_claims):
        raise HTTPException(failure, "synthetic KB grant revoked/unavailable")

    monkeypatch.setattr(assistant.solution_knowledge, "check_access", denied)
    row = SimpleNamespace(
        application_scope=metadata, data_sources='["knowledge"]', answer_mode="knowledge"
    )
    with pytest.raises(HTTPException) as error:
        assistant.check_history_access(None, {"sub": "user"}, [row])
    assert error.value.status_code == failure


def test_known_unused_knowledge_selection_does_not_gate_history(monkeypatch):
    monkeypatch.setattr(
        assistant.solution_knowledge, "check_access", lambda _: pytest.fail("unused KB")
    )
    row = SimpleNamespace(
        application_scope={"version": 1, "used_sources": []},
        data_sources='["knowledge"]',
        answer_mode="general",
    )
    assistant.check_history_access(None, {"sub": "user"}, [row])


@pytest.mark.parametrize(
    "field,value",
    [
        ("roles", None),
        ("needUpdatePassword", None),
        ("lastChangePasswordTime", None),
        ("lastChangePasswordTime", "invalid"),
        ("lastChangePasswordTime", "2026-01-01T12:00:00"),
    ],
)
def test_incomplete_live_security_fields_fail_closed(live_provider, token_factory, field, value):
    live_provider[field] = value
    token = token_factory(iat=int(time.time()))
    with pytest.raises(HTTPException) as error:
        oidc_status.ensure_active_token(
            token, jwt.get_unverified_claims(token), expected_audience=settings.CASDOOR_CLIENT_ID
        )
    assert error.value.status_code == 503


@pytest.mark.parametrize("portal", [False, True])
def test_refreshed_cookie_uses_original_auth_time_for_password_revocation(
    client, iam_user, token_factory, live_provider, monkeypatch, portal
):
    subject = iam_user("hard-refresh-pwd", "rd")
    now = int(time.time())
    audience = settings.portal_client_id if portal else settings.CASDOOR_CLIENT_ID
    old = token_factory(
        "rd", sub=subject, name=subject, aud=[audience], iat=now - 3600, exp=now + 20
    )
    renewed = token_factory(
        "rd", sub=subject, name=subject, aud=[audience], iat=now, exp=now + 3600
    )
    live_provider["lastChangePasswordTime"] = datetime.fromtimestamp(now - 60, UTC).isoformat()
    monkeypatch.setattr(
        iam_sessions.httpx,
        "post",
        lambda *a, **kw: httpx.Response(
            200,
            json={
                "access_token": renewed,
                "id_token": renewed,
                "refresh_token": "rotated-synthetic",
            },
        ),
    )
    model = PortalSession if portal else IAMSession
    cookie = "mbportal_iam_session" if portal else "mbpm_iam_session"
    with SessionLocal() as db:
        db.merge(
            model(
                id=security.digest("password-refresh"),
                expires_at=now + 1000,
                tokens=security.seal(
                    {
                        "access_token": old,
                        "id_token": old,
                        "refresh_token": "old-synthetic",
                        "started_at": now - 3600,
                        "last_seen_at": now - 30,
                        "authenticated_iat": now - 3600,
                    }
                ),
            )
        )
        db.commit()
    path = "/api/v1/portal/me" if portal else "/api/v1/auth/me"
    response = client.get(path, headers={"Cookie": cookie + "=password-refresh"})
    assert response.status_code == 401 and "密码已修改" in response.json()["detail"]


def test_temp_password_live_state_blocks_business_but_allows_change_page(
    client, iam_user, token_factory, live_provider
):
    subject = iam_user("hardened-temporary", "admin")
    live_provider["needUpdatePassword"] = True
    headers = {"Authorization": "Bearer " + token_factory("admin", sub=subject, name=subject)}
    blocked = client.get("/api/v1/projects", headers=headers)
    assert blocked.status_code == 403 and "临时密码" in blocked.json()["detail"]
    assert client.get("/api/v1/auth/me", headers=headers).json()["must_change_password"] is True
    # Completing the change at the IAM native page clears a legacy local flag.
    live_provider["needUpdatePassword"] = False
    with SessionLocal() as db:
        marker = db.get(PasswordChangeRequired, (settings.casdoor_issuer, subject))
        marker.required_at = int(time.time()) - 120
        db.commit()
    live_provider["lastChangePasswordTime"] = datetime.fromtimestamp(
        int(time.time()) - 60, UTC
    ).isoformat()
    headers = {
        "Authorization": "Bearer "
        + token_factory("rd", sub=subject, name=subject, iat=int(time.time()))
    }
    assert client.get("/api/v1/auth/me", headers=headers).json()["must_change_password"] is False


def test_provider_revocation_targets_exact_user_and_rechecks_rotated_tokens(monkeypatch):
    account = {"id": "immutable-sub", "owner": settings.CASDOOR_ORG, "name": "alice"}
    sessions = [
        {
            "owner": account["owner"],
            "name": "alice",
            "application": "kb",
            "sessionId": ["secret-sid"],
        }
    ]
    tokens = [
        {
            "owner": "built-in",
            "name": "old-token",
            "organization": account["owner"],
            "user": "alice",
            "refreshToken": "secret",
        }
    ]
    foreign = {
        "owner": "built-in",
        "name": "foreign-token",
        "organization": account["owner"],
        "user": "alice-other",
    }
    deleted = []
    rotated = False

    def provider(method, path, **kwargs):
        nonlocal rotated
        if path == "get-user":
            return {"status": "ok", "data": account}
        if path.startswith("get-"):
            assert kwargs["params"]["p"] == "1" and kwargs["params"]["pageSize"] == "100"
            data = sessions if path == "get-sessions" else tokens + [foreign]
            return {"status": "ok", "data": copy.deepcopy(data)}
        item = kwargs["json"]
        assert "refreshToken" not in item and "sessionId" not in item
        deleted.append((path, item["name"]))
        if path == "delete-session":
            sessions.clear()
        else:
            assert item["name"] != "foreign-token"
            tokens[:] = [r for r in tokens if r["name"] != item["name"]]
            if not rotated:
                rotated = True
                tokens.append(
                    {
                        "owner": "built-in",
                        "name": "racing-rotation",
                        "organization": account["owner"],
                        "user": "alice",
                    }
                )
        return {"status": "ok", "data": "Affected"}

    monkeypatch.setattr(iam_admin, "_call", provider)
    iam_admin.revoke_user_authorizations("immutable-sub")
    assert deleted == [
        ("delete-session", "alice"),
        ("delete-token", "old-token"),
        ("delete-token", "racing-rotation"),
    ]
    assert not sessions and not tokens


def test_old_refresh_session_without_initial_identity_timestamp_requires_login(
    client, iam_user, token_factory, live_provider, monkeypatch
):
    now = int(time.time())
    subject = iam_user("hard-legacy-refresh", "rd")
    token = token_factory("rd", sub=subject, name=subject, iat=now, exp=now + 300)
    monkeypatch.setattr(
        iam_sessions.httpx, "post", lambda *a, **kw: pytest.fail("legacy chain refreshed")
    )
    with SessionLocal() as db:
        db.merge(
            IAMSession(
                id=security.digest("legacy-refresh"),
                expires_at=now + 1000,
                tokens=security.seal(
                    {
                        "access_token": token,
                        "refresh_token": "synthetic-old",
                        "started_at": now - 100,
                        "last_seen_at": now - 5,
                    }
                ),
            )
        )
        db.commit()
    response = client.get("/api/v1/auth/me", headers={"Cookie": "mbpm_iam_session=legacy-refresh"})
    assert response.status_code == 401 and "原始认证时间" in response.json()["detail"]


def test_password_change_cleanup_failure_is_not_success_and_still_revokes_locally(
    client, iam_user, token_factory, monkeypatch
):
    from app.models.mdm_integration import OIDCRevocation
    from app.services import password_policy

    subject = iam_user("hard-partial-pwd", "rd")
    token = token_factory("rd", sub=subject, name=subject, iat=int(time.time()) - 60)
    account = {"id": subject, "name": subject, "owner": settings.CASDOOR_ORG}
    calls = []
    monkeypatch.setattr(iam_admin, "get_user_by_sub", lambda sub: account)
    monkeypatch.setattr(
        iam_admin, "check_revocation_available", lambda _: calls.append("preflight")
    )
    monkeypatch.setattr(iam_admin, "set_password", lambda *args: calls.append("password-changed"))

    def failed(_subject):
        raise iam_admin.IAMError("synthetic provider cleanup failure")

    monkeypatch.setattr(iam_admin, "revoke_user_authorizations", failed)
    with SessionLocal() as db:
        identifier = security.digest("partial-password")
        db.add(
            IAMSession(
                id=identifier,
                tokens=security.seal({"access_token": token}),
                expires_at=int(time.time()) + 1000,
            )
        )
        db.commit()
        with pytest.raises(HTTPException) as error:
            password_policy.change_own_password(db, subject, "Old-synthetic1", "New-synthetic2")
        assert error.value.status_code == 503 and "密码已修改" in error.value.detail
        assert db.get(IAMSession, identifier) is None
        assert db.query(OIDCRevocation).filter_by(subject=subject).count() >= 1
    assert calls == ["preflight", "password-changed"]


def test_der_rsa_public_key_cannot_be_used_as_hmac_signing_secret(signing_pair, token_factory):
    """Regression for CVE-2026-85394: strict RS256, even for a well-formed HS256 forgery."""
    import base64
    import hashlib
    import hmac
    import json

    from cryptography.hazmat.primitives import serialization

    private_pem = signing_pair[0]
    if isinstance(private_pem, str):
        private_pem = private_pem.encode()
    private = serialization.load_pem_private_key(private_pem, password=None)
    public_der = private.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )

    def encoded(value):
        return base64.urlsafe_b64encode(value).rstrip(b"=")

    claims = {
        "iss": settings.casdoor_issuer,
        "sub": "forged-admin",
        "owner": settings.CASDOOR_ORG,
        "aud": [settings.CASDOOR_CLIENT_ID],
        "exp": int(time.time()) + 3600,
        "roles": [{"owner": settings.CASDOOR_ORG, "name": "admin", "isEnabled": True}],
    }
    message = (
        encoded(b'{"alg":"HS256","kid":"test-key","typ":"JWT"}')
        + b"."
        + encoded(json.dumps(claims).encode())
    )
    forged = message + b"." + encoded(hmac.new(public_der, message, hashlib.sha256).digest())
    with pytest.raises(HTTPException) as error:
        security.decode_access_token(forged.decode())
    assert error.value.status_code == 401


def test_legacy_knowledge_answer_without_source_metadata_requires_current_permission(monkeypatch):
    def denied(_claims):
        raise HTTPException(403, "synthetic revoked KB permission")

    monkeypatch.setattr(assistant.solution_knowledge, "check_access", denied)
    row = SimpleNamespace(application_scope=None, data_sources="[]", answer_mode="knowledge")
    with pytest.raises(HTTPException) as error:
        assistant.check_history_access(None, {"sub": "user"}, [row])
    assert error.value.status_code == 403
