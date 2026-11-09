"""The model interprets the request. The reviewed business change owns the write."""

import json
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from threading import Barrier

import pytest
from fastapi import HTTPException

from app.api.v1 import project_ai_work
from app.db.session import SessionLocal
from app.models import AuditLog, Task, User
from app.services import ai, project_schedule_assist


@pytest.fixture
def schedule_project(project_factory, live_ai_roles):
    def make(owner="t-admin", *, fixed_day=20, members=()):
        pid = project_factory(owner, member_ids=members)
        with SessionLocal() as db:
            task, milestone = (db.get(Task, f"{pid}-t{n}") for n in (1, 2))
            task.planned_start, task.planned_end = date(2026, 11, 2), date(2026, 11, 6)
            milestone.planned_start = milestone.planned_end = date(2026, 11, fixed_day)
            milestone.name, milestone.is_milestone = "IND 申报", True
            db.commit()
        return pid

    return make


def preview(client, headers, pid, instruction="晚两个工作日，申报节点保持不动", *, task_id=None):
    return client.post(
        f"/api/v1/project-ai/projects/{pid}/schedule-assist/preview",
        headers=headers,
        json={"task_id": task_id or f"{pid}-t1", "instruction": instruction},
    )


def confirm(client, headers, pid, token):
    return client.post(
        f"/api/v1/project-ai/projects/{pid}/schedule-assist/apply",
        headers=headers,
        json={"confirmation_token": token, "reason": "确认原料到货延期"},
    )


def set_intent(monkeypatch, **intent):
    monkeypatch.setattr(ai, "chat", lambda *args, **kwargs: (json.dumps(intent), {}))


