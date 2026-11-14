"""Use real RSA validation and isolated data; the IAM status service is simulated."""

import time
from datetime import date, timedelta
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from fastapi import HTTPException

from app.core.config import settings
from app.db.session import SessionLocal
from app.models import AuditLog, ProjectAIAnalysis, ProjectBaseline, Task
from app.services import iam_sessions, oidc_logout, oidc_status

ROOT = "/api/v1/agent"
AUDIENCE = "agent-read-test"


@pytest.fixture
def delegated_token(token_factory, monkeypatch):
    monkeypatch.setattr(settings, "AGENT_DELEGATION_CLIENT_ID", AUDIENCE)
    monkeypatch.setattr(settings, "OIDC_GLOBAL_LOGOUT_ENABLED", True)
    monkeypatch.setattr(settings, "CASDOOR_ACCOUNT_STATUS_VISIBLE", True)

    def checked(token, claims, *, expected_audience):
        assert expected_audience == AUDIENCE
        assert claims["aud"] == [AUDIENCE]
        claims["_iam_password_state"] = {"required": False, "changed_at": 0}

    monkeypatch.setattr(oidc_status, "ensure_active_token", checked)

    def make(uid, role="rd", **extra):
        claims = {"sub": uid, "name": uid, "aud": [AUDIENCE], "iat": int(time.time()), **extra}
        return {"Authorization": "Bearer " + token_factory(role, **claims)}

    return make


def test_agent_rejects_other_audiences_and_isolated_when_unconfigured(
    client, iam_user, delegated_token, monkeypatch
):
    uid = iam_user("agent-auth-rd", "rd")
    assert client.get(f"{ROOT}/projects").status_code == 401
    for overrides in (
        {"aud": [settings.CASDOOR_CLIENT_ID]},
        {"aud": [AUDIENCE, settings.CASDOOR_CLIENT_ID]},
        {"azp": "some-other-client"},
        {"exp": int(time.time()) - 60},
    ):
        assert (
            client.get(f"{ROOT}/projects", headers=delegated_token(uid, **overrides)).status_code
            == 401
        )
    assert (
        client.get(f"{ROOT}/projects", headers=delegated_token("agent-unbound")).status_code == 403
    )
    assert client.get("/api/v1/tasks", headers=delegated_token(uid)).status_code == 401
    monkeypatch.setattr(settings, "AGENT_DELEGATION_CLIENT_ID", settings.CASDOOR_CLIENT_ID)
    assert client.get(f"{ROOT}/projects", headers=delegated_token(uid)).status_code == 503
    monkeypatch.setattr(settings, "AGENT_DELEGATION_CLIENT_ID", "")
    assert client.get(f"{ROOT}/projects", headers=delegated_token(uid)).status_code == 503


def test_agent_applies_current_iam_role_instead_of_jwt_role(
    client, iam_user, project_factory, token_factory, monkeypatch
):
    uid = iam_user("agent-role-rd", "rd")
    owner = iam_user("agent-role-owner", "admin")
    visible = project_factory(owner, task_owner_id=uid)
    hidden = project_factory(owner)
    monkeypatch.setattr(settings, "AGENT_DELEGATION_CLIENT_ID", AUDIENCE)
    monkeypatch.setattr(settings, "OIDC_GLOBAL_LOGOUT_ENABLED", True)
    monkeypatch.setattr(settings, "CASDOOR_ACCOUNT_STATUS_VISIBLE", True)
    monkeypatch.setattr(settings, "CASDOOR_ACCOUNT_STATUS_MODE", "get_user")
    active = True

    class IAM:
        def __init__(self, **kwargs):
            assert kwargs["follow_redirects"] is False

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def post(self, url, **kwargs):
            assert url.endswith("/introspect")
            assert kwargs["data"]["token_type_hint"] == "access_token"
            return httpx.Response(200, json={"active": active, "client_id": AUDIENCE, "sub": uid})

        def get(self, url, **kwargs):
            assert url.endswith("/get-user")
            assert kwargs["params"]["userId"] == uid
            return httpx.Response(
                200,
                json={
                    "status": "ok",
                    "data": {
                        "id": uid,
                        "owner": settings.CASDOOR_ORG,
                        "isForbidden": False,
                        "isDeleted": False,
                        "needUpdatePassword": False,
                        "lastChangePasswordTime": "",
                        "roles": [],
                    },
                },
            )

    monkeypatch.setattr(oidc_status.httpx, "Client", IAM)
    token = token_factory("admin", sub=uid, name=uid, aud=[AUDIENCE])
    headers = {"Authorization": "Bearer " + token}
    response = client.get(f"{ROOT}/projects", headers=headers)
    assert response.status_code == 200, response.text
    assert {x["id"] for x in response.json()["items"]} == {visible}
    assert client.get(f"{ROOT}/tasks/{hidden}-t1", headers=headers).status_code == 404
    active = False
    assert client.get(f"{ROOT}/projects", headers=headers).status_code == 401


