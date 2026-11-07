"""门户身份与 PM 权限隔离；真实 RSA 验签，全部使用本地模拟 IAM。"""

import base64
import hashlib
import time
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.api.v1.portal import PORTAL_LOGIN_COOKIE, PORTAL_SESSION_COOKIE
from app.core import security
from app.core.config import settings
from app.db.base import Base
from app.db.session import get_db
from app.main import app
from app.models import IAMIdentity, IAMLogin, IAMSession, PortalLogin, PortalSession, User


@pytest.fixture
def portal_fixture(token_factory):
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    db = Session(engine)
    db.add(
        User(
            id="admin",
            username="admin",
            display_name="管理员",
            email="admin@example.com",
            role="admin",
        )
    )
    db.commit()
    app.dependency_overrides[get_db] = lambda: db
    with TestClient(app, base_url=settings.pms_origin, follow_redirects=False) as client:
        yield client, db
    app.dependency_overrides.pop(get_db, None)
    db.close()
    engine.dispose()


def roles(*names):
    return [{"owner": "mabpharm", "name": name, "isEnabled": True} for name in names]


def begin(client, db, return_to="/workspace"):
    response = client.get("/api/v1/portal/login", params={"return_to": return_to})
    assert response.status_code == 303
    parsed = urlparse(response.headers["location"])
    assert f"{parsed.scheme}://{parsed.netloc}" == settings.casdoor_issuer
    params = parse_qs(parsed.query)
    assert params["client_id"] == [settings.portal_client_id]
    assert params["redirect_uri"] == [settings.portal_callback_url]
    assert params["code_challenge_method"] == ["S256"]
    assert "client_secret" not in params
    state = params["state"][0]
    data = security.unseal(db.get(PortalLogin, security.digest(state)).data)
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(data["verifier"].encode()).digest())
        .decode()
        .rstrip("=")
    )
    assert params["code_challenge"] == [challenge]
    assert params["nonce"] == [data["nonce"]]
    assert db.get(IAMLogin, security.digest(state)) is None
    return state, data


def exchange(monkeypatch, token_factory, data, **claims):
    def post(url, **kwargs):
        assert url == settings.casdoor_token_url
        assert kwargs["data"]["redirect_uri"] == settings.portal_callback_url
        assert kwargs["data"]["client_id"] == settings.portal_client_id
        assert kwargs["data"]["client_secret"] == settings.portal_client_secret
        assert kwargs["data"]["code_verifier"] == data["verifier"]
        return httpx.Response(
            200,
            request=httpx.Request("POST", url),
            json={
                "access_token": token_factory(**{"aud": [settings.portal_client_id], **claims}),
                "id_token": token_factory(nonce=data["nonce"], **{"aud": [settings.portal_client_id], **claims}),
            },
        )

    monkeypatch.setattr(httpx, "post", post)


def complete(client, db, token_factory, monkeypatch, **claims):
    state, data = begin(client, db)
    exchange(monkeypatch, token_factory, data, **claims)
    path = "/api/v1/portal/callback" if settings.PORTAL_PUBLIC_URL else "/api/v1/auth/callback"
    return client.get(path, params={"code": "code", "state": state})


def app_map(client):
    response = client.get("/api/v1/portal/me")
    assert response.status_code == 200
    return {item["id"]: item for item in response.json()["applications"]}


def test_new_user_enters_portal_with_pm_open_by_default(portal_fixture, token_factory, monkeypatch):
    client, db = portal_fixture
    response = complete(
        client,
        db,
        token_factory,
        monkeypatch,
        sub="kb-user",
        name="knowledge.reader",
        roles=roles("kb_viewer"),
    )
    assert response.headers["location"] == settings.pms_origin + "/workspace"
    assert "HttpOnly" in response.headers["set-cookie"]
    assert PORTAL_SESSION_COOKIE in response.headers["set-cookie"]
    assert client.get("/api/v1/portal/me").json()["user"] == {
        "id": "kb-user",
        "username": "knowledge.reader",
        "display_name": "knowledge.reader",
    }
    assert app_map(client)["kb"]["enabled"] is True
    assert app_map(client)["information"]["enabled"] is False
    assert app_map(client)["notes"]["enabled"] is True
    # 项目管理默认开放：首次进入项目管理时才建成员，门户目录本身不建成员 / 绑定 / 会话
    assert app_map(client)["pm"]["enabled"] is True
    assert client.get("/api/v1/auth/me").status_code == 401
    assert client.get("/api/v1/projects").status_code == 401
    assert db.query(User).count() == 1
    assert db.query(IAMIdentity).count() == 0
    assert db.query(IAMSession).count() == 0


