"""Delegated changes go through review and shared transactional business rules."""

from concurrent.futures import ThreadPoolExecutor
from urllib.parse import parse_qs, urlsplit

import pytest
import test_agent_projects
from fastapi import HTTPException

from app.core.config import settings
from app.db.session import SessionLocal
from app.models import AgentProposal, AuditLog, Task, TaskDependency
from app.models.pm_management import PMRegisterEntry
from app.models.task_collaboration import TaskAcceptance, TaskActivity, TaskDeliverable
from app.services import iam_sessions, project_ai_jobs

delegated_token = test_agent_projects.delegated_token

API = "/api/v1/agent"


@pytest.fixture
def review_browser(client, monkeypatch):
    def sign_in(uid, role):
        def claims(request, db):
            if request.cookies.get("mbpm_iam_session") != "agent-proposal-browser":
                raise HTTPException(401, "Invalid browser test session")
            return {
                "sub": uid,
                "owner": settings.CASDOOR_ORG,
                "roles": [{"owner": settings.CASDOOR_ORG, "name": role}],
            }

        monkeypatch.setattr(iam_sessions, "session_claims", claims)
        client.cookies.set("mbpm_iam_session", "agent-proposal-browser")
        return {"Origin": settings.pms_origin}

    yield sign_in
    client.cookies.clear()


def review_path(project, proposal):
    return f"/api/v1/project-ai/projects/{project}/agent-proposals/{proposal['id']}"


def propose(client, project, headers, request_id, **action):
    return client.post(
        f"{API}/projects/{project}/proposals",
        headers=headers,
        json={"request_id": request_id, "reason": "测试有记录的业务变更", "action": action},
    )


def confirm(client, project, proposal, origin):
    path = review_path(project, proposal)
    review = client.get(path)
    assert review.status_code == 200, review.text
    assert review.json()["changes"] == proposal["changes"]
    return client.post(path, json={"review_key": review.json()["review_key"]}, headers=origin)


def test_simulated_schedule_changes_once_and_has_a_receipt(
    client, iam_user, delegated_token, project_factory, review_browser
):
    lead = iam_user("agent-actions-lead", "project_lead")
    other = iam_user("agent-actions-peer", "project_lead")
    project = project_factory(lead, (other,))
    agent = delegated_token(lead, "project_lead")
    start_task = f"{project}-t1"
    preview_path = f"{API}/projects/{project}/schedule-preview"
    params = {"task_id": start_task, "delay_workdays": 3}
    assert (
        client.post(
            preview_path, json=params, headers=delegated_token(other, "project_lead")
        ).status_code
        == 403
    )
    blocked = client.post(
        preview_path, json={**params, "locked_ids": [f"{project}-t2"]}, headers=agent
    ).json()
    assert blocked["conflicts"][0]["task_id"] == f"{project}-t2"
    preview = client.post(preview_path, json=params, headers=agent).json()
    assert not preview["conflicts"] and len(preview["changes"]) == 2
    draft = {"kind": "schedule", **params, "fingerprint": preview["fingerprint"]}
    response = propose(client, project, agent, "schedule-review", **draft)
    assert response.status_code == 201, response.text
    proposal = response.json()
    assert parse_qs(urlsplit(proposal["review_url"]).query)["agent_proposal"] == [proposal["id"]]
    assert propose(client, project, agent, "schedule-review", **draft).json() == proposal
    assert (
        propose(
            client, project, agent, "schedule-review", **{**draft, "delay_workdays": 4}
        ).status_code
        == 409
    )
    assert (
        client.get(
            f"{API}/proposals/{proposal['id']}", headers=delegated_token(other, "project_lead")
        ).status_code
        == 404
    )
    with SessionLocal() as db:
        assert db.get(Task, start_task).planned_end.isoformat() == "2026-06-30"
    path = review_path(project, proposal)
    origin = review_browser(lead, "project_lead")
    key = client.get(path).json()["review_key"]
    assert client.post(path, headers=agent, json={"review_key": key}).status_code == 401
    assert client.post(path, json={"review_key": key}).status_code == 403

    def apply(_):
        return client.post(path, json={"review_key": key}, headers=origin)

    with ThreadPoolExecutor(max_workers=2) as pool:
        first, second = list(pool.map(apply, range(2)))
    assert first.status_code == second.status_code == 200, [first.text, second.text]
    assert sorted([first.json()["replayed"], second.json()["replayed"]]) == [False, True]
    result = client.get(f"{API}/proposals/{proposal['id']}", headers=agent).json()
    assert result["state"] == "applied"
    receipt = result["result"]["receipt_id"]
    with SessionLocal() as db:
        assert db.get(Task, start_task).planned_end.isoformat() == "2026-07-03"
        assert db.get(AuditLog, receipt).actor_id == lead
        assert db.query(TaskActivity).filter_by(task_id=start_task).count() == 1


