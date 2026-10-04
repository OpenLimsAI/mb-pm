"""企业门户会话：与项目业务会话隔离，不绑定或创建业务用户。"""

from sqlalchemy import BigInteger, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class PortalLogin(Base):
    __tablename__ = "portal_logins"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    data: Mapped[str] = mapped_column(Text, nullable=False)
    expires_at: Mapped[int] = mapped_column(BigInteger, nullable=False, index=True)


class PortalSession(Base):
    __tablename__ = "portal_sessions"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    tokens: Mapped[str] = mapped_column(Text, nullable=False)
    expires_at: Mapped[int] = mapped_column(BigInteger, nullable=False, index=True)