def test_pm_only_catalogue_checks_but_does_not_bind(portal_fixture, token_factory, monkeypatch):
    client, db = portal_fixture
    assert (
        complete(client, db, token_factory, monkeypatch).headers["location"].endswith("/workspace")
    )
    applications = app_map(client)
    assert applications["pm"]["enabled"] is True
    assert applications["kb"]["enabled"] is False
    assert applications["assistant"]["enabled"] is True
    assert applications["information"]["enabled"] is False
    assert db.query(IAMIdentity).count() == 0
    assert client.get("/api/v1/auth/me").status_code == 401
    # PM 仍需走自身登录建立绑定和业务会话。
    response = client.get("/api/v1/auth/login")
    state = parse_qs(urlparse(response.headers["location"]).query)["state"][0]
    data = security.unseal(db.get(IAMLogin, security.digest(state)).data)
    exchange(monkeypatch, token_factory, data)
    assert (
        client.get("/api/v1/auth/callback", params={"code": "pm-code", "state": state}).headers[
            "location"
        ]
        == settings.pms_origin + "/"
    )
    assert client.get("/api/v1/auth/me").status_code == 200
    assert db.query(IAMIdentity).count() == 1


@pytest.mark.parametrize(
    "claim_roles, pm, kb",
    [
        (roles("admin", "kb_editor"), True, True),
        (roles("admin", "rd", "kb_viewer"), True, True),
        (roles(), True, False),
        ([{"owner": "built-in", "name": "kb_viewer"}], True, False),
        ([{"owner": "mabpharm", "name": "kb_viewer", "isEnabled": False}], True, False),
    ],
)
def test_catalogue_independent_role_rules(
    portal_fixture, token_factory, monkeypatch, claim_roles, pm, kb
):
    client, db = portal_fixture
    complete(client, db, token_factory, monkeypatch, roles=claim_roles)
    applications = app_map(client)
    assert applications["pm"]["enabled"] is pm
    assert applications["kb"]["enabled"] is kb
    assert db.query(IAMIdentity).count() == 0


@pytest.mark.parametrize(
    ("change", "enabled"), [("inactive", False), ("already_bound", False), ("missing", True)]
)
def test_pm_catalogue_requires_available_business_user(
    portal_fixture, token_factory, monkeypatch, change, enabled
):
    client, db = portal_fixture
    if change == "inactive":
        db.get(User, "admin").is_active = False
    elif change == "already_bound":
        db.add(IAMIdentity(issuer=settings.casdoor_issuer, subject="other-sub", user_id="admin"))
    db.commit()
    complete(
        client, db, token_factory, monkeypatch, name="missing" if change == "missing" else "admin"
    )
    # 没有同名成员时首次进入会自动建；停用或同名成员已绑定其他账号时不开放
    assert app_map(client)["pm"]["enabled"] is enabled


