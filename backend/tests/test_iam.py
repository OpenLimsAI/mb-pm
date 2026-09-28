"""IAM 全链路：真实 RSA 签名、授权码 + PKCE 回调、cookie 会话、CSRF、登出与重放，不访问外部 IAM。"""

import time
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from fastapi.testclient import TestClient
from jose import jwt
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.core import security
from app.core.config import settings
from app.db.session import get_db
from app.main import app
from app.models import IAMIdentity, IAMLogin, IAMSession, User


@pytest.fixture
def fixture(token_factory):
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    for model in [User, IAMIdentity, IAMSession, IAMLogin]:
        model.__table__.create(engine)
    db = Session(engine)
    for role in security.ROLES:
        # 本地 users.role 故意全写 admin：授权必须以 IAM 角色为准。
        db.add(
            User(
                id=role, username=role, display_name=role, email=f"{role}@example.com", role="admin"
            )
        )
    db.commit()
    for role in security.ROLES:
        db.add(IAMIdentity(issuer=settings.casdoor_issuer, subject=role, user_id=role))
    db.commit()
    app.dependency_overrides[get_db] = lambda: db
    with TestClient(app, base_url=settings.pms_origin, follow_redirects=False) as client:
        yield client, db
    app.dependency_overrides.pop(get_db, None)
    db.close()
    engine.dispose()


def auth(token):
    return {"Authorization": f"Bearer {token}"}


@pytest.mark.parametrize("role", sorted(security.ROLES))
def test_role_comes_from_verified_iam_not_local_database(fixture, token_factory, role):
    client, _ = fixture
    response = client.get("/api/v1/auth/me", headers=auth(token_factory(role)))
    assert response.status_code == 200
    assert response.json()["role"] == role
    assert response.json()["id"] == role


@pytest.mark.parametrize(
    "change",
    [
        {"iss": "http://attacker.test"},
        {"aud": ["other-app"]},
        {"exp": 1},
        {"sub": ""},
    ],
)
def test_bad_claims_rejected(fixture, token_factory, change):
    client, _ = fixture
    assert client.get("/api/v1/auth/me", headers=auth(token_factory(**change))).status_code == 401


def test_no_demo_or_local_jwt_bypass(fixture):
    client, _ = fixture
    for header in [
        "DemoUser admin",
        "Bearer garbage",
        "Bearer " + jwt.encode({"sub": "admin"}, settings.APP_SECRET, algorithm="HS256"),
    ]:
        assert client.get("/api/v1/auth/me", headers={"Authorization": header}).status_code == 401
    # 旧的「仅用户名」登录已移除
    assert client.post("/api/v1/auth/login", json={"username": "admin"}).status_code == 405
    assert client.get("/api/v1/auth/me").status_code == 401


@pytest.mark.parametrize(
    "change",
    [
        {"owner": "built-in"},
        {"roles": []},
        {"roles": ["admin"]},
        {"roles": [{"owner": "elsewhere", "name": "admin"}]},
        {"isForbidden": True},
        {"roles": [{"owner": "mabpharm", "name": "admin"}, {"owner": "mabpharm", "name": "rd"}]},
        {"roles": [{"owner": "mabpharm", "name": "admin", "isEnabled": False}]},
    ],
)
def test_wrong_org_or_role_rejected(fixture, token_factory, change):
    client, _ = fixture
    assert client.get("/api/v1/auth/me", headers=auth(token_factory(**change))).status_code == 403


def test_inactive_user_cannot_sign_in(fixture, token_factory):
    client, db = fixture
    db.get(User, "admin").is_active = False
    db.commit()
    assert client.get("/api/v1/auth/me", headers=auth(token_factory())).status_code == 403


def begin_login(client, db, return_to="https://evil.test"):
    response = client.get("/api/v1/auth/login", params={"return_to": return_to})
    assert response.status_code == 303
    location = urlparse(response.headers["location"])
    assert f"{location.scheme}://{location.netloc}" == settings.casdoor_issuer
    query = parse_qs(location.query)
    assert query["code_challenge_method"] == ["S256"]
    assert query["redirect_uri"] == [settings.pms_origin + "/api/v1/auth/callback"]
    assert "client_secret" not in query
    state = query["state"][0]
    data = security.unseal(db.get(IAMLogin, security.digest(state)).data)
    return state, data


@pytest.mark.parametrize(
    "return_to, expected",
    [
        ("https://evil.test", "/"),
        ("//evil.test/path", "/"),
        ("/\\evil.test", "/"),
        ("/projects\x00", "/"),
        ("/projects/p1?tab=wbs", "/projects/p1?tab=wbs"),
    ],
)
def test_return_to_is_limited_to_local_paths(fixture, return_to, expected):
    client, db = fixture
    _, data = begin_login(client, db, return_to)
    assert data["return_to"] == expected


