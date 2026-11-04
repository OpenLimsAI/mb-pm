"""Policy previews must explain, preserve execution data, and reject stale saves."""

from decimal import Decimal

import pytest

from app.db.session import SessionLocal
from app.models import AuditLog, Project, SubProject, Task
from app.services.rollup import recompute_project, weighted_progress


def path(pid):
    return f"/api/v1/projects/{pid}/progress-policy"


def prepare(pid):
    with SessionLocal() as db:
        first, second = db.get(Task, f"{pid}-t1"), db.get(Task, f"{pid}-t2")
        first.progress, first.status, first.estimated_effort = 100, "已完成", Decimal(9)
        second.progress, second.estimated_effort = 0, Decimal(1)
        first.actual_effort, first.actual_cost, first.notes = (
            Decimal("1.30"),
            Decimal("2.70"),
            "保留执行资料",
        )
        db.commit()


def apply(client, headers, pid, body):
    preview = client.post(path(pid) + "/preview", headers=headers, json=body)
    assert preview.status_code == 200, preview.text
    result = client.put(
        path(pid),
        headers=headers,
        json={**body, "fingerprint": preview.json()["fingerprint"], "reason": "按实际投入计算"},
    )
    assert result.status_code == 200, result.text
    return result.json()


def test_effort_preview_apply_and_task_update_share_one_formula(
    client, auth_headers, project_factory
):
    pid = project_factory("t-admin")
    prepare(pid)
    response = client.get(path(pid), headers=auth_headers)
    assert response.status_code == 200, response.text
    assert response.json()["method"] == "equal"
    assert response.json()["progress"] == 50
    with SessionLocal() as db:
        assert db.get(Project, pid).progress == 0  # Reading never backfills historical values.
    result = apply(client, auth_headers, pid, {"method": "effort"})
    assert result["progress"] == 90
    assert result["numerator"] == 900 and result["denominator"] == 10
    assert sum(r["contribution"] for r in result["rows"]) == 90
    with SessionLocal() as db:
        assert db.get(Project, pid).progress == db.get(SubProject, f"{pid}-sp").progress == 90
        first = db.get(Task, f"{pid}-t1")
        assert first.actual_effort == Decimal("1.30") and first.actual_cost == Decimal("2.70")
        assert first.notes == "保留执行资料" and first.status == "已完成"
        assert db.query(AuditLog).filter_by(target_id=pid, action="修改进度计算规则").count() == 1
    changed = client.patch(f"/api/v1/tasks/{pid}-t2", headers=auth_headers, json={"progress": 50})
    assert changed.status_code == 200, changed.text
    assert client.get(f"/api/v1/projects/{pid}", headers=auth_headers).json()["progress"] == 95


def test_custom_null_zero_milestone_and_rounding(client, auth_headers, project_factory):
    pid = project_factory("t-admin")
    prepare(pid)
    result = apply(
        client,
        auth_headers,
        pid,
        {"method": "custom", "weights": [{"task_id": f"{pid}-t2", "value": 3}]},
    )
    assert result["progress"] == 25
    changed = client.patch(f"/api/v1/tasks/{pid}-t2", headers=auth_headers, json={"progress": 50})
    assert changed.status_code == 200, changed.text
    assert client.get(f"/api/v1/projects/{pid}", headers=auth_headers).json()["progress"] == 63
    result = apply(
        client,
        auth_headers,
        pid,
        {
            "method": "custom",
            "weights": [{"task_id": f"{pid}-t1", "value": 0}, {"task_id": f"{pid}-t2", "value": 0}],
        },
    )
    assert result["progress"] == result["denominator"] == 0
    with SessionLocal() as db:
        second = db.get(Task, f"{pid}-t2")
        second.is_milestone, second.progress_weight = True, None
        db.commit()
    result = apply(
        client,
        auth_headers,
        pid,
        {"method": "custom", "weights": [{"task_id": f"{pid}-t1", "value": None}]},
    )
    assert result["progress"] == 100
    assert next(r for r in result["rows"] if r["is_milestone"])["effective_weight"] == 0
    with SessionLocal() as db:
        assert db.get(Task, f"{pid}-t1").progress_weight is None


def test_stale_and_changed_requests_are_rejected_atomically(client, auth_headers, project_factory):
    pid = project_factory("t-admin")
    prepare(pid)
    body = {"method": "custom", "weights": [{"task_id": f"{pid}-t1", "value": 8}]}
    preview = client.post(path(pid) + "/preview", headers=auth_headers, json=body).json()
    payload = {**body, "fingerprint": preview["fingerprint"], "reason": "调整权重"}
    assert (
        client.put(
            path(pid), headers=auth_headers, json={**payload, "method": "effort"}
        ).status_code
        == 409
    )
    with SessionLocal() as db:
        task = db.get(Task, f"{pid}-t2")
        task.notes = "他人的最新修改"
        db.commit()
    assert client.put(path(pid), headers=auth_headers, json=payload).status_code == 409
    with SessionLocal() as db:
        assert db.get(Project, pid).progress_method == "equal"
        assert db.get(Task, f"{pid}-t1").progress_weight is None
        assert db.get(Task, f"{pid}-t2").notes == "他人的最新修改"


