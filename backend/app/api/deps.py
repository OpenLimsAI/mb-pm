"""FastAPI 通用依赖：当前用户（IAM 服务端会话，或严格验签的 Casdoor Bearer token）+ 角色门。

演示身份头（DemoUser）与本地签发的 HS256 JWT 均已移除，一律返回 401。
"""

import time
from urllib.parse import urlsplit

from cryptography.fernet import InvalidToken
from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import (
    SESSION_COOKIE,
    decode_access_token,
    digest,
    resolve_identity,
    unseal,
)
from app.db.session import get_db
from app.models import IAMSession, User
from app.services import password_policy


def require_same_origin(request: Request, *, origin: str | None = None) -> None:
    """cookie 认证的写操作要求精确的可信 Origin（含端口；仅靠 SameSite 挡不住同站其他端口）。"""
    parsed = urlsplit(origin or settings.pms_origin)
    expected = f"{parsed.scheme}://{parsed.netloc}"
    if request.headers.get("origin") != expected:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "请求来源验证失败，请从系统入口重新操作")


def get_current_user(request: Request, db: Session = Depends(get_db)) -> User:
    authorization = request.headers.get("authorization", "")
    if authorization:
        # 直连 API 的客户端：须携带已绑定用户的有效 Casdoor access token。
        if not authorization.startswith("Bearer "):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "请使用 IAM 登录，演示身份头已禁用")
        token = authorization[7:].strip()
    else:
        session_id = request.cookies.get(SESSION_COOKIE, "")
        session = db.get(IAMSession, digest(session_id)) if session_id else None
        if not session or session.expires_at <= int(time.time()):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "请先登录 IAM")
        if request.method not in {"GET", "HEAD", "OPTIONS"}:
            require_same_origin(request)
        try:
            token = unseal(session.tokens)["access_token"]
        except (InvalidToken, ValueError, KeyError) as exc:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "登录会话已失效") from exc
    # 每次请求都重新验签并校验组织 / 账号启用状态；须先改临时密码的账号只放行改密 / 查询身份 / 退出。
    claims = decode_access_token(token)
    user = resolve_identity(claims, db)
    password_policy.enforce(db, claims["sub"], request.url.path)
    return user


def require_role(*roles: str):
    """工厂：返回一个 dependency，限定调用者必须具备某些角色之一（角色来自 IAM）。"""

    def _dep(user: User = Depends(get_current_user)) -> User:
        if user.role not in roles:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "当前 IAM 角色无权执行此操作")
        return user

    return _dep
