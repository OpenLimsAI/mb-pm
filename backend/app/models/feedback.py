"""Organization-wide feedback and its image attachments."""

from datetime import UTC, datetime

from sqlalchemy import DateTime, ForeignKey, LargeBinary, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class Feedback(Base):
    __tablename__ = "feedback"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    issuer: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    author_id: Mapped[str] = mapped_column(String(255), nullable=False)
    author_name: Mapped[str] = mapped_column(String(255), nullable=False)
    category: Mapped[str] = mapped_column(String(20), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="open", nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC), nullable=False
    )
    images: Mapped[list["FeedbackImage"]] = relationship(
        cascade="all, delete-orphan", order_by="FeedbackImage.id"
    )


class FeedbackImage(Base):
    __tablename__ = "feedback_images"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    feedback_id: Mapped[str] = mapped_column(
        ForeignKey("feedback.id", ondelete="CASCADE"), nullable=False, index=True
    )
    content_type: Mapped[str] = mapped_column(String(30), nullable=False)
    content: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