@pytest.mark.parametrize("value", [-1, "NaN", "Infinity", 1000000, "0.00001"])
def test_weight_validation_does_not_write(client, auth_headers, project_factory, value):
    pid = project_factory("t-admin")
    body = {"method": "custom", "weights": [{"task_id": f"{pid}-t1", "value": value}]}
    assert client.post(path(pid) + "/preview", headers=auth_headers, json=body).status_code == 422
    with SessionLocal() as db:
        assert db.get(Task, f"{pid}-t1").progress_weight is None


def test_duplicates_unknown_tasks_and_empty_reason(client, auth_headers, project_factory):
    pid = project_factory("t-admin")
    weights = [{"task_id": f"{pid}-t1", "value": 1}]
    assert (
        client.post(
            path(pid) + "/preview",
            headers=auth_headers,
            json={"method": "custom", "weights": weights * 2},
        ).status_code
        == 422
    )
    assert (
        client.post(
            path(pid) + "/preview",
            headers=auth_headers,
            json={"method": "custom", "weights": [{"task_id": "outside-project", "value": 1}]},
        ).status_code
        == 422
    )
    assert client.put(path(pid), headers=auth_headers, json={"method": "custom"}).status_code == 422


def test_scope_and_only_project_owner_can_configure(
    client, auth_headers, project_factory, iam_user, bearer
):
    owner = iam_user("progress-owner", "project_lead")
    member = iam_user("progress-executor", "rd")
    lead = iam_user("progress-member-lead", "project_lead")
    outsider = iam_user("progress-outsider", "project_lead")
    pid = project_factory(owner, (member, lead))
    with SessionLocal() as db:
        db.get(Task, f"{pid}-t2").owner_id = owner
        db.commit()
    read = client.get(path(pid), headers=bearer(member, "rd"))
    assert read.status_code == 200, read.text
    assert [r["task_id"] for r in read.json()["rows"]] == [f"{pid}-t1"]
    assert read.json()["hidden_task_count"] == 1 and not read.json()["editable"]
    body = {"method": "effort"}
    assert (
        client.post(path(pid) + "/preview", headers=bearer(member, "rd"), json=body).status_code
        == 403
    )
    assert (
        client.post(
            path(pid) + "/preview", headers=bearer(lead, "project_lead"), json=body
        ).status_code
        == 403
    )
    assert client.get(path(pid), headers=bearer(outsider, "project_lead")).status_code == 404
    assert (
        client.post(
            path(pid) + "/preview", headers=bearer(owner, "project_lead"), json=body
        ).status_code
        == 200
    )


def test_delete_weighted_tasks_and_last_subproject_recomputes_zero(
    client, auth_headers, project_factory
):
    pid = project_factory("t-admin")
    prepare(pid)
    apply(client, auth_headers, pid, {"method": "effort"})
    assert client.delete(f"/api/v1/tasks/{pid}-t1", headers=auth_headers).status_code == 204
    with SessionLocal() as db:
        assert db.get(Project, pid).progress == 0
        db.get(Task, f"{pid}-t2").progress = 100
        db.flush()
        recompute_project(db, pid)
        db.commit()
    assert client.delete(f"/api/v1/sub-projects/{pid}-sp", headers=auth_headers).status_code == 204
    with SessionLocal() as db:
        assert db.get(Project, pid).progress == 0


def test_decimal_half_rounds_like_frontend_and_milestones_have_no_effort():
    tasks = [
        Task(id="a", progress=25, estimated_effort=0, is_milestone=False),
        Task(id="b", progress=0, estimated_effort=100, is_milestone=True),
    ]
    assert weighted_progress(tasks)["progress"] == 13
    assert weighted_progress(tasks, "effort")["progress"] == 0
    assert weighted_progress(tasks, "custom")["progress"] == 25


def test_baseline_and_copy_preserve_progress_policy_and_weights(
    client, auth_headers, project_factory
):
    pid = project_factory("t-admin")
    prepare(pid)
    apply(
        client,
        auth_headers,
        pid,
        {"method": "custom", "weights": [{"task_id": f"{pid}-t2", "value": 3}]},
    )
    baseline = client.post(
        "/api/v1/baselines",
        headers=auth_headers,
        json={"project_id": pid, "label": "加权计划", "reason": "确认投入"},
    )
    assert baseline.status_code == 201, baseline.text
    snapshot = baseline.json()["snapshot"]
    assert snapshot["schemaVersion"] == 3 and snapshot["progressMethod"] == "custom"
    assert {row["id"]: row["progressWeight"] for row in snapshot["tasks"]} == {
        f"{pid}-t1": None,
        f"{pid}-t2": 3,
    }
    copied = client.post(
        f"/api/v1/projects/{pid}/copy",
        headers=auth_headers,
        json={"code": f"{pid}-copy", "name": "按投入执行的新项目"},
    )
    assert copied.status_code == 201, copied.text
    copied_id = copied.json()["id"]
    try:
        assert copied.json()["progress_method"] == "custom"
        with SessionLocal() as db:
            rows = db.query(Task).join(SubProject).filter(SubProject.project_id == copied_id).all()
            assert sorted(
                float(t.progress_weight) if t.progress_weight is not None else -1 for t in rows
            ) == [-1, 3]
            assert all(t.progress == 0 and t.actual_cost is None for t in rows)
    finally:
        assert (
            client.delete(f"/api/v1/projects/{copied_id}", headers=auth_headers).status_code == 204
        )