def exchange(monkeypatch, token_factory, nonce, **overrides):
    def post(url, **kwargs):
        assert url == settings.casdoor_token_url
        assert kwargs["data"]["client_secret"] == settings.CASDOOR_CLIENT_SECRET
        assert len(kwargs["data"]["code_verifier"]) >= 43
        return httpx.Response(
            200,
            request=httpx.Request("POST", url),
            json={
                "access_token": token_factory(**overrides),
                "id_token": token_factory(nonce=nonce, **overrides),
            },
        )

    monkeypatch.setattr(httpx, "post", post)


def test_pkce_callback_session_csrf_logout_replay(fixture, token_factory, monkeypatch):
    client, db = fixture
    state, data = begin_login(client, db, "/projects")
    exchange(monkeypatch, token_factory, data["nonce"])
    response = client.get("/api/v1/auth/callback", params={"state": state, "code": "valid-code"})
    assert response.status_code == 303
    assert response.headers["location"] == settings.pms_origin + "/projects"
    assert "HttpOnly" in response.headers["set-cookie"]
    assert client.get("/api/v1/auth/me").status_code == 200
    # cookie 会话下的写操作必须带可信 Origin（CSRF 防护）
    assert (
        client.delete(
            "/api/v1/projects/irrelevant", headers={"Origin": "http://evil.test"}
        ).status_code
        == 403
    )
    assert client.post("/api/v1/auth/logout").status_code == 403
    response = client.post("/api/v1/auth/logout", headers={"Origin": settings.pms_origin})
    assert response.status_code == 303
    location = response.headers["location"]
    assert location.startswith(settings.casdoor_issuer + "/api/logout?")
    assert parse_qs(urlparse(location).query)["post_logout_redirect_uri"] == [
        settings.pms_origin + "/login"
    ]
    assert client.get("/api/v1/auth/me").status_code == 401
    assert db.query(IAMSession).count() == 0
    # 重放：即使带上原 state cookie，state 已被原子消费
    replay = client.get(
        "/api/v1/auth/callback",
        params={"state": state, "code": "valid-code"},
        headers={"Cookie": f"{security.LOGIN_COOKIE}={state}"},
    )
    assert replay.headers["location"] == settings.pms_origin + "/login?error=state"


@pytest.mark.parametrize("failure", ["nonce", "state", "expired"])
def test_callback_rejects_bad_state_and_nonce(fixture, token_factory, monkeypatch, failure):
    client, db = fixture
    state, data = begin_login(client, db)
    exchange(monkeypatch, token_factory, "wrong" if failure == "nonce" else data["nonce"])
    if failure == "expired":
        db.get(IAMLogin, security.digest(state)).expires_at = 1
        db.commit()
    response = client.get(
        "/api/v1/auth/callback",
        params={"state": "wrong" if failure == "state" else state, "code": "valid-code"},
    )
    assert response.headers["location"].startswith(settings.pms_origin + "/login?error=")
    assert db.query(IAMSession).count() == 0


def test_first_login_binds_existing_id_and_blocks_username_takeover(
    fixture, token_factory, monkeypatch
):
    client, db = fixture
    db.delete(db.get(IAMIdentity, (settings.casdoor_issuer, "admin")))
    db.commit()
    state, data = begin_login(client, db)
    exchange(monkeypatch, token_factory, data["nonce"], sub="new-subject")
    location = client.get("/api/v1/auth/callback", params={"state": state, "code": "ok"}).headers[
        "location"
    ]
    assert "error=" not in location
    assert db.get(IAMIdentity, (settings.casdoor_issuer, "new-subject")).user_id == "admin"
    # 同名的另一个 IAM 账号（不同 sub）不能再接管已绑定的业务账号
    state, data = begin_login(client, db)
    exchange(monkeypatch, token_factory, data["nonce"], sub="impostor-subject")
    location = client.get("/api/v1/auth/callback", params={"state": state, "code": "ok"}).headers[
        "location"
    ]
    assert location.endswith("/login?error=role")


def test_unprovisioned_iam_account_cannot_sign_in(fixture, token_factory, monkeypatch):
    client, db = fixture
    state, data = begin_login(client, db)
    exchange(monkeypatch, token_factory, data["nonce"], sub="stranger", name="stranger")
    location = client.get("/api/v1/auth/callback", params={"state": state, "code": "ok"}).headers[
        "location"
    ]
    assert location.endswith("/login?error=role")
    assert db.query(IAMSession).count() == 0


