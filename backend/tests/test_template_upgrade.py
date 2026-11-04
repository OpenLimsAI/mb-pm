"""Live template upgrades preserve execution and explicit identity across partial applies."""

from copy import deepcopy
from datetime import UTC, date, datetime
from uuid import uuid4

import pytest

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
    outside = iam_user("up-owner-outside", "rd")
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


def test_executor_who_is_project_owner_remains_read_only(
    client, auth_headers, project_factory, iam_user, bearer
):
    owner = iam_user("upgrade-rd-owner", "rd")
    pid, body = setup_project(project_factory, owner=owner)
    headers = bearer(owner, "rd")
    catalog = client.get(url(pid), headers=headers)
    assert catalog.status_code == 200 and catalog.json()["editable"] is False
    assert client.post(url(pid, "preview"), json=body, headers=headers).status_code == 403
    snap = preview(client, auth_headers, pid, body)
    assert apply(client, headers, pid, body, snap).status_code == 403
    with SessionLocal() as db:
        assert db.get(Task, f"{pid}-t1").name == "测试任务 1"
        assert db.get(ProjectTemplateState, pid) is None


def test_owner_transferred_between_api_check_and_locked_apply_is_rejected(
    client, auth_headers, project_factory, iam_user, bearer, monkeypatch
):
    from app.services import template_upgrade as service

    owner = iam_user("up-transfer-owner", "project_lead")
    pid, body = setup_project(project_factory, owner=owner)
    headers = bearer(owner, "project_lead")
    snap = preview(client, headers, pid, body)
    original = service.apply

    def transfer_before_lock(db, project, request, actor):
        # Simulates another admin's committed transfer while this request waits
        # for the project's row lock. The Session initially holds the old owner.
        assert project.owner_id == owner
        with SessionLocal() as other:
            other.get(Project, pid).owner_id = "t-admin"
            other.commit()
        return original(db, project, request, actor)

    monkeypatch.setattr(service, "apply", transfer_before_lock)
    response = apply(client, headers, pid, body, snap)
    assert response.status_code == 403, response.text
    with SessionLocal() as db:
        assert db.get(Project, pid).owner_id == "t-admin"
        assert db.get(Task, f"{pid}-t1").name == "测试任务 1"
        assert db.get(ProjectTemplateState, pid) is None


def stored_case(tree, style):
    """Simulate browser recursive snakeize versus seed/Excel JSON."""
    from app.services.template_upgrade import NODE_ALIASES, PREDECESSOR_ALIASES

    result = deepcopy(tree)

    def visit(node, index=0):
        for key, snake in NODE_ALIASES.items():
            if key in node and (style == "snake" or (style == "mixed" and index % 2 == 0)):
                node[snake] = node.pop(key)
        for i, pred in enumerate(node.get("predecessors") or []):
            for key, snake in PREDECESSOR_ALIASES.items():
                if key in pred and (style == "snake" or (style == "mixed" and i % 2 == 0)):
                    pred[snake] = pred.pop(key)
        for i, child in enumerate(node.get("children") or []):
            visit(child, index + i + 1)

    visit(result)
    return result