def test_session_cookie_names_and_tables_are_isolated(portal_fixture, token_factory):
    client, db = portal_fixture
    future = int(time.time()) + 600
    db.add(
        PortalSession(
            id=security.digest("portal-only"),
            expires_at=future,
            tokens=security.seal({"access_token": token_factory()}),
        )
    )
    db.add(
        IAMSession(
            id=security.digest("pm-only"),
            expires_at=future,
            tokens=security.seal({"access_token": token_factory()}),
        )
    )
    db.add(IAMIdentity(issuer=settings.casdoor_issuer, subject="admin", user_id="admin"))
    db.commit()
    assert (
        client.get(
            "/api/v1/portal/me", headers={"Cookie": f"{security.SESSION_COOKIE}=pm-only"}
        ).status_code
        == 401
    )
    assert (
        client.get(
            "/api/v1/portal/me", headers={"Cookie": f"{PORTAL_SESSION_COOKIE}=pm-only"}
        ).status_code
        == 401
    )
    assert (
        client.get(
            "/api/v1/auth/me", headers={"Cookie": f"{PORTAL_SESSION_COOKIE}=portal-only"}
        ).status_code
        == 401
    )
    assert (
        client.get(
            "/api/v1/auth/me", headers={"Cookie": f"{security.SESSION_COOKIE}=portal-only"}
        ).status_code
        == 401
    )
    assert (
        client.get(
            "/api/v1/portal/me", headers={"Authorization": "Bearer " + token_factory()}
        ).status_code
        == 401
    )


@pytest.mark.parametrize(
    "claims,status",
    [
        ({"owner": "built-in"}, 403),
        ({"isForbidden": True}, 403),
        ({"isDeleted": True}, 403),
        ({"aud": ["other-application"]}, 401),
        ({"iss": "http://other-iam.test"}, 401),
        ({"exp": 1}, 401),
    ],
)
def test_me_rechecks_identity_and_token(portal_fixture, token_factory, claims, status):
    client, db = portal_fixture
    db.add(
        PortalSession(
            id=security.digest("session"),
            expires_at=int(time.time()) + 600,
            tokens=security.seal({"access_token": token_factory(**claims)}),
        )
    )
    db.commit()
    assert (
        client.get(
            "/api/v1/portal/me", headers={"Cookie": f"{PORTAL_SESSION_COOKIE}=session"}
        ).status_code
        == status
    )


def test_anonymous_expired_and_tampered_sessions_are_401(portal_fixture, token_factory):
    client, db = portal_fixture
    assert client.get("/api/v1/portal/me").status_code == 401
    for sid, expiry, token in [
        ("expired", 1, security.seal({"access_token": token_factory()})),
        ("tampered", int(time.time()) + 600, "invalid-ciphertext"),
    ]:
        db.add(PortalSession(id=security.digest(sid), expires_at=expiry, tokens=token))
    db.commit()
    for sid in ["expired", "tampered"]:
        assert (
            client.get(
                "/api/v1/portal/me", headers={"Cookie": f"{PORTAL_SESSION_COOKIE}={sid}"}
            ).status_code
            == 401
        )


@pytest.mark.parametrize(
    "value,expected",
    [
        ("https://evil.test", "/"),
        ("//evil.test", "/"),
        ("/\\evil.test", "/"),
        ("/workspace\x00", "/"),
        ("/workspace?tab=apps", "/workspace?tab=apps"),
    ],
)
def test_return_to_does_not_allow_external_destinations(portal_fixture, value, expected):
    client, db = portal_fixture
    _, data = begin(client, db, value)
    assert data["return_to"] == expected


def test_pkce_nonce_and_state_replay(portal_fixture, token_factory, monkeypatch):
    client, db = portal_fixture
    state, data = begin(client, db)
    exchange(monkeypatch, token_factory, data)
    assert (
        client.get("/api/v1/auth/callback", params={"code": "ok", "state": state})
        .headers["location"]
        .endswith("/workspace")
    )
    assert db.query(PortalLogin).count() == 0
    replay = client.get(
        "/api/v1/auth/callback",
        params={"code": "ok", "state": state},
        headers={"Cookie": f"{PORTAL_LOGIN_COOKIE}={state}"},
    )
    assert replay.headers["location"].endswith("/login?error=state")
    assert db.query(PortalSession).count() == 1
    state, data = begin(client, db)
    exchange(monkeypatch, token_factory, {**data, "nonce": "wrong-nonce"})
    response = client.get("/api/v1/auth/callback", params={"code": "ok", "state": state})
    assert response.headers["location"].endswith("/login?error=provider")
    assert db.query(PortalSession).count() == 1


