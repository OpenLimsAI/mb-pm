"""Private task conversations for the portal AI assistant."""

from datetime import UTC, datetime

from sqlalchemy import JSON, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class AssistantTask(Base):
    __tablename__ = "assistant_tasks"
    __table_args__ = (Index("ix_assistant_tasks_owner", "issuer", "owner_id", "updated_at"),)
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    issuer: Mapped[str] = mapped_column(String(255), nullable=False)
    owner_id: Mapped[str] = mapped_column(String(255), nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    # Legacy grouping retained for stored tasks; no longer exposed or used by the assistant.
    project: Mapped[str] = mapped_column(String(200), nullable=False, default="")
    instructions: Mapped[str] = mapped_column(Text, nullable=False, default="")
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=lambda: datetime.now(UTC)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=lambda: datetime.now(UTC)
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class AssistantMessage(Base):
    __tablename__ = "assistant_messages"
    __table_args__ = (
        UniqueConstraint(
            "task_id", "request_id", "role", name="uq_assistant_messages_request_role"
        ),
        UniqueConstraint("task_id", "position", name="uq_assistant_messages_position"),
        Index("ix_assistant_messages_task", "task_id", "position"),
    )
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    task_id: Mapped[str] = mapped_column(ForeignKey("assistant_tasks.id"), nullable=False)
    request_id: Mapped[str] = mapped_column(String(64), nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    role: Mapped[str] = mapped_column(String(20), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    context: Mapped[str] = mapped_column(Text, nullable=False, default="")
    data_sources: Mapped[str] = mapped_column(
        String(100), nullable=False, default="[]", server_default="[]"
    )
    profile_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    model: Mapped[str] = mapped_column(String(200), nullable=False, default="")
    answer_mode: Mapped[str] = mapped_column(
        String(20), nullable=False, default="", server_default=""
    )
    requested_mode: Mapped[str] = mapped_column(
        String(20), nullable=False, default="", server_default=""
    )
    mode_reason: Mapped[str] = mapped_column(
        String(200), nullable=False, default="", server_default=""
    )
    web_references: Mapped[list] = mapped_column(
        JSON, nullable=False, default=list, server_default="[]"
    )
    application_scope: Mapped[dict] = mapped_column(
        JSON, nullable=False, default=dict, server_default="{}"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=lambda: datetime.now(UTC)
    )
