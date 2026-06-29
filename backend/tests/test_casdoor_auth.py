"""Casdoor JWKS 验签 + 角色提取单测（自签 RSA，不依赖在跑的 Casdoor）。"""
import json
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives import serialization
from jose import jwt, jwk

from app.core import casdoor
from app.core.config import settings


@pytest.fixture(autouse=True)
def reset_jwks_cache():
    """每个测试前清空模块级 JWKS 缓存，防止测试间状态污染。"""
    casdoor._jwks_cache = None
    yield
    casdoor._jwks_cache = None

_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_KID = "test-kid-1"


def _private_pem() -> str:
    return _KEY.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()


def _jwks() -> dict:
    pub_pem = _KEY.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
    ).decode()
    k = jwk.construct(pub_pem, "RS256").to_dict()
    k["kid"] = _KID
    return {"keys": [k]}


def _make_token(claims: dict) -> str:
    headers = {"kid": _KID}
    return jwt.encode(claims, _private_pem(), algorithm="RS256", headers=headers)


def test_verify_valid_token(monkeypatch):
    monkeypatch.setattr(casdoor, "_fetch_jwks", lambda: _jwks())
    token = _make_token({
        "sub": "u-guo",
        "name": "guo.cmc",
        "preferred_username": "guo.cmc",
        "aud": settings.CASDOOR_CLIENT_ID,
        "iss": settings.CASDOOR_ENDPOINT,
        "roles": [{"owner": "mabpharm", "name": "cmc_lead"}],
    })
    claims = casdoor.verify_casdoor_token(token)
    assert claims["preferred_username"] == "guo.cmc"
    assert casdoor.extract_role(claims) == "cmc_lead"


def test_reject_bad_signature(monkeypatch):
    other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    other_pem = other.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    ).decode()
    monkeypatch.setattr(casdoor, "_fetch_jwks", lambda: _jwks())
    bad = jwt.encode({"sub": "x", "aud": settings.CASDOOR_CLIENT_ID, "iss": settings.CASDOOR_ENDPOINT},
                     other_pem, algorithm="RS256", headers={"kid": _KID})
    try:
        casdoor.verify_casdoor_token(bad)
        assert False, "应当因签名不匹配而抛错"
    except ValueError:
        pass


def test_extract_role_variants():
    assert casdoor.extract_role({"roles": [{"name": "qa_qc"}]}) == "qa_qc"
    assert casdoor.extract_role({"roles": ["rd"]}) == "rd"
    assert casdoor.extract_role({"role": "admin"}) == "admin"
    assert casdoor.extract_role({"roles": []}) is None
    # unknown role strings must return None
    assert casdoor.extract_role({"role": "superadmin"}) is None
    assert casdoor.extract_role({"roles": [{"name": "nope"}]}) is None


def test_reject_malformed_token(monkeypatch):
    monkeypatch.setattr(casdoor, "_fetch_jwks", lambda: {"keys": []})
    with pytest.raises(ValueError):
        casdoor.verify_casdoor_token("garbage")


def test_demouser_rejected_in_production(client, admin_user, monkeypatch):
    """DemoUser auth must return 401 outside development environment."""
    monkeypatch.setattr(settings, "APP_ENV", "production")
    resp = client.get("/api/v1/auth/me", headers={"Authorization": f"DemoUser {admin_user}"})
    assert resp.status_code == 401
