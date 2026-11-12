import json
from datetime import UTC, date, datetime, timedelta
from uuid import uuid4

import pytest

from app.core.config import settings
from app.db.session import SessionLocal
from app.models import AuditLog, Project, ProjectAIAnalysis, Task, User
from app.models.pm_management import PMRegisterEntry
from app.models.project_ai_work import ProjectAIAction, ProjectAIJob
from app.services import ai, project_ai_jobs
from app.services.project_ai_actions import proposals


@pytest.fixture(autouse=True)
def ai_isolated(tmp_path, monkeypatch, live_ai_roles):
    monkeypatch.setattr(settings, "AI_SETTINGS_PATH", str(tmp_path / "ai.json"))


def url(pid):
    return f"/api/v1/project-ai/projects/{pid}"


def queue(client, headers, pid, **body):
    result = client.post(url(pid) + "/jobs", headers=headers, json=body)
    assert result.status_code == 202, result.text
    return result.json()


def report(pid, text="测试报告"):
    with SessionLocal() as db:
        _, source = ai.project_context(db, db.get(Project, pid))
        rid = uuid4().hex
        db.add(
            ProjectAIAnalysis(
                id=rid,
                project_id=pid,
                created_by="t-admin",
                created_at=datetime.now(UTC),
                provider="deepseek",
                model="test-model",
                focus="风险检查",
                prompt="测试提示",
                content=text,
                source=source,
                usage={},
            )
        )
        db.commit()
        return rid


def draft(pid, kind="risk"):
    return {
        "action_key": "suggestion-0",
        "kind": kind,
        "title": "核查供应商交付",
        "reason": "核对报告依据后采纳",
        "owner_id": "t-admin",
        "due_date": "2026-12-01",
        "sub_project_id": f"{pid}-sp",
        "task_id": f"{pid}-t1",
        "planned_start": "2026-07-01",
        "planned_end": "2026-07-05",
    }


def action_url(pid, rid):
    return url(pid) + f"/reports/{rid}/actions"


def review(client, headers, pid, rid, value):
    result = client.post(action_url(pid, rid) + "/preview", headers=headers, json={"draft": value})
    assert result.status_code == 200, result.text
    return result.json()


def execute(client, headers, pid, rid, value, fingerprint):
    return client.post(
        action_url(pid, rid) + "/apply",
        headers=headers,
        json={"draft": value, "fingerprint": fingerprint},
    )


def test_project_analysis_uses_milestone_completion_status_for_overdue(project_factory, admin_user):
    pid = project_factory(admin_user)
    yesterday = date.today() - timedelta(days=1)
    with SessionLocal() as db:
        milestone, ordinary = (db.get(Task, f"{pid}-t{n}") for n in (1, 2))
        for task in (milestone, ordinary):
            task.planned_start = task.planned_end = yesterday
            task.status, task.progress = "进行中", 100
        milestone.is_milestone = True
        db.commit()

        context, source = ai.project_context(db, db.get(Project, pid))
        assert context["overdue_task_ids"] == [milestone.id]
        assert source["overdue_count"] == 1


def test_background_snapshot_idempotence_and_history(
    client, auth_headers, project_factory, monkeypatch
):
    pid = project_factory("t-admin")
    first = queue(client, auth_headers, pid, focus="交付风险", prompt="按事实分析")
    assert (
        queue(client, auth_headers, pid, focus="交付风险", prompt="按事实分析")["id"] == first["id"]
    )
    assert "context" not in first and "prompt" not in first

    def analyze(cfg, context, focus, prompt):
        assert focus == "交付风险" and "pm-actions" in prompt
        assert context["tasks"][0]["progress"] == 0
        with SessionLocal() as db:
            db.get(Task, f"{pid}-t1").progress = 20
            db.commit()
        return "新报告", "deepseek", "test-model", {}

    monkeypatch.setattr(ai, "analyze", analyze)
    assert project_ai_jobs.process_one()
    rows = client.get(url(pid) + "/jobs", headers=auth_headers).json()
    assert rows[0]["state"] == "succeeded"
    rid = rows[0]["analysis_id"]
    detail = client.get(url(pid) + f"/reports/{rid}", headers=auth_headers)
    assert detail.status_code == 200 and detail.json()["stale"] is True
    assert detail.json()["content"] == "新报告"
    assert (
        client.get(url(pid) + "/history?keyword=新报告", headers=auth_headers).json()["total"] == 1
    )


