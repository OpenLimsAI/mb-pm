"""Business outcomes for reviewed project AI changes, including rollback and replay."""

from datetime import UTC, date, datetime, timedelta
from uuid import uuid4

import pytest

from app.core.security import seal, unseal
from app.db.session import SessionLocal
from app.models import SubProject, Task, TaskAcceptance, User
from app.models.pm_ai import PMAIRun
from app.models.pm_ai_changes import PMAIChangeReceipt
from app.models.pm_management import PMRegisterEntry
from app.services.pm_ai_context import ContextRequest, build_context


@pytest.fixture
def run_factory(live_ai_roles):
    def make(project_id, user_id="t-admin"):
        with SessionLocal() as db:
            user = db.get(User, user_id)
            request = ContextRequest(
                scenario="meeting",
                project_ids=[project_id],
                material="会议确认原料任务完成一半，并由项目负责人跟踪供应风险。",
            )
            context = build_context(db, user, request)
            run = PMAIRun(
                id=uuid4().hex,
                created_by=user.id,
                created_at=datetime.now(UTC),
                state="succeeded",
                request=request.model_dump(mode="json"),
                context=context,
                source=context["source"],
                result={"summary": "待确认建议", "findings": [], "draft_actions": []},
                usage={},
            )
            db.add(run)
            db.commit()
            return run.id

    return make


def action(project_id, **patch):
    with SessionLocal() as db:
        task = db.get(Task, f"{project_id}-t1")
        result = {
            "kind": "task_update",
            "task_id": task.id,
            "expected_revision": task.revision,
            "progress": 50,
            "reason": "根据会议确认实际进展",
            "evidence_ids": ["material:meeting"],
        }
        return {**result, **patch}


def preview(client, headers, run_id, actions):
    return client.post(
        f"/api/v1/pm-ai/runs/{run_id}/changes/preview",
        headers=headers,
        json={"actions": actions},
    )


def apply(client, headers, run_id, token):
    return client.post(
        f"/api/v1/pm-ai/runs/{run_id}/changes/apply",
        headers=headers,
        json={"confirmation_token": token},
    )


def test_reviewed_update_and_risk_apply_once(client, auth_headers, project_factory, run_factory):
    project_id = project_factory("t-admin")
    run_id = run_factory(project_id)
    commands = [
        action(project_id),
        {
            "kind": "register_create",
            "project_id": project_id,
            "register_kind": "risk",
            "title": "原料供应风险",
            "owner_id": "t-admin",
            "due_date": "2026-12-01",
            "severity": "high",
            "mitigation": "跟进备选供应商",
            "reason": "会议决定登记并跟踪",
            "evidence_ids": ["material:meeting"],
        },
    ]
    response = preview(client, auth_headers, run_id, commands)
    assert response.status_code == 200, response.text
    reviewed = response.json()
    assert reviewed["changes"][0]["before"]["progress"] == 0
    assert reviewed["changes"][0]["after"]["progress"] == 50
    with SessionLocal() as db:
        assert db.get(Task, f"{project_id}-t1").progress == 0
        assert db.query(PMRegisterEntry).filter_by(project_id=project_id).count() == 0
    result = apply(client, auth_headers, run_id, reviewed["confirmation_token"])
    assert result.status_code == 200, result.text
    receipt = result.json()
    assert receipt["verified"] is True and receipt["replayed"] is False
    assert len(receipt["results"]) == 2
    again = apply(client, auth_headers, run_id, reviewed["confirmation_token"])
    assert again.status_code == 200, again.text
    assert again.json() == {**receipt, "replayed": True}
    with SessionLocal() as db:
        assert db.get(Task, f"{project_id}-t1").progress == 50
        assert db.query(PMRegisterEntry).filter_by(project_id=project_id).count() == 1
        assert db.query(PMAIChangeReceipt).filter_by(run_id=run_id).count() == 1


def test_stale_member_blocks_entire_batch(client, auth_headers, project_factory, run_factory):
    project_id = project_factory("t-admin")
    run_id = run_factory(project_id)
    second = action(project_id, task_id=f"{project_id}-t2")
    response = preview(client, auth_headers, run_id, [action(project_id), second])
    assert response.status_code == 200, response.text
    with SessionLocal() as db:
        task = db.get(Task, f"{project_id}-t2")
        task.progress = 25
        db.commit()
    result = apply(client, auth_headers, run_id, response.json()["confirmation_token"])
    assert result.status_code == 409, result.text
    with SessionLocal() as db:
        assert db.get(Task, f"{project_id}-t1").progress == 0
        assert db.get(Task, f"{project_id}-t2").progress == 25
        assert db.query(PMAIChangeReceipt).filter_by(run_id=run_id).count() == 0