@pytest.mark.parametrize(
    "source_style,target_style", [("snake", "camel"), ("camel", "snake"), ("mixed", "mixed")]
)
@pytest.mark.parametrize("kind", ["FS", "SS", "FF", "SF"])
def test_legacy_snake_and_camel_versions_upgrade_without_rewriting_template_json(
    client, auth_headers, project_factory, source_style, target_style, kind
):
    pid, body = setup_project(project_factory)
    with SessionLocal() as db:
        project = db.get(Project, pid)
        project.planned_start = date(2026, 1, 1)
        rows = db.query(TemplateVersion).filter_by(template_id=project.template_id).all()
        source = next(v for v in rows if v.version_number == "V1")
        target = next(v for v in rows if v.version_number == "V2")
        old = deepcopy(source.structure_json)
        new = deepcopy(old)
        node = new["children"][0]["children"][0]
        node.update(
            defaultDuration=3,
            defaultEffort=4,
            costBudget=0,
            defaultRole="上游",
            ctdSection="3.2.S",
            regulatoryRef="合成参考",
            milestoneLabel="合成节点说明",
            isCriticalPath=True,
        )
        milestone = new["children"][0]["children"][1]
        milestone.update(
            isMilestone=True,
            defaultDuration=0,
            defaultEffort=0,
            costBudget=0,
            predecessors=[{"taskCode": "T-1", "type": kind, "lagDays": 1}],
        )
        new["children"][0]["children"].append(
            {
                "id": "n3",
                "taskCode": "T-3",
                "name": "新增依赖任务",
                "defaultDuration": 2,
                "defaultEffort": 1,
                "costBudget": 0,
                "predecessors": [{"taskCode": "T-2", "type": "FS", "lagDays": 2}],
            }
        )
        source.structure_json = stored_case(old, source_style)
        target.structure_json = stored_case(new, target_style)
        before = {v.id: deepcopy(v.structure_json) for v in rows}
        first, second = db.get(Task, f"{pid}-t1"), db.get(Task, f"{pid}-t2")
        first.planned_start, first.planned_end = date(2026, 1, 1), date(2026, 1, 3)
        first.status, first.progress = "进行中", 37
        first.actual_start, first.actual_effort, first.actual_cost = date(2026, 1, 1), 3, 5
        second.planned_start, second.planned_end = date(2026, 1, 5), date(2026, 1, 9)
        db.commit()
    catalog = client.get(url(pid), headers=auth_headers)
    assert catalog.status_code == 200, catalog.text
    assert len(catalog.json()["versions"]) == 2
    snap = preview(client, auth_headers, pid, body)
    assert not snap["unmapped"]
    response = apply(client, auth_headers, pid, body, snap)
    assert response.status_code == 200, response.text
    assert response.json()["remaining"] == 0 and response.json()["template_version"] == "V2"
    with SessionLocal() as db:
        first, second = db.get(Task, f"{pid}-t1"), db.get(Task, f"{pid}-t2")
        assert first.planned_end == date(2026, 1, 4)
        assert (first.progress, float(first.actual_effort), float(first.actual_cost)) == (37, 3, 5)
        assert float(first.estimated_effort) == 4 and float(first.cost_budget) == 0
        assert (
            "3.2.S" in first.notes and "合成参考" in first.notes and "合成节点说明" in first.notes
        )
        assert second.is_milestone and second.planned_end == second.planned_start == date(
            2026, 1, 5
        )
        dep = (
            db.query(TaskDependency)
            .filter_by(predecessor_id=first.id, successor_id=second.id)
            .one()
        )
        assert (dep.type, dep.lag_days) == (kind, 1)
        added_id = db.get(ProjectTemplateState, pid).task_mapping["n3"]
        added = db.get(Task, added_id)
        # New task proposal is anchored to the existing predecessor plan so it
        # remains safe even if a user elects not to shorten that predecessor.
        assert (added.planned_start, added.planned_end) == (date(2026, 1, 11), date(2026, 1, 13))
        assert added.progress == 0 and added.actual_start is None
        assert {
            v.id: v.structure_json
            for v in db.query(TemplateVersion).filter(TemplateVersion.id.in_(before))
        } == before


