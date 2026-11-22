"""MDM creation receipts (OIDC revocation models re-exported from app.models.iam)."""

from datetime import UTC, datetime

from sqlalchemy import DateTime, ForeignKey, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.iam import OIDCLogoutReplay, OIDCRevocation  # noqa: F401


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
