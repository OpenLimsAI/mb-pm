"""FastAPI 通用依赖：DB 会话 + 当前用户。"""

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy.orm import Session

from app.core.security import decode_access_token
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
        username = authorization.removeprefix("DemoUser ").strip()
        user = db.query(User).filter_by(username=username).first()
        if not user:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, f"demo user {username!r} not found")
        return user

    if not authorization.startswith("Bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "expected Bearer token or DemoUser <username>")

    token = authorization.removeprefix("Bearer ").strip()
    payload = decode_access_token(token)
    if not payload:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid or expired token")

    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "token missing sub")

    user = db.query(User).filter_by(id=user_id).first()
    if not user:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "user not found")
    return user


def require_role(*roles: str):
    """工厂：返回一个 dependency，限定调用者必须具备某些角色之一。"""

    def _dep(user: User = Depends(get_current_user)) -> User:
        if user.role not in roles:
            raise HTTPException(status.HTTP_403_FORBIDDEN, f"requires role in {roles}")
        return user

    return _dep
