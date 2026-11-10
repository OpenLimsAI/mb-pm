"""One overdue policy for project health and structured task queries."""

from datetime import date

from sqlalchemy import or_

from app.models import Task

COMPLETED_STATUSES = ("已完成", "已验证")


def is_overdue(task: Task, today: date) -> bool:
    # A milestone is incomplete until its state is complete, even at 100%.
    return (
        task.planned_end < today
        and task.status not in COMPLETED_STATUSES
        and (task.is_milestone or task.progress < 100)
    )


def overdue_clause(today: date):
    return (
        (Task.planned_end < today)
        & Task.status.not_in(COMPLETED_STATUSES)
        & or_(Task.is_milestone.is_(True), Task.progress < 100)
    )
