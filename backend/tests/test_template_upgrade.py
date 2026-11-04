"""Live template upgrades preserve execution and explicit identity across partial applies."""

from copy import deepcopy
from datetime import UTC, date, datetime
from uuid import uuid4

from app.db.session import SessionLocal
from app.models import Project, Task, TaskDependency, Template, TemplateVersion
from app.models.task_collaboration import TaskActivity
from app.models.template_upgrade import ProjectTemplateState


def setup_project(project_factory, owner="t-admin", members=(), change=None):
    pid = project_factory(owner, members)
    template_id = f"tu-{uuid4().hex[:12]}"
    root = {
        "id": "root",
        "name": "模板",
        "children": [
            {
                "id": "s1",
                "name": "原子项目",
                "module": "USP",
                "stage": "IND",
                "children": [
                    {"id": "n1", "name": "测试任务 1", "taskCode": "T-1", "defaultDuration": 180},
                    {
                        "id": "n2",
                        "name": "测试任务 2",
                        "taskCode": "T-2",
                        "defaultDuration": 180,
                        "predecessors": [{"taskCode": "T-1", "type": "FS", "lagDays": 0}],
                    },
                ],
            }
        ],
    }
    target = deepcopy(root)
    if change:
        change(target)
    else:
        target["children"][0]["children"][0].update(name="升级任务", defaultEffort=10, costBudget=0)
    with SessionLocal() as db:
        db.add(Template(id=template_id, name="升级测试", product_type="单抗", current_version="V2"))
        db.flush()
        for number, tree in (("V1", root), ("V2", target)):
            db.add(
                TemplateVersion(
                    id=f"{template_id}-{number}",
                    template_id=template_id,
                    version_number=number,
                    structure_json=tree,
                    modified_at=datetime.now(UTC),
                    change_source="visual_edit",
                )
            )
        project = db.get(Project, pid)
        project.template_id, project.template_version = template_id, "V1"
        db.commit()
    body = {
        "source_version": "V1",
        "target_version": "V2",
        "mappings": [{"node_id": f"n{i}", "task_id": f"{pid}-t{i}"} for i in (1, 2)],
        "sub_mappings": [{"node_id": "s1", "sub_project_id": f"{pid}-sp"}],
    }
    return pid, body


def url(pid, action=""):
    return f"/api/v1/projects/{pid}/template-upgrade" + (f"/{action}" if action else "")


