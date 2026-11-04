"""Project working calendars and per-week staff capacity; business data lives in SQL."""

from sqlalchemy import JSON, Float, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin


class ProjectCalendar(Base, TimestampMixin):
    __tablename__ = "project_calendars"

    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True
    )
    # ISO weekdays: Monday=1. All seven preserves historical natural-day schedules.
    weekdays: Mapped[list] = mapped_column(JSON, default=lambda: [1, 2, 3, 4, 5, 6, 7])
    holidays: Mapped[list] = mapped_column(JSON, default=list)
    working_dates: Mapped[list] = mapped_column(JSON, default=list)
    revision: Mapped[int] = mapped_column(Integer, default=1, nullable=False)


class UserWeeklyCapacity(Base, TimestampMixin):
    __tablename__ = "user_weekly_capacities"

    id: Mapped[str] = mapped_column(String(80), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    week_start: Mapped[str] = mapped_column(String(10), nullable=False)
    available_hours: Mapped[float] = mapped_column(Float, nullable=False)
    leave_hours: Mapped[float] = mapped_column(Float, default=0, nullable=False)
    revision: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
