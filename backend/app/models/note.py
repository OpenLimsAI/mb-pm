"""Personal notes belong to the portal identity, independently of KB and reports."""

from datetime import UTC, datetime

from sqlalchemy import Boolean, DateTime, Float, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class PersonalNote(Base):
    __tablename__ = "personal_notes"
    __table_args__ = (Index("ix_personal_notes_owner", "issuer", "owner_id", "updated_at"),)
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    issuer: Mapped[str] = mapped_column(String(255), nullable=False)
    owner_id: Mapped[str] = mapped_column(String(255), nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    source_app: Mapped[str] = mapped_column(String(30), nullable=False, default="manual")
    source_title: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    source_url: Mapped[str] = mapped_column(String(2000), nullable=False, default="")
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=lambda: datetime.now(UTC)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=lambda: datetime.now(UTC)
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class NoteWisdomSync(Base):
    """One durable, coalescing outbox per explicitly shared note. No legacy backfill."""

    __tablename__ = "note_wisdom_sync"
    note_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    desired_revision: Mapped[int] = mapped_column(Integer, nullable=False)
    synced_revision: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    published_path: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    operation: Mapped[str] = mapped_column(Text, nullable=False, default="")
    status: Mapped[str] = mapped_column(String(30), nullable=False, default="pending")
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    next_attempt_at: Mapped[float] = mapped_column(Float, nullable=False, default=0)
    error: Mapped[str] = mapped_column(String(500), nullable=False, default="")