def test_cancel_queued_never_calls_model(client, auth_headers, project_factory, monkeypatch):
    pid = project_factory("t-admin")
    job = queue(client, auth_headers, pid)
    monkeypatch.setattr(ai, "analyze", lambda *args: pytest.fail("cancelled job sent to model"))
    assert (
        client.post(url(pid) + f"/jobs/{job['id']}/cancel", headers=auth_headers).json()["state"]
        == "cancelled"
    )
    project_ai_jobs.process_one()
    with SessionLocal() as db:
        assert db.query(ProjectAIAnalysis).filter_by(project_id=pid).count() == 0


def test_cancel_during_generation_discards_result(
    client, auth_headers, project_factory, monkeypatch
):
    pid = project_factory("t-admin")
    job = queue(client, auth_headers, pid)

    def analyze(*args):
        with SessionLocal() as db:
            row = db.get(ProjectAIJob, job["id"])
            row.state, row.claim = "cancelled", None
            db.commit()
        return "不得保存", "deepseek", "test", {}

    monkeypatch.setattr(ai, "analyze", analyze)
    project_ai_jobs.process_one()
    with SessionLocal() as db:
        assert db.get(ProjectAIJob, job["id"]).state == "cancelled"
        assert db.query(ProjectAIAnalysis).filter_by(project_id=pid).count() == 0


def test_revoked_role_prevents_dispatch(client, auth_headers, project_factory, monkeypatch):
    pid = project_factory("t-admin")
    job = queue(client, auth_headers, pid)
    with SessionLocal() as db:
        db.get(User, "t-admin").is_active = False
        db.commit()
    monkeypatch.setattr(ai, "analyze", lambda *args: pytest.fail("revoked user dispatched"))
    try:
        project_ai_jobs.process_one()
        with SessionLocal() as db:
            assert db.get(ProjectAIJob, job["id"]).state == "failed"
    finally:
        with SessionLocal() as db:
            db.get(User, "t-admin").is_active = True
            db.commit()


def test_model_failure_and_interrupted_claim_are_explicit(
    client, auth_headers, project_factory, monkeypatch
):
    pid = project_factory("t-admin")
    job = queue(client, auth_headers, pid)
    monkeypatch.setattr(
        ai, "analyze", lambda *args: (_ for _ in ()).throw(ai.AIError("测试连接失败"))
    )
    project_ai_jobs.process_one()
    with SessionLocal() as db:
        assert db.get(ProjectAIJob, job["id"]).error == "测试连接失败"
    retry = queue(client, auth_headers, pid)
    with SessionLocal() as db:
        row = db.get(ProjectAIJob, retry["id"])
        row.state, row.started_at, row.claim = (
            "running",
            datetime.now(UTC) - timedelta(hours=1),
            "old-worker",
        )
        db.commit()
    monkeypatch.setattr(ai, "analyze", lambda *args: pytest.fail("interrupted job auto-retried"))
    project_ai_jobs.process_one()
    with SessionLocal() as db:
        row = db.get(ProjectAIJob, retry["id"])
        assert row.state == "failed" and "中断" in row.error


def test_history_paging_search_and_scope(client, auth_headers, project_factory, iam_user, bearer):
    pid = project_factory("t-admin")
    rid = report(pid, "100% 交付_风险")
    report(pid, "普通报告")
    assert (
        client.get(url(pid) + "/history?keyword=100%25", headers=auth_headers).json()["total"] == 1
    )
    assert (
        len(
            client.get(url(pid) + "/history?page=2&page_size=1", headers=auth_headers).json()[
                "items"
            ]
        )
        == 1
    )
    other = project_factory("t-admin")
    assert client.get(url(other) + f"/reports/{rid}", headers=auth_headers).status_code == 404
    lead = iam_user("ai-outsider", "project_lead")
    assert (
        client.get(url(pid) + "/history", headers=bearer(lead, "project_lead")).status_code == 404
    )
    rd = iam_user("ai-executor", "rd")
    assert client.get(url(pid) + "/jobs", headers=bearer(rd, "rd")).status_code == 403