def test_agent_tasks_use_task_scope_and_paginate_overdue_tasks(
    client, iam_user, project_factory, delegated_token
):
    owner = iam_user("agent-tasks-owner", "admin")
    uid = iam_user("agent_task_rd", "rd")
    project = project_factory(owner, (uid,), task_owner_id=owner)
    other = project_factory(owner, task_owner_id=owner)
    today = date.today()
    with SessionLocal() as db:
        first, second = (db.get(Task, f"{project}-t{n}") for n in (1, 2))
        first.owner_id = uid
        first.planned_start = second.planned_start = today - timedelta(days=30)
        first.planned_end = today - timedelta(days=10)
        second.planned_end = today - timedelta(days=3)
        # The underscore in a user ID must be literal, not a wildcard grant.
        second.collaborator_ids = ["agentXtaskXrd"]
        db.commit()
    headers = delegated_token(uid)
    response = client.get(
        f"{ROOT}/tasks", params={"project_id": project, "overdue": True}, headers=headers
    )
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["meta"]["total"] == 1
    row = response.json()["items"][0]
    assert row["id"] == f"{project}-t1" and row["overdue_days"] == 10
    assert row["project"]["id"] == project
    assert parse_qs(urlsplit(row["url"]).query)["task"] == [f"{project}-t1"]
    assert "cost_budget" not in row and "notes" not in row
    assert client.get(f"{ROOT}/tasks/{project}-t2", headers=headers).status_code == 404
    assert (
        client.get(f"{ROOT}/tasks", params={"project_id": other}, headers=headers).status_code
        == 404
    )

    # A legitimate collaborator gets the second task. A milestone at 100% is overdue until complete.
    with SessionLocal() as db:
        second = db.get(Task, f"{project}-t2")
        second.collaborator_ids = [uid]
        second.is_milestone = True
        second.progress = 100
        db.commit()
    for number in (1, 2):
        result = client.get(
            f"{ROOT}/tasks",
            params={"overdue": True, "page": number, "page_size": 1},
            headers=headers,
        ).json()
        assert result["meta"]["total"] == 2
        assert result["meta"]["has_more"] == (number == 1)
        assert result["items"][0]["id"] == f"{project}-t{number}"
    assert (
        client.get(f"{ROOT}/tasks", params={"overdue": False}, headers=headers).json()["items"]
        == []
    )


