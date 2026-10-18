"""嵌入式登录的开始步骤：要求本站 Origin、照常保存登录事务与 state cookie，返回带授权参数的 IAM 登录接口地址；
随后用 IAM 返回的授权码走原有回调完成登录。IAM 不可用时返回 503（登录页回退为跳转 IAM 登录页）。"""

import base64
import hashlib
from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from app.api.v1.portal import PORTAL_LOGIN_COOKIE, PORTAL_SESSION_COOKIE
from app.core import security
from app.core.config import settings
from app.core.security import LOGIN_COOKIE
from app.models import IAMLogin, PortalLogin
from app.services import iam_login
from tests.test_portal import exchange, portal_fixture, roles  # noqa: F401


@pytest.fixture(autouse=True)
def iam_application(monkeypatch):
    """IAM 公开接口 get-app-login 的替身：按客户端返回应用名与组织。"""
    iam_login._app_cache.clear()
    calls = []

    def get(url, params=None, **kwargs):
        calls.append(params)
        assert url == f"{settings.casdoor_internal_url}/api/get-app-login"
        return httpx.Response(
            200,
            request=httpx.Request("GET", url),
            json={"status": "ok", "data": {"name": "mb-app", "organization": "mabpharm"}},
        )

    monkeypatch.setattr(httpx, "get", get)
    yield calls
    iam_login._app_cache.clear()


def challenge_of(verifier: str) -> str:
    return base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")


def test_portal_start_returns_iam_login_api_and_keeps_pkce_server_side(
    portal_fixture, iam_application
):
    client, db = portal_fixture
    # 登录页据此检查已有的 IAM 登录会话（单点登录）
    for path in ("/api/v1/portal/config", "/api/v1/auth/config"):
        assert (
            client.get(path).json()["iam_session_url"]
            == settings.casdoor_issuer + "/api/get-account"
        )
    url = "/api/v1/portal/login/start"
    assert client.post(url, json={"return_to": "/settings"}).status_code == 403  # 须本站 Origin
    foreign = {"Origin": "https://evil.example"}
    assert client.post(url, json={"return_to": "/settings"}, headers=foreign).status_code == 403

    response = client.post(
        url, json={"return_to": "/settings"}, headers={"Origin": settings.portal_origin}
    )
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert body["application"] == "mb-app" and body["organization"] == "mabpharm"
    assert body["callback_url"] == settings.portal_callback_url
    login_api = urlparse(body["login_api"])
    assert (
        f"{login_api.scheme}://{login_api.netloc}{login_api.path}"
        == settings.casdoor_issuer + "/api/login"
    )
    query = {k: v[0] for k, v in parse_qs(login_api.query).items()}
    assert query["clientId"] == settings.portal_client_id and query["type"] == "code"
    assert query["redirectUri"] == settings.portal_callback_url
    assert query["state"] == body["state"] and query["code_challenge_method"] == "S256"
    assert "client_secret" not in body["login_api"] and "verifier" not in response.text

    state = body["state"]
    assert response.cookies.get(PORTAL_LOGIN_COOKIE) == state
    data = security.unseal(db.get(PortalLogin, security.digest(state)).data)
    assert query["code_challenge"] == challenge_of(data["verifier"])
    assert query["nonce"] == data["nonce"] and data["return_to"] == "/settings"
    # 应用信息缓存：第二次开始登录不再查询 IAM
    client.post(url, json={}, headers={"Origin": settings.portal_origin})
    assert len(iam_application) == 1


def test_portal_code_from_iam_completes_login_through_existing_callback(
    portal_fixture, token_factory, monkeypatch
):
    client, db = portal_fixture
    body = client.post(
        "/api/v1/portal/login/start",
        json={"return_to": "/settings"},
        headers={"Origin": settings.portal_origin},
    ).json()
    data = security.unseal(db.get(PortalLogin, security.digest(body["state"])).data)
    exchange(monkeypatch, token_factory, data, roles=roles("kb_editor"))
    callback = urlparse(body["callback_url"]).path
    response = client.get(callback, params={"code": "code-from-iam", "state": body["state"]})
    assert response.status_code == 303
    assert response.headers["location"] == settings.portal_origin + "/settings"
    assert PORTAL_SESSION_COOKIE in response.headers["set-cookie"]
    assert client.get("/api/v1/portal/me").status_code == 200


def test_pm_start_uses_pm_client_and_state_cookie(portal_fixture):
    client, db = portal_fixture
    url = "/api/v1/auth/login/start"
    assert client.post(url, json={"return_to": "/projects"}).status_code == 403
    response = client.post(
        url, json={"return_to": "/projects"}, headers={"Origin": settings.pms_origin}
    )
    assert response.status_code == 200, response.text
    body = response.json()
    query = {k: v[0] for k, v in parse_qs(urlparse(body["login_api"]).query).items()}
    assert query["clientId"] == settings.CASDOOR_CLIENT_ID
    assert body["callback_url"] == settings.iam_callback_url
    assert response.cookies.get(LOGIN_COOKIE) == body["state"]
    data = security.unseal(db.get(IAMLogin, security.digest(body["state"])).data)
    assert (
        query["code_challenge"] == challenge_of(data["verifier"])
        and data["return_to"] == "/projects"
    )
    # 站外返回地址一律回首页
    unsafe = client.post(
        url, json={"return_to": "//evil.example"}, headers={"Origin": settings.pms_origin}
    )
    data = security.unseal(db.get(IAMLogin, security.digest(unsafe.json()["state"])).data)
    assert data["return_to"] == "/"


def test_start_reports_unreachable_iam(portal_fixture, monkeypatch):
    client, db = portal_fixture

    def down(*args, **kwargs):
        raise httpx.ConnectError("down")

    monkeypatch.setattr(httpx, "get", down)
    response = client.post(
        "/api/v1/portal/login/start",
        json={"return_to": "/"},
        headers={"Origin": settings.portal_origin},
    )
    assert response.status_code == 503 and "统一身份服务" in response.json()["detail"]
