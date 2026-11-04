"""Persisted project registers, cost detail and personal notification delivery state."""

from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import JSON, Boolean, Date, DateTime, ForeignKey, Integer, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin


class PMRegisterEntry(Base, TimestampMixin):
    __tablename__ = "pm_register_entries"
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False)
    due_date: Mapped[date] = mapped_column(Date, nullable=False)
    severity: Mapped[str] = mapped_column(String(10), nullable=False)
    status: Mapped[str] = mapped_column(String(10), nullable=False, default="open")
    mitigation: Mapped[str] = mapped_column(Text, default="", nullable=False)
    closure: Mapped[str] = mapped_column(Text, default="", nullable=False)
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1)


class PMCostEntry(Base, TimestampMixin):
    __tablename__ = "pm_cost_entries"
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    task_id: Mapped[str | None] = mapped_column(ForeignKey("tasks.id", ondelete="SET NULL"))
    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    category: Mapped[str] = mapped_column(String(40), nullable=False)
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    occurred_on: Mapped[date] = mapped_column(Date, nullable=False)
    evidence_url: Mapped[str] = mapped_column(String(2000), nullable=False, default="")
    notes: Mapped[str] = mapped_column(Text, nullable=False, default="")
    voided: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    void_reason: Mapped[str] = mapped_column(Text, nullable=False, default="")
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1)


class PMNotificationState(Base):
    __tablename__ = "pm_notification_states"
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    event_key: Mapped[str] = mapped_column(String(200), primary_key=True)
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    snooze_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class PMNotificationPreference(Base):
    __tablename__ = "pm_notification_preferences"
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    mode: Mapped[str] = mapped_column(String(10), nullable=False, default="immediate")
    digest_on: Mapped[date | None] = mapped_column(Date)
    digest_keys: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
