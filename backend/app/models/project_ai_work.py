"""Durable project analysis jobs and idempotent, explicitly confirmed actions."""

from datetime import datetime

from sqlalchemy import JSON, DateTime, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class ProjectAIJob(Base):
    __tablename__ = "project_ai_jobs"
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    created_by: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    state: Mapped[str] = mapped_column(String(16), nullable=False, index=True)
    focus: Mapped[str] = mapped_column(Text, nullable=False)
    prompt: Mapped[str] = mapped_column(Text, nullable=False)
    context: Mapped[dict] = mapped_column(JSON, nullable=False)
    source: Mapped[dict] = mapped_column(JSON, nullable=False)
    analysis_id: Mapped[str | None] = mapped_column(
        ForeignKey("project_ai_analyses.id", ondelete="SET NULL")
    )
    error: Mapped[str] = mapped_column(Text, nullable=False, default="")
    claim: Mapped[str | None] = mapped_column(String(40))


class ProjectAIAction(Base):
    __tablename__ = "project_ai_actions"
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    analysis_id: Mapped[str] = mapped_column(
        ForeignKey("project_ai_analyses.id", ondelete="CASCADE"), index=True
    )
    action_key: Mapped[str] = mapped_column(String(80), nullable=False)
    created_by: Mapped[str] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    draft: Mapped[dict] = mapped_column(JSON, nullable=False)
    result: Mapped[dict] = mapped_column(JSON, nullable=False)