def test_changed_task_requires_new_review_and_cancel_does_not_apply(
    client, iam_user, delegated_token, project_factory, review_browser
):
    lead = iam_user("agent-stale-lead", "project_lead")
    executor = iam_user("agent-stale-rd", "rd")
    other = iam_user("agent-stale-other", "rd")
    project = project_factory(lead, (executor, other), task_owner_id=executor)
    agent = delegated_token(executor)
    task_id = f"{project}-t1"
    draft = {"kind": "update_progress", "task_id": task_id, "expected_revision": 1, "progress": 60}
    assert propose(client, project, delegated_token(other), "forbidden", **draft).status_code == 404
    response = propose(client, project, agent, "original", **draft)
    assert response.status_code == 201, response.text
    proposal = response.json()
    origin = review_browser(executor, "rd")
    with SessionLocal() as db:
        db.get(Task, task_id).progress = 30
        db.commit()
    assert confirm(client, project, proposal, origin).status_code == 409
    api_path = f"{API}/proposals/{proposal['id']}"
    assert client.get(api_path, headers=agent).json()["state"] == "stale"
    retry = client.post(api_path + "/retry", headers=agent, json={"request_id": "refreshed"})
    assert retry.status_code == 201, retry.text
    replacement = retry.json()
    assert replacement["changes"][0]["before"]["完成度"] == 30
    assert replacement["retried_from"] == proposal["id"]
    assert (
        client.get(f"{API}/projects/{project}/proposals", headers=agent).json()["meta"]["total"]
        == 2
    )
    applied = confirm(client, project, replacement, origin)
    assert applied.status_code == 200, applied.text
    current = applied.json()["result"]
    assert current["revision"] == 3 and current["progress"] == 60
    pending = propose(
        client, project, agent, "discard", **{**draft, "expected_revision": 3, "progress": 70}
    ).json()
    assert (
        client.post(f"{API}/proposals/{pending['id']}/cancel", headers=agent).json()["state"]
        == "cancelled"
    )
    with SessionLocal() as db:
        assert db.get(Task, task_id).progress == 60
        assert db.get(AgentProposal, pending["id"]).result is None


def test_agent_schedule_blocks_cross_project_edges_without_exposing_hidden_tasks(
    client, iam_user, delegated_token, project_factory
):
    lead = iam_user("agent-cross-lead", "project_lead")
    other = iam_user("agent-cross-other", "project_lead")
    project = project_factory(lead)
    hidden = project_factory(other)
    task_id = f"{project}-t1"
    agent = delegated_token(lead, "project_lead")
    path = f"{API}/projects/{project}/schedule-preview"
    params = {"task_id": task_id, "delay_workdays": 3}
    assert client.post(path, headers=agent, json=params).status_code == 200
    with SessionLocal() as db:
        db.add(
            TaskDependency(
                id=f"{project}-external",
                predecessor_id=f"{hidden}-t1",
                successor_id=task_id,
                type="FS",
            )
        )
        db.commit()
    blocked = client.post(path, headers=agent, json=params)
    assert blocked.status_code == 409
    assert hidden not in blocked.text and "跨项目依赖" in blocked.json()["detail"]