def test_failure_after_first_write_rolls_back_batch(
    client, auth_headers, project_factory, run_factory, monkeypatch
):
    from app.services import pm_ai_changes

    project_id = project_factory("t-admin")
    run_id = run_factory(project_id)
    commands = [action(project_id), action(project_id, task_id=f"{project_id}-t2")]
    reviewed = preview(client, auth_headers, run_id, commands)
    assert reviewed.status_code == 200, reviewed.text
    real_update = pm_ai_changes.apply_task_update
    calls = []

    def fail_second(*args):
        calls.append(args[2])
        if len(calls) == 2:
            raise RuntimeError("simulated failure during second write")
        return real_update(*args)

    monkeypatch.setattr(pm_ai_changes, "apply_task_update", fail_second)
    with pytest.raises(RuntimeError, match="simulated failure"):
        apply(client, auth_headers, run_id, reviewed.json()["confirmation_token"])
    with SessionLocal() as db:
        assert db.get(Task, f"{project_id}-t1").progress == 0
        assert db.get(Task, f"{project_id}-t2").progress == 0
        assert db.query(PMAIChangeReceipt).filter_by(run_id=run_id).count() == 0


def test_unknown_evidence_and_duplicate_targets_are_rejected(
    client, auth_headers, project_factory, run_factory
):
    project_id = project_factory("t-admin")
    run_id = run_factory(project_id)
    assert (
        preview(
            client, auth_headers, run_id, [action(project_id, evidence_ids=["invented"])]
        ).status_code
        == 422
    )
    one = action(project_id)
    assert preview(client, auth_headers, run_id, [one, one]).status_code == 422
    assert (
        preview(client, auth_headers, run_id, [action(project_id, status="已验证")]).status_code
        == 422
    )


def test_expired_and_other_actor_confirmations_are_rejected(
    client, auth_headers, project_factory, run_factory, iam_user, bearer
):
    project_id = project_factory("t-admin")
    run_id = run_factory(project_id)
    response = preview(client, auth_headers, run_id, [action(project_id)])
    assert response.status_code == 200, response.text
    token = response.json()["confirmation_token"]
    payload = unseal(token)
    payload["expires"] = (datetime.now(UTC) - timedelta(minutes=1)).timestamp()
    assert apply(client, auth_headers, run_id, seal(payload)).status_code == 409
    other = bearer(iam_user("pm-other-admin", "admin"), "admin")
    assert apply(client, other, run_id, token).status_code == 404
    assert apply(client, auth_headers, run_id, "tampered-" + token).status_code == 409


def test_executor_can_update_own_work_but_cannot_create_risks(
    client, project_factory, run_factory, iam_user, bearer
):
    iam_user("pm-worker", "rd")
    iam_user("pm-owner", "project_lead")
    headers = bearer("pm-worker", "rd")
    project_id = project_factory("pm-owner", member_ids=("pm-worker",), task_owner_id="pm-worker")
    run_id = run_factory(project_id, "pm-worker")
    reviewed = preview(client, headers, run_id, [action(project_id)])
    assert reviewed.status_code == 200, reviewed.text
    result = apply(client, headers, run_id, reviewed.json()["confirmation_token"])
    assert result.status_code == 200, result.text
    risk = {
        "kind": "register_create",
        "project_id": project_id,
        "register_kind": "risk",
        "title": "新风险",
        "owner_id": "pm-worker",
        "due_date": "2026-12-01",
        "reason": "会议风险",
        "evidence_ids": ["material:meeting"],
    }
    assert preview(client, headers, run_id, [risk]).status_code == 403


def test_creation_stays_in_reviewed_project(client, auth_headers, project_factory, run_factory):
    project_id = project_factory("t-admin")
    another = project_factory("t-admin")
    run_id = run_factory(project_id)
    new_task = {
        "kind": "task_create",
        "project_id": project_id,
        "sub_project_id": f"{another}-sp",
        "owner_id": "t-admin",
        "name": "跟进原料",
        "planned_start": "2026-11-10",
        "planned_end": "2026-11-12",
        "reason": "会议行动项",
        "evidence_ids": ["material:meeting"],
    }
    assert preview(client, auth_headers, run_id, [new_task]).status_code == 422
    new_task["sub_project_id"] = f"{project_id}-sp"
    reviewed = preview(client, auth_headers, run_id, [new_task])
    assert reviewed.status_code == 200, reviewed.text
    result = apply(client, auth_headers, run_id, reviewed.json()["confirmation_token"])
    assert result.status_code == 200, result.text
    with SessionLocal() as db:
        task = db.get(Task, result.json()["results"][0]["entity_id"])
        assert task.name == "跟进原料" and task.progress == 0 and task.status == "未开始"


