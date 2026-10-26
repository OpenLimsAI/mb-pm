"""Per-request RFC 7662 check after local JWT validation; no status cache.

Casdoor v3.152.0 permits a same-certificate resource client to inspect the
dedicated PM delegation token. We still require its actual client_id and sub.
Different certificates fail closed; no MDM client secret is shared with PM.
"""

import httpx
from fastapi import HTTPException

from app.core.config import settings


def ensure_active_token(
    token: str, claims: dict, *, expected_audience: str, portal: bool = False
) -> None:
    if not settings.OIDC_GLOBAL_LOGOUT_ENABLED:
        return
    client_id = settings.portal_client_id if portal else settings.CASDOOR_CLIENT_ID
    secret = settings.portal_client_secret if portal else settings.CASDOOR_CLIENT_SECRET
    if not client_id or not secret:
        raise HTTPException(503, "统一身份状态核验客户端尚未配置")
    try:
        with httpx.Client(timeout=5, trust_env=False, follow_redirects=False) as client:
            response = client.post(
                settings.casdoor_internal_url + "/api/login/oauth/introspect",
                auth=httpx.BasicAuth(client_id, secret),
                data={"token": token, "token_type_hint": "access_token"},
            )
        if response.status_code != 200:
            raise ValueError("provider status")
        current = response.json()
        if not isinstance(current, dict):
            raise ValueError("provider format")
    except (httpx.HTTPError, ValueError, TypeError):
        raise HTTPException(503, "统一身份状态服务暂不可用，请稍后重新登录") from None
    if (
        current.get("active") is not True
        or current.get("client_id") != expected_audience
        or current.get("sub") != claims.get("sub")
    ):
        raise HTTPException(401, "统一身份令牌已失效或状态不匹配，请重新登录")
