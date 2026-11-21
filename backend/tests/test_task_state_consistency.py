"""All execution writers use the same status/progress contract."""

import pytest
from fastapi import HTTPException

from app.db.session import SessionLocal
from app.models import Project, Task
from app.models.task_collaboration import TaskAcceptance
from app.schemas.task import TaskCreate
from app.services.task_state import task_state_patch


def test_status_transitions_and_explicit_conflicts(client, auth_headers, project_factory):
    pid = project_factory("t-admin")
    path = f"/api/v1/tasks/{pid}-t1"
    for patch, expected in [
        ({"status": "已完成"}, ("已完成", 100)),
        ({"status": "进行中"}, ("进行中", 0)),
        ({"progress": 25}, ("进行中", 25)),
        ({"progress": 100}, ("已完成", 100)),
    ]:
        response = client.patch(path, headers=auth_headers, json=patch)
        assert response.status_code == 200, response.text
        assert (response.json()["status"], response.json()["progress"]) == expected
    bad = client.patch(path, headers=auth_headers, json={"status": "已完成", "progress": 20})
    assert bad.status_code == 422
    with SessionLocal() as db:
        task = db.get(Task, f"{pid}-t1")
        assert (task.status, task.progress) == ("已完成", 100)


def test_legacy_inconsistency_is_not_rewritten_by_notes(client, auth_headers, project_factory):
    pid = project_factory("t-admin")
    with SessionLocal() as db:
        task = db.get(Task, f"{pid}-t1")
        task.status, task.progress = "未开始", 55
        db.commit()
    response = client.patch(
        f"/api/v1/tasks/{pid}-t1", headers=auth_headers, json={"notes": "仅补充说明"}
    )
    assert response.status_code == 200
    assert (response.json()["status"], response.json()["progress"]) == ("未开始", 55)


def test_milestone_normalization_cannot_bypass_acceptance(client, auth_headers, project_factory):
    pid = project_factory("t-admin")
    path = f"/api/v1/tasks/{pid}-t1"
    with SessionLocal() as db:
        task = db.get(Task, f"{pid}-t1")
        task.is_milestone = True
        db.add(
            TaskAcceptance(task_id=task.id, reviewer_id="t-admin", state="draft", required_count=1)
        )
        db.commit()
    assert client.patch(path, headers=auth_headers, json={"status": "已验证"}).status_code == 422
    assert client.patch(path, headers=auth_headers, json={"progress": 25}).status_code == 422
    response = client.patch(path, headers=auth_headers, json={"status": "已完成"})
    assert response.status_code == 200
    assert response.json()["progress"] == 100
    with SessionLocal() as db:
        assert db.get(TaskAcceptance, f"{pid}-t1").state == "draft"


def test_create_uses_shared_rules():
    task = TaskCreate(
        code="T",
        name="T",
        owner_id="u",
        sub_project_id="s",
        planned_start="2026-01-01",
        planned_end="2026-01-01",
        status="已完成",
    )
    assert task.progress == 100
    with pytest.raises(HTTPException):
        task_state_patch(None, {"status": "未开始", "progress": 20})


def test_project_metadata_and_members_reject_stale_drafts(client, auth_headers, project_factory):
    pid = project_factory("t-admin")
    path = f"/api/v1/projects/{pid}"
    original = client.get(path, headers=auth_headers).json()
    first = client.patch(
        path,
        headers=auth_headers,
        json={"name": "第一位同事的修改", "expected_revision": original["revision"]},
    )
    assert first.status_code == 200, first.text
    assert first.json()["revision"] > original["revision"]
    stale = client.patch(
        path,
        headers=auth_headers,
        json={"name": "旧草稿", "expected_revision": original["revision"]},
    )
    assert stale.status_code == 409
    assert stale.json()["detail"]["current"]["name"] == "第一位同事的修改"
    members = first.json()["member_ids"]
    team = client.put(
        path + "/members",
        headers=auth_headers,
        params={"expected_revision": first.json()["revision"]},
        json=members,
    )
    assert team.status_code == 200, team.text
    stale_team = client.put(
        path + "/members",
        headers=auth_headers,
        params={"expected_revision": first.json()["revision"]},
        json=members,
    )
    assert stale_team.status_code == 409
    with SessionLocal() as db:
        assert db.get(Project, pid).name == "第一位同事的修改"