def test_confirmed_risk_is_atomic_and_idempotent(client, auth_headers, project_factory):
    pid = project_factory("t-admin")
    value = draft(pid)
    rid = report(pid, "报告\n```pm-actions\n" + json.dumps([value]) + "\n```")
    data = client.get(action_url(pid, rid), headers=auth_headers).json()
    assert len(data["proposals"]) == 1
    preview = review(client, auth_headers, pid, rid, value)
    with SessionLocal() as db:
        assert db.query(PMRegisterEntry).filter_by(project_id=pid).count() == 0
    result = execute(client, auth_headers, pid, rid, value, preview["fingerprint"])
    assert result.status_code == 200, result.text
    replay = execute(client, auth_headers, pid, rid, value, preview["fingerprint"])
    assert replay.status_code == 200 and replay.json()["replayed"]
    with SessionLocal() as db:
        assert db.query(PMRegisterEntry).filter_by(project_id=pid).count() == 1
        assert db.query(ProjectAIAction).filter_by(analysis_id=rid).count() == 1
        assert db.query(AuditLog).filter_by(target_id=pid, action="确认执行 AI 建议").count() == 1
    value["title"] = "同一条建议不可重复创建"
    assert execute(client, auth_headers, pid, rid, value, preview["fingerprint"]).status_code == 409


def test_task_creation_validates_scope_team_and_preserves_execution(
    client, auth_headers, project_factory, iam_user
):
    pid = project_factory("t-admin")
    rid, value = report(pid), draft(pid, "task")
    outside = iam_user("ai-outside-owner", "rd")
    value["owner_id"] = outside
    assert (
        client.post(
            action_url(pid, rid) + "/preview", headers=auth_headers, json={"draft": value}
        ).status_code
        == 400
    )
    value["owner_id"] = "t-admin"
    other = project_factory("t-admin")
    value["sub_project_id"] = f"{other}-sp"
    assert (
        client.post(
            action_url(pid, rid) + "/preview", headers=auth_headers, json={"draft": value}
        ).status_code
        == 422
    )
    value["sub_project_id"] = f"{pid}-sp"
    preview = review(client, auth_headers, pid, rid, value)
    result = execute(client, auth_headers, pid, rid, value, preview["fingerprint"])
    assert result.status_code == 200, result.text
    with SessionLocal() as db:
        created = db.get(Task, result.json()["target_id"])
        assert created.status == "未开始" and created.progress == 0 and created.actual_cost is None
        assert db.get(Task, f"{pid}-t1").name == "测试任务 1"


def test_schedule_reuses_dependency_preview_and_locking(client, auth_headers, project_factory):
    pid = project_factory("t-admin")
    rid, value = report(pid), draft(pid, "schedule")
    value["locked_ids"] = [f"{pid}-t2"]
    assert (
        client.post(
            action_url(pid, rid) + "/preview", headers=auth_headers, json={"draft": value}
        ).status_code
        == 409
    )
    value["locked_ids"] = []
    preview = review(client, auth_headers, pid, rid, value)
    assert len(preview["changes"]) == 2
    result = execute(client, auth_headers, pid, rid, value, preview["fingerprint"])
    assert result.status_code == 200, result.text
    with SessionLocal() as db:
        assert str(db.get(Task, f"{pid}-t1").planned_start) == "2026-07-01"
        assert str(db.get(Task, f"{pid}-t2").planned_start) == "2026-07-05"


