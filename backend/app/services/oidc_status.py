"""Per-request RFC 7662 check after local JWT validation; no status cache.

Casdoor v3.152.0 permits a same-certificate resource client to inspect the
dedicated PM delegation token. We still require its actual client_id and sub.
Different certificates fail closed; no MDM client secret is shared with PM.
"""

from datetime import datetime

import httpx
from fastapi import HTTPException

from app.core.config import settings


def ensure_active_token(
    token: str,
    claims: dict,
    *,
    expected_audience: str,
    portal: bool = False,
    authenticated_iat: int | None = None,
) -> None:
    if not settings.OIDC_GLOBAL_LOGOUT_ENABLED:
        return
    if not settings.CASDOOR_ACCOUNT_STATUS_VISIBLE:
        raise HTTPException(503, "统一身份状态字段可见性尚未确认")
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

    ensure_enabled_user(token, claims, authenticated_iat=authenticated_iat)


def ensure_enabled_user(token: str, claims: dict, *, authenticated_iat: int | None = None) -> None:
    """Read only the token holder by immutable ID; discard extra provider data."""
    try:
        with httpx.Client(timeout=5, trust_env=False, follow_redirects=False) as client:
            response = client.get(
                settings.casdoor_internal_url + "/api/get-user",
                params={"owner": settings.CASDOOR_ORG, "userId": claims["sub"]},
                headers={"Authorization": "Bearer " + token},
            )
        if response.status_code in {401, 403, 404}:
            raise HTTPException(401, "统一身份账号状态核验被拒绝")
        if response.status_code != 200:
            raise ValueError("provider status")
        current = response.json()
        if not isinstance(current, dict):
            raise ValueError("provider format")
    except (httpx.HTTPError, ValueError, TypeError):
        raise HTTPException(503, "统一身份账号状态服务暂不可用") from None
    user = current.get("data")
    if (
        current.get("status") != "ok"
        or not isinstance(user, dict)
        or user.get("id") != claims.get("sub")
        or user.get("owner") != settings.CASDOOR_ORG
        or not isinstance(user.get("isForbidden"), bool)
        or not isinstance(user.get("isDeleted"), bool)
    ):
        raise HTTPException(401, "统一身份账号状态不完整或主体不匹配")
    if user["isForbidden"] or user["isDeleted"]:
        raise HTTPException(403, "统一身份账号已停用或删除")

    # JWT role claims are a login snapshot. Authorize with the current IAM roles,
    # bound above to this exact immutable subject and organization, on every request.
    roles = user.get("roles")
    if not isinstance(roles, list) or any(not isinstance(role, (dict, str)) for role in roles):
        raise HTTPException(503, "统一身份角色状态不完整，请联系管理员")
    if not isinstance(user.get("needUpdatePassword"), bool):
        raise HTTPException(503, "统一身份密码状态字段不可用，请联系管理员")
    changed_at = password_changed_at(user.get("lastChangePasswordTime"))
    original = authenticated_iat if authenticated_iat is not None else claims.get("iat")
    if changed_at and (
        not isinstance(original, int) or isinstance(original, bool) or original <= changed_at
    ):
        raise HTTPException(401, "账号密码已修改，请使用新密码重新登录")
    claims["roles"] = roles
    # Trusted request-local state, never serialized back into an issued JWT.
    claims["_iam_password_state"] = {
        "required": user["needUpdatePassword"],
        "changed_at": changed_at,
    }


def password_changed_at(value) -> int:
    if not isinstance(value, str):
        raise HTTPException(503, "统一身份密码变更时间字段不可用，请联系管理员")
    if not value:
        return 0
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError("timezone required")
        return int(parsed.timestamp())
    except (ValueError, TypeError, OverflowError):
        raise HTTPException(503, "统一身份密码变更时间无效，请联系管理员") from None
