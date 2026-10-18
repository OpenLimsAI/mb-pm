"""项目团队规则：任务只能派给团队（负责人 + 成员）里的人；仍有任务的人不能移出团队；有任务的人自动留在团队中。"""

from uuid import uuid4

from app.db.session import SessionLocal
from app.models import ProjectMember, Task
from app.services.team import backfill_assignees


def members_of(project_id: str) -> set[str]:
    with SessionLocal() as db:
        return {m.user_id for m in db.query(ProjectMember).filter_by(project_id=project_id)}


def person(iam_user, role: str = "rd") -> str:
    return iam_user(f"tt-{uuid4().hex[:8]}", role)


def test_tasks_only_go_to_team_members(client, auth_headers, project_factory, iam_user):
    member, outsider = person(iam_user), person(iam_user)
    pid = project_factory("t-admin", member_ids=(member,))

    res = client.patch(f"/api/v1/tasks/{pid}-t1", json={"owner_id": outsider}, headers=auth_headers)
    assert res.status_code == 400 and "不在项目团队中" in res.json()["detail"]
    res = client.patch(
        f"/api/v1/tasks/{pid}-t1", json={"collaborator_ids": [outsider]}, headers=auth_headers
    )
    assert res.status_code == 400
    new = {
        "sub_project_id": f"{pid}-sp",
        "code": "T-9",
        "name": "新任务",
        "owner_id": outsider,
        "status": "未开始",
        "priority": "中",
        "planned_start": "2026-02-01",
        "planned_end": "2026-02-10",
    }
    assert client.post("/api/v1/tasks", json=new, headers=auth_headers).status_code == 400
    with SessionLocal() as db:
        assert db.get(Task, f"{pid}-t1").owner_id == member

    # 团队成员与项目负责人可以
    for owner in ("t-admin", member):
        res = client.patch(
            f"/api/v1/tasks/{pid}-t1", json={"owner_id": owner}, headers=auth_headers
        )
        assert res.status_code == 200, res.text
    assert (
        client.post(
            "/api/v1/tasks", json={**new, "owner_id": member}, headers=auth_headers
        ).status_code
        == 201
    )


def test_existing_outside_owner_is_not_blocked(client, auth_headers, project_factory, iam_user):
    """老数据中不在团队里的负责人：改其他字段不受影响。"""
    outsider = person(iam_user)
    pid = project_factory("t-admin", task_owner_id=outsider)
    res = client.patch(
        f"/api/v1/tasks/{pid}-t1",
        json={"owner_id": outsider, "cost_budget": 8},
        headers=auth_headers,
    )
    assert res.status_code == 200, res.text


def test_edit_mode_owner_must_be_in_team(client, auth_headers, project_factory, iam_user):
    member, outsider = person(iam_user), person(iam_user)
    pid = project_factory("t-admin", member_ids=(member,))
    snap = client.get(f"/api/v1/projects/{pid}/structure", headers=auth_headers).json()
    body = {
        "version": snap["version"],
        "sub_projects": [
            {
                "id": sub["id"],
                "key": sub["id"],
                "name": sub["name"],
                "module": sub["module"],
                "stage": sub["stage"],
                "tasks": [
                    {
                        "id": t["id"],
                        "key": t["id"],
                        "code": t["code"],
                        "name": t["name"],
                        "is_milestone": t["is_milestone"],
                        "owner_id": t["owner_id"],
                        "planned_start": t["planned_start"],
                        "planned_end": t["planned_end"],
                        "estimated_effort": t["estimated_effort"],
                        "cost_budget": t["cost_budget"],
                        "notes": t["notes"],
                        "predecessors": [],
                    }
                    for t in snap["tasks"]
                    if t["sub_project_id"] == sub["id"]
                ],
            }
            for sub in snap["sub_projects"]
        ],
    }
    body["sub_projects"][0]["tasks"][0]["owner_id"] = outsider
    res = client.put(f"/api/v1/projects/{pid}/structure", json=body, headers=auth_headers)
    assert res.status_code == 422 and "不在项目团队中" in res.json()["detail"]

    body["sub_projects"][0]["tasks"][0]["owner_id"] = "t-admin"
    res = client.put(f"/api/v1/projects/{pid}/structure", json=body, headers=auth_headers)
    assert res.status_code == 200, res.text


def test_people_with_tasks_cannot_leave_team(client, auth_headers, project_factory, iam_user):
    busy, idle = person(iam_user), person(iam_user)
    pid = project_factory("t-admin", member_ids=(busy, idle))  # 任务都由 busy 负责

    res = client.put(f"/api/v1/projects/{pid}/members", json=[idle], headers=auth_headers)
    assert res.status_code == 400 and "仍负责或协作本项目任务" in res.json()["detail"]
    res = client.patch(f"/api/v1/projects/{pid}", json={"member_ids": []}, headers=auth_headers)
    assert res.status_code == 400
    assert members_of(pid) == {busy, idle}

    res = client.put(f"/api/v1/projects/{pid}/members", json=[busy], headers=auth_headers)
    assert res.status_code == 200, res.text
    assert members_of(pid) == {busy}


def test_owner_change_keeps_previous_owner_with_tasks(
    client, auth_headers, project_factory, iam_user
):
    old_owner, new_owner = person(iam_user, "project_lead"), person(iam_user, "project_lead")
    pid = project_factory(old_owner)  # 任务由原负责人负责
    res = client.patch(
        f"/api/v1/projects/{pid}", json={"owner_id": new_owner}, headers=auth_headers
    )
    assert res.status_code == 200, res.text
    assert old_owner in res.json()["member_ids"]


def test_copy_with_new_owner_keeps_assignees_in_team(
    client, auth_headers, project_factory, iam_user
):
    new_owner = person(iam_user, "project_lead")
    source = project_factory("t-admin")  # 任务由原负责人 t-admin 负责
    res = client.post(
        f"/api/v1/projects/{source}/copy",
        json={"code": f"CP-{uuid4().hex[:8].upper()}", "name": "复制", "owner_id": new_owner},
        headers=auth_headers,
    )
    assert res.status_code == 201, res.text
    assert "t-admin" in res.json()["member_ids"]


def test_backfill_adds_assignees_once(client, project_factory, iam_user):
    outsider = person(iam_user)
    pid = project_factory("t-admin", task_owner_id=outsider)
    with SessionLocal() as db:
        assert backfill_assignees(db) >= 1
        assert backfill_assignees(db) == 0
    assert members_of(pid) == {outsider}
