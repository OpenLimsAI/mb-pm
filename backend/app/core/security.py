"""JWT 编/解码 + 密码哈希。演示模式只用 JWT，密码 hash 留作生产用。"""

from datetime import datetime, timedelta, timezone
from typing import Any

from jose import JWTError, jwt
from passlib.context import CryptContext

from app.core.config import settings

# pbkdf2_sha256 为纯 Python 实现，无原生依赖（避免 passlib+bcrypt 版本兼容问题）。
# Lite 版采用用户名登录，密码哈希仅为生产预留。
pwd_context = CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")


def hash_password(plain: str) -> str:
    return pwd_context.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


def create_access_token(subject: str, extra: dict[str, Any] | None = None) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=settings.JWT_ACCESS_EXPIRE_MINUTES)
    payload: dict[str, Any] = {"sub": subject, "exp": expire}
    if extra:
        payload.update(extra)
    return jwt.encode(payload, settings.APP_SECRET, algorithm=settings.JWT_ALGORITHM)


def decode_access_token(token: str) -> dict[str, Any] | None:
    try:
        return jwt.decode(token, settings.APP_SECRET, algorithms=[settings.JWT_ALGORITHM])
    except JWTError:
        return None