def test_portal_callback_cannot_consume_pm_login(portal_fixture):
    client, db = portal_fixture
    state = "unrelated-state"
    db.add(
        IAMLogin(
            id=security.digest(state),
            data=security.seal({"verifier": "pm", "nonce": "pm", "return_to": "/"}),
            expires_at=int(time.time()) + 600,
        )
    )
    db.commit()
    for cookies in [f"{PORTAL_LOGIN_COOKIE}=wrong", f"{PORTAL_LOGIN_COOKIE}={state}"]:
        response = client.get(
            "/api/v1/portal/callback",
            params={"code": "ok", "state": state},
            headers={"Cookie": cookies},
        )
        assert response.headers["location"].endswith("/login?error=state")
        assert db.get(IAMLogin, security.digest(state)) is not None
    response = client.get(
        "/api/v1/auth/callback",
        params={"code": "ok", "state": state},
        headers={"Cookie": f"{PORTAL_LOGIN_COOKIE}={state}"},
    )
    assert response.headers["location"].endswith("/login?error=state")
    assert db.get(IAMLogin, security.digest(state)) is not None


@pytest.mark.parametrize("path", ["/api/v1/auth/callback", "/api/v1/portal/callback"])
def test_mismatched_unicode_state_does_not_consume_login(portal_fixture, path):
    client, db = portal_fixture
    state, _ = begin(client, db)
    response = client.get(path, params={"code": "ok", "state": "错误状态"})
    assert response.headers["location"].endswith("/login?error=state")
    assert db.get(PortalLogin, security.digest(state)) is not None


@pytest.mark.parametrize(
    "claims,error",
    [
        ({"owner": "built-in"}, "organization"),
        ({"isForbidden": True}, "organization"),
        ({"isDeleted": True}, "organization"),
        ({"aud": ["other-client"]}, "provider"),
        ({"azp": "other-client"}, "provider"),
    ],
)
def test_callback_rejects_invalid_identity(
    portal_fixture, token_factory, monkeypatch, claims, error
):
    client, db = portal_fixture
    assert (
        complete(client, db, token_factory, monkeypatch, **claims)
        .headers["location"]
        .endswith(f"/login?error={error}")
    )
    assert db.query(PortalSession).count() == 0


def test_logout_requires_origin_and_removes_local_sessions(
    portal_fixture, token_factory, monkeypatch
):
    client, db = portal_fixture
    complete(client, db, token_factory, monkeypatch)
    db.add(
        IAMSession(
            id=security.digest("pm-session"),
            expires_at=int(time.time()) + 600,
            tokens=security.seal({"access_token": token_factory()}),
        )
    )
    db.commit()
    client.cookies.set(security.SESSION_COOKIE, "pm-session", domain="pms.test", path="/")
    for origin in [None, "null", "http://evil.test", settings.pms_origin + ":9000"]:
        headers = {"Origin": origin} if origin else {}
        assert client.post("/api/v1/portal/logout", headers=headers).status_code == 403
        assert db.query(PortalSession).count() == 1
        assert db.query(IAMSession).count() == 1
    response = client.post("/api/v1/portal/logout", headers={"Origin": settings.pms_origin})
    assert response.status_code == 303
    target = urlparse(response.headers["location"])
    assert f"{target.scheme}://{target.netloc}" == settings.casdoor_issuer
    assert parse_qs(target.query)["post_logout_redirect_uri"] == [settings.pms_origin + "/login"]
    assert db.query(PortalSession).count() == 0
    assert db.query(IAMSession).count() == 0
    assert client.get("/api/v1/portal/me").status_code == 401


def test_login_requires_secret_and_key(portal_fixture, monkeypatch):
    client, _ = portal_fixture
    monkeypatch.setattr(settings, "CASDOOR_CLIENT_SECRET", "")
    assert client.get("/api/v1/portal/login").status_code == 503
    monkeypatch.setattr(settings, "CASDOOR_CLIENT_SECRET", "configured")
    monkeypatch.setattr(settings, "APP_SECRET", "change-me")
    assert client.get("/api/v1/portal/login").status_code == 503