def test_changed_snapshot_or_draft_requires_new_preview(client, auth_headers, project_factory):
    pid = project_factory("t-admin")
    rid, value = report(pid), draft(pid)
    preview = review(client, auth_headers, pid, rid, value)
    with SessionLocal() as db:
        db.get(Task, f"{pid}-t1").progress = 11
        db.commit()
    assert execute(client, auth_headers, pid, rid, value, preview["fingerprint"]).status_code == 409
    fresh = review(client, auth_headers, pid, rid, value)
    value["reason"] = "预览后已修改"
    assert execute(client, auth_headers, pid, rid, value, fresh["fingerprint"]).status_code == 409
    with SessionLocal() as db:
        assert db.query(PMRegisterEntry).filter_by(project_id=pid).count() == 0


def test_project_lead_membership_is_not_owner_write_permission(
    client, auth_headers, project_factory, iam_user, bearer
):
    lead = iam_user("ai-member-lead", "project_lead")
    pid = project_factory("t-admin", member_ids=(lead,))
    rid = report(pid)
    headers = bearer(lead, "project_lead")
    assert client.get(url(pid) + "/history", headers=headers).status_code == 200
    assert client.post(url(pid) + "/jobs", headers=headers, json={}).status_code == 403
    assert (
        client.post(
            action_url(pid, rid) + "/preview", headers=headers, json={"draft": draft(pid)}
        ).status_code
        == 403
    )


def test_model_json_is_bounded_untrusted_proposal_only():
    assert proposals('```pm-actions\n__import__("os")\n```') == []
    assert proposals("```pm-actions\n" + "x" * 40001 + "\n```") == []
    assert proposals('```pm-actions\n[{"kind":"delete", "title":"drop"}]\n```') == []
    values = proposals(
        '```pm-actions\n[{"kind":"risk","title":"风险","owner_id":"foreign-id","execute":"yes"}]\n```'
    )
    assert values[0]["owner_id"] == "foreign-id" and "execute" not in values[0]


@pytest.mark.parametrize("during_generation", [False, True])
def test_live_role_demotion_overrides_stale_admin_catalog(
    client, auth_headers, project_factory, iam_user, monkeypatch, during_generation
):
    from app.services import accounts

    owner = iam_user("ai-current-owner", "project_lead")
    pid = project_factory(owner, member_ids=("t-admin",))
    job = queue(client, auth_headers, pid)
    calls = []

    def analyze(*args):
        calls.append(True)
        monkeypatch.setattr(accounts, "live_roles", lambda subject: {"project_lead"})
        return "权限降级后不得保存", "deepseek", "test", {}

    monkeypatch.setattr(ai, "analyze", analyze)
    if not during_generation:
        monkeypatch.setattr(accounts, "live_roles", lambda subject: {"project_lead"})
    project_ai_jobs.process_one()
    assert len(calls) == int(during_generation)
    with SessionLocal() as db:
        assert db.get(ProjectAIJob, job["id"]).state == "failed"
        assert db.get(User, "t-admin").role == "admin"  # live role never rewrites the catalogue
        assert db.query(ProjectAIAnalysis).filter_by(project_id=pid).count() == 0
    # An old admin token also cannot confirm writes after a live downgrade.
    assert client.post(url(pid) + "/jobs", headers=auth_headers, json={}).status_code == 403


def test_ai_schedule_calendar_change_invalidates_confirmation(
    client, auth_headers, project_factory
):
    from app.models.planning import ProjectCalendar

    pid = project_factory("t-admin")
    rid, value = report(pid), draft(pid, "schedule")
    preview = review(client, auth_headers, pid, rid, value)
    with SessionLocal() as db:
        db.add(
            ProjectCalendar(
                project_id=pid,
                weekdays=[1, 2, 3, 4, 5, 6, 7],
                holidays=["2030-01-01"],
                working_dates=[],
                revision=1,
            )
        )
        db.commit()
    assert execute(client, auth_headers, pid, rid, value, preview["fingerprint"]).status_code == 409
    with SessionLocal() as db:
        assert str(db.get(Task, f"{pid}-t1").planned_start) == "2026-01-01"
