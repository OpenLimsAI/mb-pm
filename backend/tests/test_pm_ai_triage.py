from datetime import date, timedelta

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.db.session import SessionLocal
from app.models import Project, Task, User
from app.services import pm_ai_triage
from app.services.pm_ai_triage import TriageRequest, build_triage

TODAY = date(2026, 11, 10)


@pytest.fixture(autouse=True)
def business_date(monkeypatch):
    class FixedDate(date):
        @classmethod
        def today(cls):
            return TODAY

    monkeypatch.setattr(pm_ai_triage, "date", FixedDate)


def set_task(db, pid, number, days, status="未开始", **changes):
    task_id = f"{pid}-t{number}"
    task = db.get(Task, task_id)
    if task is None:
        task = Task(
            id=task_id,
            code=f"T-{number:02}",
            name=f"测试任务 {number}",
            sub_project_id=f"{pid}-sp",
            owner_id="t-admin",
            priority="中",
        )
        db.add(task)
    task.planned_start = TODAY - timedelta(days=60)
    task.planned_end = TODAY + timedelta(days=days)
    task.status = status
    for field, value in changes.items():
        setattr(task, field, value)
    return task_id


def test_triage_ranks_stable_candidates_with_dates_and_evidence(admin_user, project_factory):
    pid = project_factory(admin_user)
    with SessionLocal.begin() as db:
        set_task(db, pid, 1, 30, "阻塞")
        set_task(db, pid, 2, -2)
        set_task(db, pid, 3, 20, "延迟")
        set_task(db, pid, 4, 7, is_milestone=True)
        set_task(db, pid, 5, 7, is_critical_path=True)
        set_task(db, pid, 6, 0)
        set_task(db, pid, 7, 8, is_milestone=True)
        set_task(db, pid, 8, -10, "已完成")
        set_task(db, pid, 9, -20, "已验证")
        set_task(db, pid, 10, 10, is_critical_path=True)
        set_task(db, pid, 11, 7)
        set_task(db, pid, 12, -3, "阻塞")

    with SessionLocal() as db:
        actor = db.get(User, admin_user)
        result = build_triage(db, actor, TriageRequest(project_ids=[pid], limit=20))
        limited = build_triage(db, actor, TriageRequest(project_ids=[pid], limit=3))

    ids = [f"{pid}-t{n}" for n in (12, 1, 2, 3, 4, 5, 6, 11)]
    assert [item["task_id"] for item in result["items"]] == ids
    assert result["business_date"] == TODAY.isoformat()
    assert result["total_candidates"] == limited["total_candidates"] == 8
    assert limited["limit"] == 3 and limited["items"] == result["items"][:3]
    assert result["items"][0]["reasons"] == ["已阻塞", "逾期 3 天"]
    assert result["items"][3]["reasons"] == ["标记延迟"]
    assert result["items"][4]["reasons"] == ["7 天后到期", "里程碑"]
    assert result["items"][5]["reasons"] == ["7 天后到期", "标记为关键路径"]
    assert result["items"][6] == {
        "task_id": f"{pid}-t6",
        "project_id": pid,
        "code": "T-06",
        "name": "测试任务 6",
        "project_name": "测试项目",
        "status": "未开始",
        "planned_end": TODAY.isoformat(),
        "owner_name": admin_user,
        "reasons": ["今天到期"],
        "href": f"/projects/{pid}?tab=wbs&task={pid}-t6",
    }


def test_triage_checks_visibility_and_limits_focus_to_selected_tasks(
    admin_user, iam_user, project_factory
):
    uid = iam_user("triage-member", "rd")
    pid = project_factory(admin_user, member_ids=(uid,))
    hidden = project_factory(admin_user)
    with SessionLocal.begin() as db:
        own = set_task(db, pid, 1, 1)
        private = set_task(db, pid, 2, -2, "阻塞", owner_id=admin_user)
        set_task(db, hidden, 1, -3, "阻塞")

    with SessionLocal() as db:
        member = db.get(User, uid)
        result = build_triage(db, member, TriageRequest())
        assert result["total_candidates"] == 1
        assert [item["task_id"] for item in result["items"]] == [own]
        for request in (
            TriageRequest(project_ids=[hidden]),
            TriageRequest(project_ids=[pid], task_ids=[private]),
        ):
            with pytest.raises(HTTPException) as denied:
                build_triage(db, member, request)
            assert denied.value.status_code == 404

        admin = db.get(User, admin_user)
        selected = build_triage(db, admin, TriageRequest(task_ids=[private]))
        assert [item["task_id"] for item in selected["items"]] == [private]
        with pytest.raises(HTTPException) as mismatch:
            build_triage(db, admin, TriageRequest(project_ids=[hidden], task_ids=[private]))
        assert mismatch.value.status_code == 422