def test_pm_logout_also_clears_current_portal_session(portal_fixture, token_factory, monkeypatch):
    client, db = portal_fixture
    complete(client, db, token_factory, monkeypatch)
    state, _ = begin(client, db)
    db.add(
        PortalSession(
            id=security.digest("another-browser"),
            expires_at=int(time.time()) + 600,
            tokens=security.seal({"access_token": token_factory()}),
        )
    )
    db.commit()
    response = client.post("/api/v1/auth/logout", headers={"Origin": settings.pms_origin})
    assert response.status_code == 303
    assert client.get("/api/v1/portal/me").status_code == 401
    assert db.get(PortalLogin, security.digest(state)) is None
    assert db.query(PortalSession).count() == 1
    assert db.get(PortalSession, security.digest("another-browser")) is not None


@pytest.fixture
def independent_portal(portal_fixture, monkeypatch):
    _, db = portal_fixture
    monkeypatch.setattr(settings, "PMS_PUBLIC_URL", "https://pm.openlims.ai")
    monkeypatch.setattr(settings, "PORTAL_PUBLIC_URL", "https://www.openlims.ai")
    monkeypatch.setattr(settings, "PORTAL_CLIENT_ID", "portal-test")
    monkeypatch.setattr(settings, "PORTAL_CLIENT_SECRET", "portal-test-secret")
    monkeypatch.setattr(settings, "IAM_COOKIE_SECURE", True)
    with TestClient(app, base_url=settings.portal_origin, follow_redirects=False) as client:
        yield client, db


def test_independent_domain_callback_and_host_only_secure_cookie(
    independent_portal, token_factory, monkeypatch
):
    client, db = independent_portal
    config = client.get("/api/v1/portal/config").json()
    assert config["login_url"] == "https://www.openlims.ai/api/v1/portal/login"
    state, data = begin(client, db, "/account")
    exchange(monkeypatch, token_factory, data, roles=roles("admin", "kb_viewer"))
    response = client.get("/api/v1/portal/callback", params={"state": state, "code": "ok"})
    assert response.headers["location"] == "https://www.openlims.ai/account"
    cookie = response.headers["set-cookie"]
    assert "Secure" in cookie and "HttpOnly" in cookie and "SameSite=lax" in cookie
    assert "Domain=" not in cookie
    assert app_map(client)["pm"]["enabled"] is True
    assert app_map(client)["kb"]["enabled"] is True
    assert client.get("https://pm.openlims.ai/api/v1/portal/me").status_code == 401
    assert client.get("/api/v1/auth/me").status_code == 401


def test_pm_callback_cannot_consume_independent_portal_state(independent_portal):
    client, db = independent_portal
    state, _ = begin(client, db)
    response = client.get("/api/v1/auth/callback", params={"state": state, "code": "ok"})
    assert response.headers["location"] == "https://pm.openlims.ai/login?error=state"
    assert db.get(PortalLogin, security.digest(state)) is not None


@pytest.mark.parametrize("field,value", [
    ("PORTAL_CLIENT_ID", ""),
    ("PORTAL_CLIENT_SECRET", ""),
    ("PORTAL_CLIENT_ID", "pms-test"),
])
def test_independent_domain_requires_distinct_complete_client(
    independent_portal, monkeypatch, field, value
):
    client, db = independent_portal
    monkeypatch.setattr(settings, field, value)
    assert client.get("/api/v1/portal/login").status_code == 503
    assert client.get("/api/v1/portal/me").status_code == 503
    assert db.query(PortalLogin).count() == 0


def test_pm_audience_cannot_establish_portal_session(independent_portal, token_factory, monkeypatch):
    client, db = independent_portal
    response = complete(client, db, token_factory, monkeypatch, aud=[settings.CASDOOR_CLIENT_ID])
    assert response.headers["location"] == "https://www.openlims.ai/login?error=provider"
    assert db.query(PortalSession).count() == 0