def test_structure_effort_change_recomputes_without_losing_custom_weights(
    client, auth_headers, project_factory
):
    pid = project_factory("t-admin")
    prepare(pid)
    apply(
        client,
        auth_headers,
        pid,
        {"method": "effort", "weights": [{"task_id": f"{pid}-t1", "value": 7}]},
    )
    endpoint = f"/api/v1/projects/{pid}/structure"
    snapshot = client.get(endpoint, headers=auth_headers).json()
    subs = []
    for sub in snapshot["sub_projects"]:
        planned = []
        for row in snapshot["tasks"]:
            if row["sub_project_id"] != sub["id"]:
                continue
            task = {
                key: row[key]
                for key in (
                    "id",
                    "code",
                    "name",
                    "is_milestone",
                    "owner_id",
                    "planned_start",
                    "planned_end",
                    "estimated_effort",
                    "cost_budget",
                    "notes",
                )
            }
            task["key"] = row["id"]
            task["predecessors"] = [
                edge["predecessor_id"]
                for edge in snapshot["dependencies"]
                if edge["successor_id"] == row["id"]
            ]
            if row["id"] == f"{pid}-t2":
                task["estimated_effort"] = 9
            planned.append(task)
        subs.append(
            {
                "id": sub["id"],
                "key": sub["id"],
                "name": sub["name"],
                "module": sub["module"],
                "stage": sub["stage"],
                "tasks": planned,
            }
        )
    saved = client.put(
        endpoint, headers=auth_headers, json={"version": snapshot["version"], "sub_projects": subs}
    )
    assert saved.status_code == 200, saved.text
    with SessionLocal() as db:
        assert db.get(Project, pid).progress == db.get(SubProject, f"{pid}-sp").progress == 50
        assert db.get(Task, f"{pid}-t1").progress_weight == 7
        assert db.get(Task, f"{pid}-t1").actual_cost == Decimal("2.70")


def test_generic_patch_cannot_override_a_weighted_aggregate(client, auth_headers, project_factory):
    pid = project_factory("t-admin")
    prepare(pid)
    apply(client, auth_headers, pid, {"method": "effort"})
    assert (
        client.patch(
            f"/api/v1/projects/{pid}", headers=auth_headers, json={"progress": 2}
        ).status_code
        == 422
    )
    assert (
        client.patch(
            f"/api/v1/sub-projects/{pid}-sp", headers=auth_headers, json={"progress": 2}
        ).status_code
        == 422
    )
    assert (
        client.patch(
            f"/api/v1/projects/{pid}", headers=auth_headers, json={"description": "保留其它编辑"}
        ).status_code
        == 200
    )
    with SessionLocal() as db:
        assert db.get(Project, pid).progress == db.get(SubProject, f"{pid}-sp").progress == 90


def test_stored_progress_is_explained_without_rewriting_legacy_rounding(
    client, auth_headers, project_factory
):
    pid = project_factory("t-admin")
    with SessionLocal() as db:
        db.get(Project, pid).progress = 22
        db.get(Task, f"{pid}-t1").progress = 45
        db.get(Task, f"{pid}-t2").progress = 0
        db.commit()
    response = client.get(path(pid), headers=auth_headers)
    assert response.status_code == 200, response.text
    assert response.json()["stored_progress"] == 22
    assert response.json()["progress"] == 23 and response.json()["exact_progress"] == 22.5
    with SessionLocal() as db:
        assert db.get(Project, pid).progress == 22
        assert db.query(AuditLog).filter_by(target_id=pid, action="修改进度计算规则").count() == 0
    preview = client.post(path(pid) + "/preview", headers=auth_headers, json={"method": "custom"})
    assert preview.status_code == 200, preview.text
    assert preview.json()["stored_progress"] == 22 and preview.json()["progress"] == 23
    result = client.put(
        path(pid),
        headers=auth_headers,
        json={
            "method": "custom",
            "fingerprint": preview.json()["fingerprint"],
            "reason": "核对后采用自定义规则",
        },
    )
    assert result.status_code == 200, result.text
    latest = client.get(path(pid), headers=auth_headers).json()
    assert latest["stored_progress"] == latest["progress"] == 23
