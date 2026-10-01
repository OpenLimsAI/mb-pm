"""IAM 身份绑定 + 服务端会话；业务用户 ID 保持不变。"""

from sqlalchemy import BigInteger, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class IAMIdentity(Base):
    """IAM 账号（issuer + sub）↔ 业务用户，一对一。"""

    __tablename__ = "iam_identities"
    __table_args__ = (UniqueConstraint("issuer", "user_id"),)

    issuer: Mapped[str] = mapped_column(String(255), primary_key=True)
    subject: Mapped[str] = mapped_column(String(255), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False)


class IAMSession(Base):
    """浏览器会话：主键为会话 cookie 的 SHA-256，令牌加密存储。"""

    __tablename__ = "iam_sessions"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    tokens: Mapped[str] = mapped_column(Text, nullable=False)
    expires_at: Mapped[int] = mapped_column(BigInteger, nullable=False, index=True)


class IAMLogin(Base):
    """进行中的登录（state 的 SHA-256 → 加密的 PKCE verifier / nonce / 回跳地址），10 分钟有效。"""

    __tablename__ = "iam_logins"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    data: Mapped[str] = mapped_column(Text, nullable=False)
    expires_at: Mapped[int] = mapped_column(BigInteger, nullable=False, index=True)