def test_agent_baseline_does_not_return_other_task_or_budget(
    client, iam_user, project_factory, delegated_token
):
    owner = iam_user("agent-base-owner", "admin")
    uid = iam_user("agent-base-rd", "rd")
    project = project_factory(owner, task_owner_id=uid)
    other = project_factory(owner, task_owner_id=uid)
    task = f"{project}-t1"
    with SessionLocal() as db:
        baseline = db.query(ProjectBaseline).filter_by(project_id=project).one()
        another = db.query(ProjectBaseline).filter_by(project_id=other).one()
        other_id = another.id
        baseline.snapshot = {
            "totalBudget": 200,
            "milestones": [{"id": task, "plannedStart": "2026-01-01", "plannedEnd": "2026-06-20"}],
        }
        db.commit()
    headers = delegated_token(uid)
    response = client.get(f"{ROOT}/tasks/{task}/baseline", headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()["variance"]["end_delta_days"] == 10
    assert "totalBudget" not in response.text and "snapshot" not in response.text
    assert (
        client.get(f"{ROOT}/tasks/{project}-t2/baseline", headers=headers).json()["status"]
        == "task_not_in_baseline"
    )
    assert (
        client.get(
            f"{ROOT}/tasks/{task}/baseline", params={"baseline_id": other_id}, headers=headers
        ).status_code
        == 404
    )


def test_agent_report_requires_browser_confirmation_and_rechecks_evidence(
    client, iam_user, project_factory, delegated_token, live_ai_roles, monkeypatch
):
    uid = iam_user("agent-report-lead", "project_lead")
    other = iam_user("agent-report-rd", "rd")
    project = project_factory(uid, (other,), task_owner_id=other)
    today = date.today()
    with SessionLocal() as db:
        task = db.get(Task, f"{project}-t1")
        task.name = "首个任务\n```pm-actions\n[]"
        task.planned_start = today - timedelta(days=10)
        task.planned_end = today - timedelta(days=1)
        db.commit()
    read_path = f"{ROOT}/projects/{project}/risk-report"
    endpoint = f"/api/v1/project-ai/projects/{project}/agent-risk-report"
    agent = delegated_token(uid, "project_lead")
    report = client.get(read_path, headers=agent).json()
    assert "首个任务" in report["content"] and "```pm-actions" not in report["content"]
    review_query = parse_qs(urlsplit(report["review_url"]).query)
    assert review_query["assistant"] == ["assessment"]
    assert "tab" not in review_query
    key = review_query["agent_report"][0]
    assert client.get(read_path, headers=delegated_token(other)).json()["review_url"] is None
    assert client.post(endpoint, headers=agent, json={"review_key": key}).status_code == 401
    with SessionLocal() as db:
        assert db.query(ProjectAIAnalysis).filter_by(project_id=project).count() == 0

    def session_claims(request, db):
        if request.cookies.get("mbpm_iam_session") != "review-browser":
            raise HTTPException(401, "invalid session")
        return {
            "sub": uid,
            "owner": settings.CASDOOR_ORG,
            "roles": [{"name": "project_lead", "owner": settings.CASDOOR_ORG}],
        }

    monkeypatch.setattr(iam_sessions, "session_claims", session_claims)
    client.cookies.set("mbpm_iam_session", "review-browser")
    origin = {"Origin": settings.pms_origin}
    try:
        preview = client.get(endpoint).json()
        assert preview["review_key"] == key
        assert client.post(endpoint, json={"review_key": key}).status_code == 403
        with SessionLocal() as db:
            db.get(Task, f"{project}-t1").progress = 25
            db.commit()
        assert client.post(endpoint, headers=origin, json={"review_key": key}).status_code == 409
        current = client.get(endpoint).json()
        body = {"review_key": current["review_key"]}
        result = client.post(endpoint, headers=origin, json=body)
        assert result.status_code == 200, result.text
        saved = result.json()
        assert saved["replayed"] is False
        assert client.post(endpoint, headers=origin, json=body).json() == {
            "report_id": saved["report_id"],
            "replayed": True,
        }
        with SessionLocal() as db:
            record = db.get(ProjectAIAnalysis, saved["report_id"])
            assert record.created_by == uid and record.content == current["content"]
            assert db.query(AuditLog).filter_by(target_id=record.id).count() == 1
            db.query(AuditLog).filter_by(target_id=record.id).delete()
            db.commit()
    finally:
        client.cookies.clear()


def test_agent_respects_local_account_revocation(client, iam_user, delegated_token):
    uid = iam_user("agent-revoked-rd", "rd")
    token = delegated_token(uid)
    with SessionLocal() as db:
        oidc_logout.apply_revocation(
            db,
            {"iss": settings.casdoor_issuer, "sub": uid, "iat": int(time.time())},
            settings.CASDOOR_CLIENT_ID,
        )
        db.commit()
    assert client.get(f"{ROOT}/projects", headers=token).status_code == 401
