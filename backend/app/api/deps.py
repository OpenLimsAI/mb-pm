"""FastAPI 通用依赖：DB 会话 + 当前用户。"""

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.session import get_db
from app.models import User


def get_current_user(
    authorization: str = Header(default="", alias="Authorization"),
    db: Session = Depends(get_db),
) -> User:
    """从 Authorization 头解析 JWT 并返回 User。

    演示模式可绕过：传 `X-Demo-User: <username>` 头部直接登录该用户。
    """
    # 演示快捷登录（不能上线）
    # 注意：真实项目应去掉以下分支
    return _resolve_demo_or_jwt(authorization, db)


def _resolve_demo_or_jwt(authorization: str, db: Session) -> User:
    if not authorization:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing Authorization header")

    if authorization.startswith("DemoUser "):
        if settings.APP_ENV != "development":
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "DemoUser auth disabled outside development")
        username = authorization.removeprefix("DemoUser ").strip()
        user = db.query(User).filter_by(username=username).first()
        if not user:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, f"demo user {username!r} not found")
        return user

    if not authorization.startswith("Bearer "):
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, "expected Bearer token or DemoUser <username>"
        )

    token = authorization.removeprefix("Bearer ").strip()
    from app.core.casdoor import verify_casdoor_token, extract_role
    try:
        claims = verify_casdoor_token(token)
    except ValueError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid or expired token")

    username = claims.get("preferred_username") or claims.get("name")
    if not username:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "token missing username")

    user = db.query(User).filter_by(username=username).first()
    if not user:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, f"user {username!r} not provisioned")

    role = extract_role(claims)
    if role:
        db.expunge(user)  # 防止本请求 commit 时把角色覆盖持久化到 users 表
        user.role = role  # Casdoor 为角色唯一来源（仅本请求内覆盖，不落库）
    return user


def require_role(*roles: str):
    """工厂：返回一个 dependency，限定调用者必须具备某些角色之一。"""

    def _dep(user: User = Depends(get_current_user)) -> User:
        if user.role not in roles:
            raise HTTPException(status.HTTP_403_FORBIDDEN, f"requires role in {roles}")
        return user

    return _dep
