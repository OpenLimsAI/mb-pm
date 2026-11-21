from datetime import date, timedelta

import pytest
from fastapi import HTTPException

from app.db.session import SessionLocal
from app.models import Task, User
from app.services import pm_ai_agent
from app.services.pm_ai_agent import PlanRequest, plan_question
from app.services.pm_ai_filters import reporting_period
from app.services.pm_ai_triage import TriageRequest, build_triage


@pytest.mark.parametrize(
    "text,start,end",
    [
        ("整理2026年10月1日至10月7日周报", "2026-10-01", "2026-10-07"),
        ("整理2026-10-01至2026-10-07周报", "2026-10-01", "2026-10-07"),
        ("整理最近30天周报", "2026-10-20", "2026-11-18"),
        ("整理上月周报", "2026-10-01", "2026-10-31"),
        ("昨天周报", "2026-11-17", "2026-11-17"),
    ],
)
def test_explicit_reporting_period_reaches_plan(
    admin_user, project_factory, monkeypatch, text, start, end
):
    class Today(date):
        @classmethod
        def today(cls):
            return date(2026, 11, 18)

    monkeypatch.setattr(pm_ai_agent, "date", Today)
    pid = project_factory(admin_user)
    with SessionLocal() as db:
        result = plan_question(
            db, db.get(User, admin_user), PlanRequest(question=text, project_id=pid)
        )
    assert result["status"] == "ready"
    assert (result["start_date"], result["end_date"]) == (start, end)


@pytest.mark.parametrize(
    "text",
    [
        "2026年2月30日周报",
        "2026年11月8日至11月1日周报",
        "上上周周报",
        "最近500天周报",
        "本季度周报",
        "2026年10月周报",
        "本周和上周周报",
        "2026年10月1日和10月7日周报",
        "本周五周报",
        "近一周周报",
        "2026年10月1日前周报",
    ],
)
def test_unsupported_or_invalid_dates_never_become_default_week(text):
    assert reporting_period(text, date(2026, 11, 18))[2]


def test_owner_and_priority_reach_filtered_facts(admin_user, iam_user, project_factory):
    owner = iam_user("query-owner", "rd")
    pid = project_factory(admin_user, member_ids=(owner,))
    with SessionLocal.begin() as db:
        db.get(User, owner).display_name = "张三"
        first = db.get(Task, f"{pid}-t1")
        first.owner_id, first.priority, first.status = owner, "高", "延迟"
        second = db.get(Task, f"{pid}-t2")
        second.owner_id, second.priority, second.status = admin_user, "低", "延迟"
    with SessionLocal() as db:
        user = db.get(User, admin_user)
        result = plan_question(
            db, user, PlanRequest(question="列出张三负责的高优先级延期任务", project_id=pid)
        )
        assert result["status"] == "ready", result
        assert result["owner_id"] == owner and result["priority"] == "高"
        facts = build_triage(
            db,
            user,
            TriageRequest(
                project_ids=[pid],
                owner_id=result["owner_id"],
                priority=result["priority"],
                task_filter="delayed",
            ),
        )
        assert [row["task_id"] for row in facts["items"]] == [f"{pid}-t1"]
        assert facts["filters"]["owner_name"] == "张三"
        for question in (
            "不存在的人负责的延期任务",
            "不是张三负责的延期任务",
            "王张三负责的延期任务",
            "最高优先级的延期任务",
            "优先级最高的延期任务",
            "优先级不是高的延期任务",
            "延期任务，优先级高和中",
            "不由张三负责的延期任务",
            "张三和李四负责的延期任务",
        ):
            assert (
                plan_question(db, user, PlanRequest(question=question, project_id=pid))["status"]
                == "clarify"
            ), question
        with pytest.raises(HTTPException):
            build_triage(db, user, TriageRequest(project_ids=[pid], owner_id="hidden-person"))


def test_due_period_queries_latest_tasks_with_explicit_dates(admin_user, project_factory):
    pid = project_factory(admin_user)
    start = date.today() + timedelta(days=30)
    with SessionLocal.begin() as db:
        first, second = db.get(Task, f"{pid}-t1"), db.get(Task, f"{pid}-t2")
        first.planned_end, first.status = start, "进行中"
        second.planned_end, second.status = start + timedelta(days=10), "进行中"
    with SessionLocal() as db:
        user = db.get(User, admin_user)
        result = plan_question(
            db, user, PlanRequest(question=f"{start.isoformat()}到期的任务", project_id=pid)
        )
        assert result["status"] == "ready", result
        facts = build_triage(
            db,
            user,
            TriageRequest(
                project_ids=[pid], start_date=result["start_date"], end_date=result["end_date"]
            ),
        )
        assert [row["task_id"] for row in facts["items"]] == [f"{pid}-t1"]
