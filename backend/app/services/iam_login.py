"""嵌入式登录：用户名 / 密码直接在门户（及项目管理）登录页输入，不再跳到 IAM 的登录页面。

流程与原来的授权码流程相同，只是 IAM 的登录表单换成了本系统的：
1. 登录页调用 POST /portal/login/start（或 /auth/login/start）：后端照常生成 state / PKCE / nonce、
   保存登录事务并写 state cookie，返回 IAM 登录接口地址（已带上授权参数）与应用、组织名；
2. 浏览器把用户名和密码直接提交到 IAM 的 /api/login（type=code），IAM 校验后返回一次性授权码，
   并照常写入 IAM 自己的登录会话（应用开启「启用登录会话」时），之后进入项目管理 / 知识库仍是单点登录；
3. 浏览器带授权码和 state 打开原有回调，后端用 PKCE 换取令牌、建立会话。

密码只在浏览器与 IAM 之间传递，不经过本系统后端。IAM 须允许本系统的 Origin 跨域携带凭据访问 /api/login
（Casdoor 按应用回调地址放行）；浏览器请求失败时登录页回退为跳转 IAM 登录页。
"""

import time
from urllib.parse import urlencode

import httpx
from fastapi import HTTPException

from app.core.config import settings

_APP_CACHE_SECONDS = 600
_app_cache: dict[tuple[str, str], tuple[float, dict]] = {}


def _application(client_id: str, redirect_uri: str) -> dict:
    """IAM 中该客户端对应的应用名与组织（公开接口 get-app-login，结果缓存 10 分钟）。"""
    key = (client_id, redirect_uri)
    cached = _app_cache.get(key)
    if cached and time.monotonic() - cached[0] < _APP_CACHE_SECONDS:
        return cached[1]
    try:
        response = httpx.get(
            f"{settings.casdoor_internal_url}/api/get-app-login",
            params={
                "clientId": client_id,
                "responseType": "code",
                "type": "code",
                "redirectUri": redirect_uri,
                "scope": "openid profile email",
                "state": "embedded",
            },
            timeout=10,
            trust_env=False,
        )
        response.raise_for_status()
        body = response.json()
        data = body.get("data") if body.get("status") == "ok" else None
        app = {"name": data["name"], "organization": data["organization"]}
        if not all(isinstance(v, str) and v for v in app.values()):
            raise ValueError("incomplete application")
    except (httpx.HTTPError, ValueError, KeyError, TypeError) as exc:
        raise HTTPException(503, "暂时无法连接迈博统一身份服务，请稍后重试") from exc
    _app_cache[key] = (time.monotonic(), app)
    return app


def embedded_login(params: dict) -> dict:
    """params 为授权地址参数（client_id、redirect_uri、scope、state、nonce、code_challenge）。"""
    app = _application(params["client_id"], params["redirect_uri"])
    query = {
        "clientId": params["client_id"],
        "responseType": "code",
        "redirectUri": params["redirect_uri"],
        "type": "code",
        "scope": params["scope"],
        "state": params["state"],
        "nonce": params["nonce"],
        "code_challenge_method": "S256",
        "code_challenge": params["code_challenge"],
    }
    return {
        "login_api": f"{settings.casdoor_issuer}/api/login?{urlencode(query)}",
        "application": app["name"],
        "organization": app["organization"],
        "callback_url": params["redirect_uri"],
        "state": params["state"],
    }
