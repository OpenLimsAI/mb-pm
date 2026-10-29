"""IAM uses verified stable subjects; self-signup never claims existing business users."""

import time
from urllib.parse import parse_qs, urlparse
from uuid import uuid4

import httpx
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import HTTPException
from jose import jwt

from app.core import iam
from app.core.config import settings
from app.db.session import SessionLocal
from app.models import IAMIdentity, IAMLogin, User


@pytest.fixture
def identity_client(client, monkeypatch):
    monkeypatch.setattr(settings, "IAM_ENABLED", True)
    monkeypatch.setattr(
        settings, "APP_SECRET", "test-iam-session-secret-never-used-in-production-12345"
    )
    monkeypatch.setattr(settings, "CASDOOR_CLIENT_ID", "test-lite-client")
    monkeypatch.setattr(settings, "CASDOOR_CLIENT_SECRET", "test-client-secret")
    private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private_pem = private.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    )
    public_pem = private.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    monkeypatch.setattr(iam, "signing_key", lambda kid: public_pem)
    suffix = uuid4().hex[:10]
    base = {
        "iss": settings.CASDOOR_ENDPOINT,
        "aud": [settings.CASDOOR_CLIENT_ID],
        "exp": int(time.time()) + 3600,
        "sub": "subject-" + suffix,
        "owner": settings.CASDOOR_ORGANIZATION,
        "name": "member-" + suffix,
        "email": suffix + "@example.com",
        "displayName": "注册测试用户",
        "roles": [],
    }

    def sign(**changes):
        return jwt.encode(
            {**base, **changes}, private_pem, algorithm="RS256", headers={"kid": "test"}
        )

    yield client, base, sign
    client.cookies.clear()


def test_signup_provisions_lowest_role_and_rename_keeps_identity(identity_client):
    client, claims, sign = identity_client
    with SessionLocal() as db:
        user = iam.resolve_identity(claims, db, bind=True)
        db.commit()
        uid = user.id
        assert user.role == "rd" and not user.hashed_password
        renamed = {**claims, "name": claims["name"] + "-new"}
        assert iam.resolve_identity(renamed, db, bind=True).id == uid
        db.commit()
        assert db.get(User, uid).username == renamed["name"]
        assert db.get(IAMIdentity, (settings.CASDOOR_ENDPOINT, claims["sub"])).user_id == uid
    headers = {"Authorization": "Bearer " + sign()}
    assert client.get("/api/v1/auth/me", headers=headers).json()["role"] == "rd"
    assert client.get("/api/v1/ai/settings", headers=headers).status_code == 403
    assert client.post("/api/v1/projects", json={}, headers=headers).status_code == 403
    assert [u["id"] for u in client.get("/api/v1/users", headers=headers).json()] == [uid]
    assert client.get("/api/v1/projects", headers=headers).json()["items"] == []


def test_public_signup_cannot_take_existing_admin(identity_client):
    _, claims, _ = identity_client
    with SessionLocal() as db:
        name = "reserved-" + uuid4().hex[:8]
        db.add(
            User(
                id=uuid4().hex[:18],
                username=name,
                display_name="Existing",
                email=name + "@example.com",
                role="admin",
                is_active=True,
            )
        )
        db.commit()
        with pytest.raises(HTTPException, match="403"):
            iam.resolve_identity({**claims, "name": name}, db, bind=True)


def test_existing_guo_identity_and_password_are_preserved(identity_client):
    _, claims, _ = identity_client
    with SessionLocal() as db:
        user = db.query(User).filter_by(username="guo.cmc").first()
        if not user:
            user = User(
                id="iam-legacy-guo",
                username="guo.cmc",
                display_name="郭主任",
                email="guo-iam-test@example.com",
                role="cmc_lead",
                is_active=True,
                hashed_password="existing-hash-untouched",
            )
            db.add(user)
            db.commit()
        uid, password = user.id, user.hashed_password
        legacy = {
            **claims,
            "name": "guo.cmc",
            "roles": [{"owner": settings.CASDOOR_ORGANIZATION, "name": "cmc_lead"}],
        }
        assert iam.resolve_identity(legacy, db, bind=True).id == uid
        db.commit()
        assert db.get(User, uid).hashed_password == password


@pytest.mark.parametrize(
    "change", [{"iss": "https://evil.example"}, {"aud": ["other-client"]}, {"exp": 1}, {"sub": ""}]
)
def test_bad_signed_claims_rejected(identity_client, change):
    client, _, sign = identity_client
    assert (
        client.get(
            "/api/v1/auth/me", headers={"Authorization": "Bearer " + sign(**change)}
        ).status_code
        == 401
    )


def test_demo_and_hs256_tokens_rejected_when_iam_enabled(identity_client):
    client, _, _ = identity_client
    for token in [
        "DemoUser t-admin",
        "Bearer " + jwt.encode({"sub": "t-admin"}, settings.APP_SECRET, algorithm="HS256"),
    ]:
        assert client.get("/api/v1/auth/me", headers={"Authorization": token}).status_code == 401
    assert client.post("/api/v1/auth/login", json={"username": "guo.cmc"}).status_code == 410


def test_oauth_callback_cookie_csrf_replay_and_new_user(identity_client, monkeypatch):
    client, _, sign = identity_client
    response = client.get(
        "/api/v1/auth/login", params={"return_to": "//evil.example"}, follow_redirects=False
    )
    assert response.status_code == 303
    args = parse_qs(urlparse(response.headers["location"]).query)
    assert args["code_challenge_method"] == ["S256"] and "client_secret" not in args
    state = args["state"][0]
    with SessionLocal() as db:
        saved = iam.unseal(db.get(IAMLogin, iam.digest(state)).data)
    assert saved["return_to"] == "/projects"

    def exchange(url, **kwargs):
        assert kwargs["data"]["code_verifier"] == saved["verifier"]
        return httpx.Response(
            200,
            request=httpx.Request("POST", url),
            json={"access_token": sign(), "id_token": sign(nonce=saved["nonce"])},
        )

    monkeypatch.setattr(httpx, "post", exchange)
    response = client.get(
        "/api/v1/auth/callback", params={"state": state, "code": "valid"}, follow_redirects=False
    )
    assert response.status_code == 303 and response.headers["location"].endswith("/projects")
    assert "HttpOnly" in response.headers["set-cookie"]
    assert client.get("/api/v1/auth/me").status_code == 200
    assert (
        client.post(
            "/api/v1/auth/logout", headers={"Origin": "http://evil.example"}, follow_redirects=False
        ).status_code
        == 403
    )
    replay = client.get(
        "/api/v1/auth/callback", params={"state": state, "code": "valid"}, follow_redirects=False
    )
    assert "error=state" in replay.headers["location"]
    response = client.post(
        "/api/v1/auth/logout", headers={"Origin": settings.PMS_PUBLIC_URL}, follow_redirects=False
    )
    assert response.status_code == 303
    assert client.get("/api/v1/auth/me").status_code == 401