def test_repreview_of_created_records_replays_original_receipt(
    client, auth_headers, project_factory, run_factory
):
    project_id = project_factory("t-admin")
    run_id = run_factory(project_id)
    commands = [
        {
            "kind": "task_create",
            "project_id": project_id,
            "sub_project_id": f"{project_id}-sp",
            "owner_id": "t-admin",
            "name": "检查原料交付",
            "planned_start": "2026-11-10",
            "planned_end": "2026-11-12",
            "reason": "会议行动项",
            "evidence_ids": ["material:meeting"],
        },
        {
            "kind": "register_create",
            "project_id": project_id,
            "register_kind": "risk",
            "owner_id": "t-admin",
            "title": "交付风险",
            "due_date": "2026-11-12",
            "reason": "会议行动项",
            "evidence_ids": ["material:meeting"],
        },
    ]
    first = preview(client, auth_headers, run_id, commands)
    assert first.status_code == 200, first.text
    original = apply(client, auth_headers, run_id, first.json()["confirmation_token"])
    assert original.status_code == 200, original.text
    second = preview(client, auth_headers, run_id, list(reversed(commands)))
    assert second.status_code == 200, second.text
    replay = apply(client, auth_headers, run_id, second.json()["confirmation_token"])
    assert replay.status_code == 200, replay.text
    assert replay.json() == {**original.json(), "replayed": True}
    with SessionLocal() as db:
        assert db.query(Task).filter_by(sub_project_id=f"{project_id}-sp").count() == 3
        assert db.query(PMRegisterEntry).filter_by(project_id=project_id).count() == 1
        assert db.query(PMAIChangeReceipt).filter_by(run_id=run_id).count() == 1


def test_targets_must_be_in_the_original_analysis_snapshot(
    client, auth_headers, project_factory, run_factory
):
    project_id = project_factory("t-admin")
    run_id = run_factory(project_id)
    with SessionLocal() as db:
        run = db.get(PMAIRun, run_id)
        run.context = {
            **run.context,
            "tasks": [row for row in run.context["tasks"] if row["id"] == f"{project_id}-t1"],
        }
        db.add(
            SubProject(
                id=f"{project_id}-sp2",
                project_id=project_id,
                name="稍后新增",
                stage="IND",
                module="USP",
                status="未开始",
            )
        )
        db.add(
            PMRegisterEntry(
                id=f"{project_id}-later",
                project_id=project_id,
                kind="risk",
                title="稍后登记",
                owner_id="t-admin",
                due_date=date(2026, 12, 1),
                severity="medium",
                status="open",
            )
        )
        db.commit()
    assert (
        preview(
            client, auth_headers, run_id, [action(project_id, task_id=f"{project_id}-t2")]
        ).status_code
        == 422
    )
    new_task = {
        "kind": "task_create",
        "project_id": project_id,
        "sub_project_id": f"{project_id}-sp2",
        "owner_id": "t-admin",
        "name": "新增任务",
        "planned_start": "2026-11-10",
        "planned_end": "2026-11-12",
        "reason": "会议行动项",
        "evidence_ids": ["material:meeting"],
    }
    assert preview(client, auth_headers, run_id, [new_task]).status_code == 422
    update = {
        "kind": "register_update",
        "entry_id": f"{project_id}-later",
        "expected_revision": 1,
        "status": "closed",
        "closure": "处理完成",
        "reason": "会议确认",
        "evidence_ids": ["material:meeting"],
    }
    assert preview(client, auth_headers, run_id, [update]).status_code == 422


def test_apply_uses_live_role_after_locking_project(
    client, auth_headers, project_factory, run_factory, iam_user, monkeypatch
):
    from app.services import accounts

    iam_user("pm-owner2", "project_lead")
    project_id = project_factory("pm-owner2", member_ids=("t-admin",))
    run_id = run_factory(project_id)
    command = {
        "kind": "register_create",
        "project_id": project_id,
        "register_kind": "risk",
        "title": "需要处理的风险",
        "owner_id": "pm-owner2",
        "due_date": "2026-12-01",
        "reason": "会议记录",
        "evidence_ids": ["material:meeting"],
    }
    reviewed = preview(client, auth_headers, run_id, [command])
    assert reviewed.status_code == 200, reviewed.text
    monkeypatch.setattr(accounts, "live_roles", lambda subject: ["project_lead"])
    result = apply(client, auth_headers, run_id, reviewed.json()["confirmation_token"])
    assert result.status_code == 403, result.text
    with SessionLocal() as db:
        assert db.query(PMRegisterEntry).filter_by(project_id=project_id).count() == 0


def test_accepted_task_changes_require_acceptance_again(
    client, auth_headers, project_factory, run_factory
):
    project_id = project_factory("t-admin")
    with SessionLocal() as db:
        task = db.get(Task, f"{project_id}-t1")
        task.status, task.progress = "已验证", 100
        db.add(
            TaskAcceptance(
                task_id=task.id, reviewer_id="t-admin", state="accepted", required_count=1
            )
        )
        db.commit()
    run_id = run_factory(project_id)
    response = preview(client, auth_headers, run_id, [action(project_id, notes="补充新的交付说明")])
    assert response.status_code == 200, response.text
    result = apply(client, auth_headers, run_id, response.json()["confirmation_token"])
    assert result.status_code == 200, result.text
    with SessionLocal() as db:
        task = db.get(Task, f"{project_id}-t1")
        assert task.status == "已完成"
        assert db.get(TaskAcceptance, task.id).state == "draft"
