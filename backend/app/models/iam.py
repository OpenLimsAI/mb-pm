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


class PasswordChangeRequired(Base):
    """须先改临时密码的 IAM 账号（账号管理新建 / 重置密码时写入，本人在门户或项目管理改密后删除）。

    不用 Casdoor 的「需要更新密码」：3.100.0 打开它后登录会被带到 IAM 自己的「我的账户」页、不回到应用。
    """

    __tablename__ = "iam_password_change_required"

    issuer: Mapped[str] = mapped_column(String(255), primary_key=True)
    subject: Mapped[str] = mapped_column(String(255), primary_key=True)
    reason: Mapped[str] = mapped_column(String(20), nullable=False)  # created / reset / migrated
    required_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
