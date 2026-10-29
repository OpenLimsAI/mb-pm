"""IAM bindings and opaque browser sessions; business user IDs stay unchanged."""

from sqlalchemy import BigInteger, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class IAMIdentity(Base):
    __tablename__ = "iam_identities"
    __table_args__ = (UniqueConstraint("issuer", "user_id"),)
    issuer: Mapped[str] = mapped_column(String(255), primary_key=True)
    subject: Mapped[str] = mapped_column(String(255), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False)


class IAMSession(Base):
    __tablename__ = "iam_sessions"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)  # SHA-256 of cookie
    tokens: Mapped[str] = mapped_column(Text, nullable=False)  # encrypted at rest
    expires_at: Mapped[int] = mapped_column(BigInteger, nullable=False, index=True)


class IAMLogin(Base):
    __tablename__ = "iam_logins"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    data: Mapped[str] = mapped_column(Text, nullable=False)
    expires_at: Mapped[int] = mapped_column(BigInteger, nullable=False, index=True)
