"""Authenticated IAM sessions or strictly verified Casdoor bearer tokens."""

import time
from typing import Annotated
from urllib.parse import urlsplit

from cryptography.fernet import InvalidToken
from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.iam import SESSION_COOKIE, decode_access_token, digest, resolve_identity, unseal
from app.db.session import get_db
from app.models import IAMSession, User


def require_same_origin(request: Request) -> None:
    # Cookie-authenticated mutations need an exact trusted Origin, including
    # requests from another port on localhost (SameSite alone is insufficient).
    parsed = urlsplit(settings.PMS_PUBLIC_URL)
    expected = f"{parsed.scheme}://{parsed.netloc}"
    if request.headers.get("origin") != expected:
        raise HTTPException(403, "请求来源验证失败，请从系统入口重新操作")


def get_current_user(request: Request, db: Annotated[Session, Depends(get_db)]) -> User:
    authorization = request.headers.get("authorization", "")
    if authorization:
        if not authorization.startswith("Bearer "):
            raise HTTPException(401, "请使用 IAM 登录，演示身份头已禁用")
        token = authorization[7:].strip()
    else:
        session_id = request.cookies.get(SESSION_COOKIE, "")
        session = db.get(IAMSession, digest(session_id)) if session_id else None
        if not session or session.expires_at <= int(time.time()):
            raise HTTPException(401, "请先登录 IAM")
        if request.method not in {"GET", "HEAD", "OPTIONS"}:
            require_same_origin(request)
        try:
            token = unseal(session.tokens)["access_token"]
        except (InvalidToken, ValueError, KeyError) as exc:
            raise HTTPException(401, "登录会话已失效") from exc
    return resolve_identity(decode_access_token(token), db)


def require_role(*roles: str):
    def _dep(user: Annotated[User, Depends(get_current_user)]) -> User:
        if user.role not in roles:
            raise HTTPException(403, "当前 IAM 角色无权执行此操作")
        return user

    return _dep
