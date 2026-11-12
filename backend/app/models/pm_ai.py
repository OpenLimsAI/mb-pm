"""Persisted, actor-owned project AI runs across one or more visible projects."""

from datetime import datetime

from sqlalchemy import JSON, DateTime, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class PMAIRun(Base):
    __tablename__ = "pm_ai_runs"

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    created_by: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    state: Mapped[str] = mapped_column(String(16), nullable=False, index=True)
    request: Mapped[dict] = mapped_column(JSON, nullable=False)
    context: Mapped[dict] = mapped_column(JSON, nullable=False)
    source: Mapped[dict] = mapped_column(JSON, nullable=False)
    result: Mapped[dict | None] = mapped_column(JSON)
    provider: Mapped[str | None] = mapped_column(String(20))
    model: Mapped[str | None] = mapped_column(String(160))
    usage: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    error: Mapped[str] = mapped_column(Text, nullable=False, default="")
    claim: Mapped[str | None] = mapped_column(String(40))
