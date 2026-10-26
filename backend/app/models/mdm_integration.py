"""MDM creation receipts and provider-verified logout revocation markers."""

from datetime import UTC, datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class MDMProjectReceipt(Base):
    __tablename__ = "mdm_project_receipts"
    __table_args__ = (
        UniqueConstraint("source_id", "source_project_id", name="uq_mdm_source_project"),
    )
    request_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    source_id: Mapped[str] = mapped_column(String(64), nullable=False)
    source_project_id: Mapped[str] = mapped_column(String(64), nullable=False)
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), unique=True, nullable=False)
    created_by: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC), nullable=False
    )


class OIDCRevocation(Base):
    __tablename__ = "oidc_revocations"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    issuer: Mapped[str] = mapped_column(String(255), nullable=False)
    audience: Mapped[str] = mapped_column(String(255), nullable=False)
    subject: Mapped[str] = mapped_column(String(255), nullable=False)
    sid: Mapped[str] = mapped_column(String(255), nullable=False)
    revoked_before: Mapped[int] = mapped_column(BigInteger, nullable=False)


class OIDCLogoutReplay(Base):
    __tablename__ = "oidc_logout_replays"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    payload_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    expires_at: Mapped[int] = mapped_column(BigInteger, nullable=False, index=True)