def test_preview_and_confirmation_use_calendar_and_persist_one_receipt(
    client, auth_headers, schedule_project, monkeypatch
):
    pid = schedule_project()
    calendar = client.put(
        f"/api/v1/planning/projects/{pid}/calendar",
        headers=auth_headers,
        json={
            "revision": 0,
            "weekdays": [1, 2, 3, 4, 5],
            "holidays": ["2026-11-09"],
            "working_dates": ["2026-11-07"],
        },
    )
    assert calendar.status_code == 200, calendar.text
    instruction = "晚两个工作日，申报节点保持不动"

    def interpret(provider, config, messages, *, timeout):
        assert messages[-1] == {"role": "user", "content": instruction}
        assert pid not in json.dumps(messages)
        assert timeout <= 20
        return '{"delay_workdays": 2, "fixed_milestones": ["申报"]}', {}

    monkeypatch.setattr(ai, "chat", interpret)
    reviewed = preview(client, auth_headers, pid, instruction)
    assert reviewed.status_code == 200, reviewed.text
    value = reviewed.json()
    assert value["delay_workdays"] == 2
    assert value["locked_milestones"] == [
        {
            "task_id": f"{pid}-t2",
            "name": "IND 申报",
            "code": "T-2",
            "start_date": "2026-11-20",
            "date": "2026-11-20",
        }
    ]
    assert [c["new_end"] for c in value["schedule"]["changes"]] == ["2026-11-10"]
    with SessionLocal() as db:
        assert db.get(Task, f"{pid}-t1").planned_end == date(2026, 11, 6)
    token = value["confirmation_token"]
    applied = confirm(client, auth_headers, pid, token)
    assert applied.status_code == 200, applied.text
    receipt = applied.json()
    assert receipt["replayed"] is False and receipt["schedule"] == value["schedule"]

    class Later(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime.now(tz) + timedelta(hours=1)

    monkeypatch.setattr(project_ai_work, "datetime", Later)
    replay = confirm(client, auth_headers, pid, token)
    assert replay.status_code == 200 and replay.json() == {**receipt, "replayed": True}
    with SessionLocal() as db:
        assert db.get(Task, f"{pid}-t1").planned_end == date(2026, 11, 10)
        assert db.get(Task, f"{pid}-t2").planned_end == date(2026, 11, 20)
        row = db.get(AuditLog, receipt["receipt_id"])
        assert row.actor_id == "t-admin" and row.target_id == pid
        audit = json.loads(row.detail)
        assert audit["source"]["prompt_version"] == project_schedule_assist.PROMPT_VERSION
        assert token not in row.detail and instruction not in row.detail


def test_fixed_milestone_conflict_and_unresolved_constraint_fail_closed(
    client, auth_headers, schedule_project, monkeypatch
):
    pid = schedule_project(fixed_day=6)
    set_intent(monkeypatch, delay_workdays=2, fixed_milestones=["申报"])
    result = preview(client, auth_headers, pid)
    assert result.status_code == 200, result.text
    assert result.json()["schedule"]["conflicts"][0]["task_id"] == f"{pid}-t2"
    assert result.json()["confirmation_token"] is None

    set_intent(monkeypatch, delay_workdays=2, fixed_milestones=[])
    assert preview(client, auth_headers, pid).status_code == 422
    set_intent(monkeypatch, delay_workdays=6, fixed_milestones=["申报"])
    assert (
        preview(client, auth_headers, pid, "顺延 5 个工作日，申报节点保持不动").status_code == 422
    )
    set_intent(monkeypatch, delay_workdays=2, fixed_milestones=["申报"])
    assert (
        preview(client, auth_headers, pid, "晚两个工作日，申报、验证均保持不动").status_code == 422
    )
    assert (
        preview(client, auth_headers, pid, "晚两个工作日，IND申报节点保持不动").status_code == 422
    )
    set_intent(monkeypatch, delay_workdays=2, fixed_milestones=["验证"])
    assert preview(client, auth_headers, pid, "晚两个工作日，验证节点保持不动").status_code == 422
    assert preview(client, auth_headers, pid, "晚两个自然日").status_code == 422


def test_tampered_cross_actor_expired_and_stale_confirmations_cannot_apply(
    client, auth_headers, schedule_project, iam_user, bearer, monkeypatch
):
    pid = schedule_project()
    set_intent(monkeypatch, delay_workdays=2, fixed_milestones=["申报"])
    result = preview(client, auth_headers, pid)
    assert result.status_code == 200, result.text
    token = result.json()["confirmation_token"]
    assert confirm(client, auth_headers, pid, "x" + token).status_code == 409
    alternate = bearer(iam_user("ai-schedule-admin2", "admin"), "admin")
    assert confirm(client, alternate, pid, token).status_code == 409
    with monkeypatch.context() as patch:
        patch.setattr(project_schedule_assist, "CONFIRMATION_WINDOW", timedelta(seconds=-1))
        expired = preview(client, auth_headers, pid).json()["confirmation_token"]
        assert "已过期" in confirm(client, auth_headers, pid, expired).json()["detail"]
    changed = client.put(
        f"/api/v1/planning/projects/{pid}/calendar",
        headers=auth_headers,
        json={"revision": 0, "weekdays": [1, 2, 3, 4, 5]},
    )
    assert changed.status_code == 200, changed.text
    assert confirm(client, auth_headers, pid, token).status_code == 409
    with SessionLocal() as db:
        assert db.get(Task, f"{pid}-t1").planned_end == date(2026, 11, 6)


def test_scope_checked_before_inference_and_role_rechecked_after_inference(
    client, auth_headers, schedule_project, iam_user, bearer, monkeypatch
):
    owner = iam_user("ai-schedule-owner", "project_lead")
    member = iam_user("ai-schedule-member", "project_lead")
    pid = schedule_project(owner, members=(member,))

    def blocked(*args, **kwargs):
        pytest.fail("unauthorized project data was allowed to reach inference")

    monkeypatch.setattr(ai, "chat", blocked)
    assert preview(client, bearer(member, "project_lead"), pid).status_code == 403
    assert preview(client, auth_headers, pid, task_id="not-a-project-task").status_code == 404

    def revoke_during_inference(*args, **kwargs):
        with SessionLocal() as db:
            db.get(User, owner).role = "rd"
            db.commit()
        return '{"delay_workdays": 2, "fixed_milestones": ["申报"]}', {}

    monkeypatch.setattr(ai, "chat", revoke_during_inference)
    assert preview(client, bearer(owner, "project_lead"), pid).status_code == 403


def test_inference_admission_rejects_duplicate_and_releases_slot(monkeypatch):
    monkeypatch.setattr(project_schedule_assist, "MAX_ACTIVE", 1)
    with project_schedule_assist.inference_slot("actor-1"):
        for actor in ("actor-1", "actor-2"):
            with pytest.raises(HTTPException) as blocked:
                with project_schedule_assist.inference_slot(actor):
                    pytest.fail("overlapping inference was admitted")
            assert blocked.value.status_code == 429
    with project_schedule_assist.inference_slot("actor-2"):
        pass


def test_simultaneous_confirmation_returns_one_postgresql_receipt(
    client, auth_headers, schedule_project, monkeypatch
):
    with SessionLocal() as db:
        if db.get_bind().dialect.name != "postgresql":
            pytest.skip("PostgreSQL row lock verification")
    pid = schedule_project()
    set_intent(monkeypatch, delay_workdays=2, fixed_milestones=["IND 申报"])
    reviewed = preview(client, auth_headers, pid, "延迟 2 个工作日，保持 IND 申报里程碑不动")
    assert reviewed.status_code == 200, reviewed.text
    token = reviewed.json()["confirmation_token"]
    ready = Barrier(2, timeout=10)

    def submit():
        ready.wait()
        return confirm(client, auth_headers, pid, token)

    with ThreadPoolExecutor(max_workers=2) as executor:
        pending = [executor.submit(submit) for _ in range(2)]
        results = [request.result(timeout=15) for request in pending]
    assert all(response.status_code == 200 for response in results), [r.text for r in results]
    receipts = [response.json() for response in results]
    assert sorted(receipt["replayed"] for receipt in receipts) == [False, True]
    assert len({receipt["receipt_id"] for receipt in receipts}) == 1
    with SessionLocal() as db:
        assert db.get(Task, f"{pid}-t1").planned_end == date(2026, 11, 8)
        assert (
            db.query(AuditLog)
            .filter_by(target_id=pid, action=project_schedule_assist.AUDIT_ACTION)
            .count()
            == 1
        )
