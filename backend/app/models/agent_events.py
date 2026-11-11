"""Stable delivery order for already committed project task activities."""

from sqlalchemy import ForeignKey, Index, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class AgentEventPublication(Base):
    __tablename__ = "agent_event_publications"
    __table_args__ = (
        Index("ix_agent_event_publications_project_sequence", "project_id", "sequence"),
        {"sqlite_autoincrement": True},
    )

    sequence: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    activity_id: Mapped[str] = mapped_column(
        ForeignKey("task_activities.id", ondelete="CASCADE"), unique=True
    )
    kind: Mapped[str] = mapped_column(String(20))