def test_triage_mine_only_keeps_actor_assignments_and_collaborations(
    admin_user, iam_user, project_factory
):
    uid = iam_user("triage-lead", "project_lead")
    pid = project_factory(uid, task_owner_id=admin_user)
    with SessionLocal.begin() as db:
        assigned = set_task(db, pid, 1, 2, owner_id=uid)
        collaboration = set_task(db, pid, 2, 1, collaborator_ids=[uid])
        other = set_task(db, pid, 3, -4)

    with SessionLocal() as db:
        actor = db.get(User, uid)
        full = build_triage(db, actor, TriageRequest(project_ids=[pid]))
        mine = build_triage(db, actor, TriageRequest(project_ids=[pid], mine_only=True))
    assert [item["task_id"] for item in full["items"]] == [other, collaboration, assigned]
    assert mine["mine_only"] is True and mine["total_candidates"] == 2
    assert [item["task_id"] for item in mine["items"]] == [collaboration, assigned]


def test_triage_excludes_inactive_projects_and_unremarkable_backlog(admin_user, project_factory):
    active = project_factory(admin_user)
    paused = project_factory(admin_user)
    with SessionLocal.begin() as db:
        db.get(Project, paused).status = "暂停"
        for index in (1, 2):
            set_task(db, active, index, 8)
            set_task(db, paused, index, -1, "阻塞")

    with SessionLocal() as db:
        result = build_triage(
            db, db.get(User, admin_user), TriageRequest(project_ids=[active, paused])
        )
    assert result == {
        "business_date": TODAY.isoformat(),
        "items": [],
        "total_candidates": 0,
        "limit": 5,
        "mine_only": False,
    }


def test_triage_and_context_share_milestone_completion_and_overdue_rules(
    admin_user, project_factory, monkeypatch
):
    from app.services import pm_ai_context
    from app.services.pm_ai_context import ContextRequest, build_context

    monkeypatch.setattr(pm_ai_context, "date", pm_ai_triage.date)
    pid = project_factory(admin_user)
    with SessionLocal.begin() as db:
        ordinary = set_task(db, pid, 1, -3, "进行中", progress=100)
        milestone = set_task(db, pid, 2, -2, "进行中", progress=100, is_milestone=True)
        blocked = set_task(db, pid, 3, -5, "阻塞", progress=100)
        delayed = set_task(db, pid, 4, 20, "延迟", progress=30)
        future = set_task(db, pid, 5, 8, "未开始", progress=0)

    with SessionLocal() as db:
        user = db.get(User, admin_user)
        context = build_context(db, user, ContextRequest(project_ids=[pid]))
        result = build_triage(db, user, TriageRequest(project_ids=[pid], limit=20))
    by_id = {task["id"]: task for task in context["tasks"]}
    assert context["metrics"]["overdue_tasks"] == 1
    assert by_id[milestone]["overdue"] is True
    assert by_id[ordinary]["overdue"] is False
    assert by_id[blocked]["overdue"] is False
    reasons = {task["task_id"]: task["reasons"] for task in result["items"]}
    assert ordinary not in reasons and future not in reasons
    assert reasons[milestone] == ["逾期 2 天", "里程碑"]
    assert reasons[blocked] == ["已阻塞"]
    assert reasons[delayed] == ["标记延迟"]


@pytest.mark.parametrize("limit", [0, 21, True, 2.5])
def test_triage_rejects_invalid_limits(limit):
    with pytest.raises(ValidationError):
        TriageRequest(limit=limit)