def test_sessions_expire_and_are_checked_via_cookie(fixture, token_factory):
    client, db = fixture
    for sid, expires_at in [("live-session", int(time.time()) + 600), ("expired-session", 1)]:
        db.add(
            IAMSession(
                id=security.digest(sid),
                expires_at=expires_at,
                tokens=security.seal({"access_token": token_factory()}),
            )
        )
    db.commit()
    cookie = f"{security.SESSION_COOKIE}="
    assert (
        client.get("/api/v1/auth/me", headers={"Cookie": cookie + "live-session"}).json()["role"]
        == "admin"
    )
    assert (
        client.get("/api/v1/auth/me", headers={"Cookie": cookie + "expired-session"}).status_code
        == 401
    )


def test_tampered_signature_and_missing_expiry(fixture, token_factory, signing_pair):
    client, _ = fixture
    good = token_factory()
    header, payload, signature = good.split(".")
    signature = ("a" if signature[0] != "a" else "b") + signature[1:]
    assert (
        client.get(
            "/api/v1/auth/me", headers=auth(".".join([header, payload, signature]))
        ).status_code
        == 401
    )
    claims = jwt.get_unverified_claims(good)
    del claims["exp"]
    missing = jwt.encode(claims, signing_pair[0], algorithm="RS256", headers={"kid": "test-key"})
    assert client.get("/api/v1/auth/me", headers=auth(missing)).status_code == 401


def test_jwks_rotation_and_outage(fixture, token_factory, signing_pair, monkeypatch):
    client, _ = fixture
    token = token_factory()
    security._jwks_cache[settings.casdoor_jwks_url] = (time.monotonic() - 31, [])
    monkeypatch.setattr(
        httpx,
        "get",
        lambda url, **kwargs: httpx.Response(
            200, request=httpx.Request("GET", url), json={"keys": [signing_pair[1]]}
        ),
    )
    assert client.get("/api/v1/auth/me", headers=auth(token)).status_code == 200
    security._jwks_cache.clear()

    def unavailable(*args, **kwargs):
        raise httpx.ConnectError("IAM unavailable")

    monkeypatch.setattr(httpx, "get", unavailable)
    assert client.get("/api/v1/auth/me", headers=auth(token)).status_code == 503


def test_internal_url_used_only_for_server_to_server_calls(
    fixture, token_factory, signing_pair, monkeypatch
):
    """容器 / 内网部署：浏览器走公开地址，后端换 token、拉 JWKS 走内部地址；issuer 仍校验公开地址。"""
    client, db = fixture
    monkeypatch.setattr(settings, "CASDOOR_INTERNAL_URL", "http://casdoor:8000")
    fetched = []

    def get(url, **kwargs):
        fetched.append(url)
        return httpx.Response(
            200, request=httpx.Request("GET", url), json={"keys": [signing_pair[1]]}
        )

    monkeypatch.setattr(httpx, "get", get)
    state, data = begin_login(client, db)  # 授权跳转仍指向公开地址（begin_login 内断言）
    exchange(monkeypatch, token_factory, data["nonce"])  # 断言换 token 走 casdoor_token_url
    assert settings.casdoor_token_url == "http://casdoor:8000/api/login/oauth/access_token"
    location = client.get("/api/v1/auth/callback", params={"state": state, "code": "ok"}).headers[
        "location"
    ]
    assert "error=" not in location
    assert fetched == ["http://casdoor:8000/.well-known/jwks"]


def test_login_requires_configured_client_and_session_key(fixture, monkeypatch):
    client, _ = fixture
    monkeypatch.setattr(settings, "APP_SECRET", "change-me")
    assert client.get("/api/v1/auth/login").status_code == 503
    monkeypatch.setattr(settings, "CASDOOR_CLIENT_SECRET", "")
    assert client.get("/api/v1/auth/login").status_code == 503


def test_login_syncs_username_changed_in_iam(fixture, token_factory, monkeypatch):
    """IAM 控制台里改过用户名：按 sub 仍是同一业务用户，登录时同步用户名；与他人冲突则不改。"""
    client, db = fixture
    for name, expected in [("admin.renamed", "admin.renamed"), ("rd", "admin.renamed")]:
        state, data = begin_login(client, db)
        exchange(monkeypatch, token_factory, data["nonce"], name=name)
        location = client.get(
            "/api/v1/auth/callback", params={"state": state, "code": "ok"}
        ).headers["location"]
        assert "error=" not in location
        db.expire_all()
        assert db.get(User, "admin").username == expected
    assert db.get(User, "rd").username == "rd"