def test_create_assign_risk_and_submit_versioned_evidence(
    client, iam_user, delegated_token, project_factory, review_browser
):
    lead = iam_user("agent-work-lead", "project_lead")
    executor = iam_user("agent-work-rd", "rd")
    project = project_factory(lead, (executor,))
    agent = delegated_token(lead, "project_lead")
    origin = review_browser(lead, "project_lead")

    def apply(request_id, **action):
        response = propose(client, project, agent, request_id, **action)
        assert response.status_code == 201, response.text
        executed = confirm(client, project, response.json(), origin)
        assert executed.status_code == 200, executed.text
        return executed.json()["result"]

    created = apply(
        "new-task",
        kind="create_task",
        sub_project_id=f"{project}-sp",
        name="工艺确认",
        owner_id=lead,
        planned_start="2026-12-01",
        planned_end="2026-12-02",
    )
    reassigned = apply(
        "reassign",
        kind="reassign_task",
        task_id=created["task_id"],
        owner_id=executor,
        expected_revision=created["revision"],
    )
    assert reassigned["owner_id"] == executor
    risk = apply(
        "new-risk",
        kind="register_risk",
        title="等待验证",
        owner_id=lead,
        due_date="2026-12-07",
        severity="high",
        mitigation="先进行复核",
    )
    task_id = f"{project}-t1"
    with SessionLocal() as db:
        assert db.get(PMRegisterEntry, risk["risk_id"]).severity == "high"
        task = db.get(Task, task_id)
        task.is_milestone = True
        task.planned_start = task.planned_end
        db.add(TaskAcceptance(task_id=task_id, reviewer_id=executor, required_count=1))
        db.commit()
        revision = task.revision
    link = apply(
        "artifact",
        kind="attach_deliverable",
        task_id=task_id,
        expected_revision=revision,
        title="工艺报告",
        url="https://reports.example.test/1",
    )
    updated_link = apply(
        "artifact-v2",
        kind="attach_deliverable",
        task_id=task_id,
        expected_revision=revision,
        title="工艺报告",
        url="https://reports.example.test/2",
    )
    assert updated_link["version"] == 2
    with SessionLocal() as db:
        assert db.get(TaskDeliverable, link["deliverable_id"]).version == 1
    task_context = client.get(f"{API}/tasks/{task_id}", headers=agent)
    assert task_context.status_code == 200, task_context.text
    acceptance = {
        "kind": "submit_acceptance",
        "task_id": task_id,
        "expected_revision": revision,
        "expected_acceptance_updated_at": task_context.json()["acceptance"]["updated_at"],
    }
    assert (
        propose(
            client,
            project,
            agent,
            "old-artifact",
            **acceptance,
            deliverable_ids=[link["deliverable_id"]],
        ).status_code
        == 409
    )
    submitted = apply("submit", **acceptance, deliverable_ids=[updated_link["deliverable_id"]])
    assert submitted["acceptance"]["state"] == "submitted"
    assert submitted["status"] == "未开始"
    reviewer_origin = review_browser(executor, "rd")
    accepted = client.post(
        f"/api/v1/tasks/{task_id}/acceptance/actions",
        headers=reviewer_origin,
        json={"action": "accept"},
    )
    assert accepted.status_code == 200, accepted.text
    with SessionLocal() as db:
        assert db.get(Task, task_id).status == "已验证"


def test_analysis_admission_replay_consent_and_scoped_result(
    client, iam_user, delegated_token, project_factory, live_ai_roles, monkeypatch
):
    lead = iam_user("agent-analysis-lead", "project_lead")
    other = iam_user("agent-analysis-peer", "project_lead")
    project = project_factory(lead, (other,))
    agent = delegated_token(lead, "project_lead")
    base = f"{API}/projects/{project}/analysis-jobs"
    params = {"request_id": "review-schedule", "focus": "逾期任务"}
    assert client.post(base, headers=agent, json=params).status_code == 422
    assert (
        client.post(base, headers=agent, json={**params, "allow_model_processing": 1}).status_code
        == 422
    )
    params["allow_model_processing"] = True
    assert (
        client.post(base, headers=delegated_token(other, "project_lead"), json=params).status_code
        == 403
    )
    queued = client.post(base, headers=agent, json=params)
    assert queued.status_code == 202, queued.text
    path = f"{base}/{queued.json()['id']}"
    assert client.get(path + "/result", headers=agent).status_code == 409

    def analyze(config, context, focus, prompt):
        assert "finance" not in context and "latest_baseline" not in context
        assert "cost_budget" not in context["tasks"][0]
        return "计划分析完成", "deepseek", "test-model", {}

    monkeypatch.setattr(project_ai_jobs.ai, "analyze", analyze)
    assert project_ai_jobs.process_one()
    assert client.get(path, headers=agent).json()["state"] == "succeeded"
    report = client.get(path + "/result", headers=agent).json()
    assert report["content"] == "计划分析完成"
    replayed = client.post(base, headers=agent, json=params)
    assert replayed.json()["id"] == queued.json()["id"]
    assert replayed.json()["state"] == "succeeded"
    assert client.get(base, headers=agent).json()["meta"]["total"] == 1
    second = client.post(base, headers=agent, json={**params, "request_id": "cancel-this"}).json()
    second_path = f"{base}/{second['id']}"
    assert client.post(second_path + "/cancel", headers=agent).json()["state"] == "cancelled"
    restarted = client.post(
        second_path + "/retry",
        headers=agent,
        json={"request_id": "restart", "allow_model_processing": True},
    )
    assert restarted.status_code == 202, restarted.text
    assert restarted.json()["id"] != second["id"]
    assert (
        client.post(f"{base}/{restarted.json()['id']}/cancel", headers=agent).json()["state"]
        == "cancelled"
    )