def test_audiences_cannot_cross_session_or_bearer_boundary(independent_portal, token_factory):
    client, db = independent_portal
    db.add(IAMIdentity(issuer=settings.casdoor_issuer, subject="admin", user_id="admin"))
    for model, session_id, audience in [
        (PortalSession, "wrong-portal-audience", settings.CASDOOR_CLIENT_ID),
        (IAMSession, "wrong-pm-audience", settings.portal_client_id),
    ]:
        db.add(model(id=security.digest(session_id), expires_at=int(time.time()) + 600,
                     tokens=security.seal({"access_token": token_factory(aud=[audience])})))
    db.commit()
    assert client.get("/api/v1/portal/me", headers={"Cookie": f"{PORTAL_SESSION_COOKIE}=wrong-portal-audience"}).status_code == 401
    assert client.get("/api/v1/auth/me", headers={"Cookie": f"{security.SESSION_COOKIE}=wrong-pm-audience"}).status_code == 401
    assert client.get("/api/v1/projects", headers={"Authorization": "Bearer " + token_factory(aud=[settings.portal_client_id])}).status_code == 401


def test_independent_logout_origin_and_pm_session_retained(independent_portal, token_factory, monkeypatch):
    client, db = independent_portal
    complete(client, db, token_factory, monkeypatch)
    db.add(IAMSession(id=security.digest("pm-other-domain"), expires_at=int(time.time()) + 600,
                      tokens=security.seal({"access_token": token_factory()})))
    db.commit()
    client.cookies.set(security.SESSION_COOKIE, "pm-other-domain", domain="pm.openlims.ai", path="/")
    assert client.post("/api/v1/portal/logout", headers={"Origin": settings.pms_origin}).status_code == 403
    assert db.query(PortalSession).count() == 1
    response = client.post("/api/v1/portal/logout", headers={"Origin": settings.portal_origin})
    assert response.status_code == 303
    params = parse_qs(urlparse(response.headers["location"]).query)
    assert params["client_id"] == ["portal-test"]
    assert params["post_logout_redirect_uri"] == ["https://www.openlims.ai/login"]
    assert db.query(PortalSession).count() == 0
    assert db.get(IAMSession, security.digest("pm-other-domain")) is not None
    assert client.get("/api/v1/portal/me").status_code == 401


def test_portal_uses_its_configured_jwks(independent_portal, token_factory, monkeypatch, signing_pair):
    client, db = independent_portal
    portal_jwks = "http://iam.test/api/certs/portal-certificate"
    monkeypatch.setattr(settings, "PORTAL_JWKS_URL", portal_jwks)
    security._jwks_cache.clear()
    security._jwks_cache[portal_jwks] = (time.monotonic(), [signing_pair[1]])
    response = complete(client, db, token_factory, monkeypatch)
    assert response.headers["location"].endswith("/workspace")
    assert client.get("/api/v1/portal/me").status_code == 200


def test_mdm_launch_requires_portal_session(portal_fixture, token_factory, monkeypatch):
    client, db = portal_fixture
    monkeypatch.setattr(settings, "MDM_PUBLIC_URL", "")
    assert client.get("/api/v1/portal/applications/mdm/launch").status_code == 401
    complete(client, db, token_factory, monkeypatch)
    assert app_map(client)["mdm"]["enabled"] is False
    assert client.get("/api/v1/portal/applications/mdm/launch").status_code == 503
    monkeypatch.setattr(settings, "MDM_PUBLIC_URL", "http://localhost:5188/mdm/")
    assert app_map(client)["mdm"]["enabled"] is True
    response = client.get("/api/v1/portal/applications/mdm/launch", params={"return_to": "https://evil.test?token=evil"})
    assert response.status_code == 200
    assert response.json() == {"url": "http://localhost:5188/mdm/projects"}
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["referrer-policy"] == "no-referrer"
    assert db.query(IAMIdentity).count() == 0