def preview(client, headers, pid, body):
    response = client.post(url(pid, "preview"), json=body, headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def apply(client, headers, pid, body, snap, selected=None):
    return client.post(
        url(pid, "apply"),
        json={
            **body,
            "fingerprint": snap["fingerprint"],
            "selected_ids": selected
            if selected is not None
            else [c["id"] for c in snap["changes"] if not c["blocked"]],
            "reason": "模板复核升级",
        },
        headers=headers,
    )


def test_no_name_guess_and_explicit_binding(client, auth_headers, project_factory):
    pid, body = setup_project(project_factory)
    missing = preview(client, auth_headers, pid, {**body, "mappings": [], "sub_mappings": []})
    assert len(missing["unmapped"]) == 3
    assert apply(client, auth_headers, pid, body, missing, ["task:n1:name"]).status_code == 409
    snap = preview(client, auth_headers, pid, body)
    assert not snap["unmapped"]
    assert {c["field"] for c in snap["changes"]} == {"name", "estimated_effort", "cost_budget"}


def test_partial_upgrade_preserves_pending_changes_and_execution(
    client, auth_headers, project_factory
):
    pid, body = setup_project(project_factory)
    with SessionLocal() as db:
        task = db.get(Task, f"{pid}-t1")
        task.progress, task.status, task.actual_effort, task.actual_cost = 37, "进行中", 3, 5
        task.actual_start = date(2026, 1, 2)
        db.commit()
    snap = preview(client, auth_headers, pid, body)
    response = apply(client, auth_headers, pid, body, snap, ["task:n1:name"])
    assert response.status_code == 200, response.text
    assert response.json()["remaining"] == 2
    assert response.json()["template_version"] == "V1"
    snap = preview(client, auth_headers, pid, body)
    assert {c["field"] for c in snap["changes"]} == {"estimated_effort", "cost_budget"}
    response = apply(client, auth_headers, pid, body, snap)
    assert response.status_code == 200, response.text
    assert response.json()["template_version"] == "V2"
    with SessionLocal() as db:
        task = db.get(Task, f"{pid}-t1")
        assert (
            task.progress,
            task.status,
            float(task.actual_effort),
            float(task.actual_cost),
            task.actual_start,
        ) == (37, "进行中", 3, 5, date(2026, 1, 2))
        assert float(task.cost_budget) == 0
        assert db.get(ProjectTemplateState, pid).task_mapping["n1"] == task.id
        assert db.query(TaskActivity).filter_by(task_id=task.id).count() == 2


def test_concurrent_progress_refuses_stale_upgrade(client, auth_headers, project_factory):
    pid, body = setup_project(project_factory)
    snap = preview(client, auth_headers, pid, body)
    with SessionLocal() as db:
        db.get(Task, f"{pid}-t1").progress = 25
        db.commit()
    response = apply(client, auth_headers, pid, body, snap)
    assert response.status_code == 409
    with SessionLocal() as db:
        assert db.get(Task, f"{pid}-t1").name == "测试任务 1"
        assert db.get(ProjectTemplateState, pid) is None


def test_new_sub_tasks_use_calendar_and_predecessor_and_start_unstarted(
    client, auth_headers, project_factory
):
    def change(tree):
        tree["children"].append(
            {
                "id": "s2",
                "name": "新子项目",
                "module": "DSP",
                "stage": "IND",
                "children": [
                    {
                        "id": "n3",
                        "taskCode": "T-3",
                        "name": "新增任务",
                        "defaultDuration": 3,
                        "defaultEffort": 2,
                        "predecessors": [{"taskCode": "T-1", "type": "FS", "lagDays": 1}],
                    }
                ],
            }
        )

    pid, body = setup_project(project_factory, change=change)
    snap = preview(client, auth_headers, pid, body)
    added = next(c for c in snap["changes"] if c["node_id"] == "n3")
    assert added["after"]["planned_start"] == "2026-07-01"
    response = apply(client, auth_headers, pid, body, snap)
    assert response.status_code == 200, response.text
    with SessionLocal() as db:
        state = db.get(ProjectTemplateState, pid)
        task = db.get(Task, state.task_mapping["n3"])
        assert task.status == "未开始" and task.progress == 0
        assert task.actual_start is None and task.actual_cost is None
        assert task.planned_end == date(2026, 7, 4)
        assert db.get(Project, pid).template_version == "V2"


def test_delete_protection_includes_deliveries_and_discussion(
    client, auth_headers, project_factory
):
    pid, body = setup_project(
        project_factory, change=lambda tree: tree["children"][0]["children"].pop()
    )
    with SessionLocal() as db:
        db.add(
            TaskActivity(
                id=f"ta-{uuid4().hex}",
                task_id=f"{pid}-t2",
                actor_id="t-admin",
                kind="comment",
                body="已有讨论",
                changes={},
                mention_ids=[],
            )
        )
        db.commit()
    snap = preview(client, auth_headers, pid, body)
    deletion = next(c for c in snap["changes"] if c["field"] == "delete")
    assert "讨论" in deletion["blocked"]
    response = apply(client, auth_headers, pid, body, snap, [deletion["id"]])
    assert response.status_code == 422
    with SessionLocal() as db:
        assert db.get(Task, f"{pid}-t2")


def test_dependency_cycle_is_atomic(client, auth_headers, project_factory):
    def change(tree):
        tree["children"][0]["children"][0].update(
            name="不能生效", predecessors=[{"taskCode": "T-2", "type": "FS", "lagDays": 0}]
        )

    pid, body = setup_project(project_factory, change=change)
    snap = preview(client, auth_headers, pid, body)
    response = apply(client, auth_headers, pid, body, snap)
    assert response.status_code == 422 and "循环" in response.text
    with SessionLocal() as db:
        assert db.get(Task, f"{pid}-t1").name == "测试任务 1"
        assert db.query(TaskDependency).filter_by(successor_id=f"{pid}-t1").count() == 0


def test_member_read_only_and_lead_must_own_project(
    client, auth_headers, project_factory, iam_user, bearer
):
    member, lead = iam_user("upgrade-member", "rd"), iam_user("upgrade-lead", "project_lead")
    pid, body = setup_project(project_factory, members=(member, lead))
    for uid, role in ((member, "rd"), (lead, "project_lead")):
        headers = bearer(uid, role)
        assert client.get(url(pid), headers=headers).status_code == 200
        assert client.post(url(pid, "preview"), json=body, headers=headers).status_code == 403
    outside = iam_user("upgrade-outsider", "rd")
    assert client.get(url(pid), headers=bearer(outside, "rd")).status_code == 404


def test_duplicate_binding_and_owner_outside_team_rejected(
    client, auth_headers, project_factory, iam_user
):
    pid, body = setup_project(project_factory)
    duplicate = deepcopy(body)
    duplicate["mappings"][1]["task_id"] = duplicate["mappings"][0]["task_id"]
    response = client.post(url(pid, "preview"), json=duplicate, headers=auth_headers)
    assert response.status_code == 422
    outside = iam_user("upgrade-owner-outside", "rd")
    response = client.post(
        url(pid, "preview"),
        json={**body, "owner_overrides": [{"node_id": "n1", "owner_id": outside}]},
        headers=auth_headers,
    )
    assert response.status_code == 422 and "团队" in response.text


def test_matching_target_can_advance_version_without_fabricating_changes(
    client, auth_headers, project_factory
):
    pid, body = setup_project(project_factory, change=lambda tree: None)
    snap = preview(client, auth_headers, pid, body)
    assert snap["changes"] == [] and snap["unmapped"] == []
    response = apply(client, auth_headers, pid, body, snap, [])
    assert response.status_code == 200, response.text
    assert response.json()["template_version"] == "V2"
    with SessionLocal() as db:
        assert db.get(Task, f"{pid}-t1").name == "测试任务 1"
