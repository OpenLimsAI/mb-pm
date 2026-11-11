"""Business boundary cases shared by Agent queries and PM AI summaries."""

from datetime import date, timedelta

import pytest
from sqlalchemy import select

from app.db.session import SessionLocal
from app.models import Task
from app.services.task_deadlines import is_overdue, overdue_clause


@pytest.mark.parametrize(
    ("offset", "status", "progress", "milestone", "expected"),
    [
        (-1, "进行中", 99, False, True),
        (-1, "未开始", 0, False, True),
        (-1, "进行中", 100, False, False),
        (-1, "进行中", 100, True, True),
        (-1, "已完成", 100, True, False),
        (-1, "已验证", 100, True, False),
        (-1, "已完成", 99, False, False),
        (-1, "已验证", 99, False, False),
        (0, "进行中", 99, False, False),
        (0, "进行中", 100, True, False),
        (1, "进行中", 99, False, False),
        (1, "进行中", 100, True, False),
        (1, "延迟", 10, False, False),
        (1, "阻塞", 10, True, False),
    ],
)
def test_python_and_sql_deadline_rules_match_business_boundaries(
    admin_user, project_factory, offset, status, progress, milestone, expected
):
    pid = project_factory(admin_user)
    today = date(2026, 11, 11)
    with SessionLocal.begin() as db:
        task = db.get(Task, f"{pid}-t1")
        task.planned_start = today - timedelta(days=30)
        task.planned_end = today + timedelta(days=offset)
        task.status, task.progress, task.is_milestone = status, progress, milestone
        db.flush()
        assert is_overdue(task, today) is expected
        found = db.scalar(select(Task.id).where(Task.id == task.id, overdue_clause(today)))
        assert (found is not None) is expected