@pytest.mark.parametrize(
    "camel,snake,left,right",
    [
        ("taskCode", "task_code", "T-1", "T-conflict"),
        ("defaultDuration", "default_duration", 4, 5),
        ("defaultEffort", "default_effort", 1, 2),
        ("isMilestone", "is_milestone", False, True),
        ("defaultRole", "default_role", "上游", "下游"),
        ("costBudget", "cost_budget", 0, 1),
        ("ctdSection", "ctd_section", "3.2.S", "3.2.P"),
        ("regulatoryRef", "regulatory_ref", "A", "B"),
        ("milestoneLabel", "milestone_label", "A", "B"),
        ("isCriticalPath", "is_critical_path", False, True),
    ],
)
def test_conflicting_node_aliases_rejected_without_changes(
    client, auth_headers, project_factory, camel, snake, left, right
):
    pid, body = setup_project(project_factory)
    with SessionLocal() as db:
        project = db.get(Project, pid)
        target = (
            db.query(TemplateVersion)
            .filter_by(template_id=project.template_id, version_number="V2")
            .one()
        )
        tree = deepcopy(target.structure_json)
        tree["children"][0]["children"][0].update({camel: left, snake: right})
        target.structure_json = tree
        db.commit()
    result = client.get(url(pid), headers=auth_headers)
    assert result.status_code == 422 and "冲突" in result.text
    result = client.post(url(pid, "preview"), headers=auth_headers, json=body)
    assert result.status_code == 422 and camel in result.text and snake in result.text
    with SessionLocal() as db:
        assert db.get(Task, f"{pid}-t1").name == "测试任务 1"
        assert db.get(ProjectTemplateState, pid) is None


def test_equal_aliases_normalize_on_copy_and_conflicting_predecessor_aliases_reject():
    from fastapi import HTTPException

    from app.services.template_upgrade import normalized_tree

    tree = {
        "id": "root",
        "children": [
            {
                "id": "sub",
                "children": [
                    {
                        "id": "n",
                        "taskCode": "A",
                        "task_code": "A",
                        "defaultDuration": 2,
                        "default_duration": 2,
                        "predecessors": [
                            {"taskCode": "B", "task_code": "B", "lagDays": 1, "lag_days": 1}
                        ],
                    }
                ],
            }
        ],
    }
    before = deepcopy(tree)
    result = normalized_tree(tree)
    node = result["children"][0]["children"][0]
    assert node["taskCode"] == "A" and node["defaultDuration"] == 2
    assert "task_code" not in node and "default_duration" not in node
    assert node["predecessors"] == [{"taskCode": "B", "lagDays": 1}]
    assert tree == before
    for key, value in (("task_code", "C"), ("lag_days", 2)):
        conflicted = deepcopy(tree)
        conflicted["children"][0]["children"][0]["predecessors"][0][key] = value
        with pytest.raises(HTTPException, match="冲突"):
            normalized_tree(conflicted)
    bool_number = {"id": "r", "isMilestone": True, "is_milestone": 1}
    with pytest.raises(HTTPException, match="冲突"):
        normalized_tree(bool_number)


def test_empty_old_version_and_snake_history_do_not_block_catalog(
    client, auth_headers, project_factory
):
    pid, _ = setup_project(project_factory)
    with SessionLocal() as db:
        project = db.get(Project, pid)
        for row in db.query(TemplateVersion).filter_by(template_id=project.template_id):
            row.structure_json = (
                {"id": "root", "name": "空白旧版", "children": []}
                if row.version_number == "V1"
                else stored_case(row.structure_json, "snake")
            )
        db.commit()
    result = client.get(url(pid), headers=auth_headers)
    assert result.status_code == 200, result.text
    rows = {v["version"]: v for v in result.json()["versions"]}
    assert rows["V1"]["nodes"] == [] and len(rows["V2"]["nodes"]) == 2


@pytest.mark.parametrize("damage", ["missing-code", "duplicate-code", "negative-duration"])
def test_genuinely_damaged_templates_still_rejected(client, auth_headers, project_factory, damage):
    pid, _ = setup_project(project_factory)
    with SessionLocal() as db:
        project = db.get(Project, pid)
        target = (
            db.query(TemplateVersion)
            .filter_by(template_id=project.template_id, version_number="V2")
            .one()
        )
        tree = stored_case(target.structure_json, "snake")
        nodes = tree["children"][0]["children"]
        if damage == "missing-code":
            nodes[0].pop("task_code")
        elif damage == "duplicate-code":
            nodes[0]["task_code"] = nodes[1]["task_code"]
        else:
            nodes[0]["default_duration"] = -1
        target.structure_json = tree
        db.commit()
    assert client.get(url(pid), headers=auth_headers).status_code == 422
