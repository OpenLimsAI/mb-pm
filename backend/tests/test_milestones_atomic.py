from uuid import uuid4

from fastapi import HTTPException

from app.api.v1 import milestones
from app.db.session import SessionLocal
from app.models import AuditLog, Task, TaskDependency
from app.models.task_collaboration import TaskAcceptance


def draft(pid, **values):
    return {
        "request_id": str(uuid4()),
        "operation": "create",
        "project_id": pid,
        "sub_project_id": f"{pid}-sp",
        "name": "审核节点",
        "planned_end": "2026-12-01",
        "predecessor_ids": [f"{pid}-t1"],
        **values,
    }


def current(task_id):
    with SessionLocal() as db:
        task = db.get(Task, task_id)
        deps = (
            db.query(TaskDependency)
            .filter(
                (TaskDependency.predecessor_id == task_id)
                | (TaskDependency.successor_id == task_id)
            )
            .all()
        )
        return {
            "expected_revision": task.revision,
            "expected_dependencies": milestones.dependency_snapshot(deps),
        }


def save(client, headers, body):
    return client.post("/api/v1/milestones/atomic", headers=headers, json=body)


def test_atomic_create_retries_and_changed_replay(client, auth_headers, project_factory):
    pid = project_factory("t-admin")
    body = draft(pid)
    response = save(client, auth_headers, body)
    assert response.status_code == 200, response.text
    tid = response.json()["task_id"]
    retry = save(client, auth_headers, body)
    assert retry.status_code == 200 and retry.json()["replayed"]
    assert retry.json()["task_id"] == tid
    assert save(client, auth_headers, {**body, "name": "不同内容"}).status_code == 409
    with SessionLocal() as db:
        assert db.query(Task).filter_by(sub_project_id=f"{pid}-sp").count() == 3
        assert db.query(TaskDependency).filter_by(successor_id=tid).count() == 1
        assert db.query(AuditLog).filter_by(target_id=tid, action="里程碑原子保存").count() == 1


def test_create_rolls_back_even_after_task_flush(
    client, auth_headers, project_factory, monkeypatch
):
    pid = project_factory("t-admin")

    def fail(*args, **kwargs):
        raise HTTPException(422, "合成保存中断")

    monkeypatch.setattr(milestones, "record_activity", fail)
    response = save(client, auth_headers, draft(pid))
    assert response.status_code == 422
    with SessionLocal() as db:
        assert db.query(Task).filter_by(sub_project_id=f"{pid}-sp").count() == 2
        assert db.query(TaskDependency).filter_by(predecessor_id=f"{pid}-t1").count() == 1


def test_atomic_update_preserves_edge_and_checks_snapshot(client, auth_headers, project_factory):
    pid = project_factory("t-admin")
    tid = save(client, auth_headers, draft(pid)).json()["task_id"]
    with SessionLocal() as db:
        edge = db.query(TaskDependency).filter_by(successor_id=tid).one()
        edge.type, edge.lag_days = "FF", 3
        db.commit()
    body = draft(pid, operation="update", task_id=tid, **current(tid))
    body["predecessor_ids"] = [f"{pid}-t1", f"{pid}-t2"]
    response = save(client, auth_headers, body)
    assert response.status_code == 200, response.text
    assert save(client, auth_headers, body).json()["replayed"]
    assert save(client, auth_headers, {**body, "request_id": str(uuid4())}).status_code == 409
    with SessionLocal() as db:
        edge = (
            db.query(TaskDependency).filter_by(successor_id=tid, predecessor_id=f"{pid}-t1").one()
        )
        assert (edge.type, edge.lag_days) == ("FF", 3)
        assert db.query(TaskDependency).filter_by(successor_id=tid).count() == 2


def test_dependency_only_change_requires_acceptance_again(client, auth_headers, project_factory):
    pid = project_factory("t-admin")
    tid = save(client, auth_headers, draft(pid)).json()["task_id"]
    with SessionLocal() as db:
        task = db.get(Task, tid)
        task.status, task.progress = "已验证", 100
        db.add(
            TaskAcceptance(task_id=tid, reviewer_id="t-admin", required_count=0, state="accepted")
        )
        db.commit()
    body = draft(
        pid, operation="update", task_id=tid, predecessor_ids=[f"{pid}-t2"], **current(tid)
    )
    response = save(client, auth_headers, body)
    assert response.status_code == 200, response.text
    with SessionLocal() as db:
        assert db.get(TaskAcceptance, tid).state == "draft"
        assert db.get(Task, tid).status == "已完成"


def test_atomic_delete_and_retry(client, auth_headers, project_factory):
    pid = project_factory("t-admin")
    tid = save(client, auth_headers, draft(pid)).json()["task_id"]
    body = {
        "request_id": str(uuid4()),
        "operation": "delete",
        "project_id": pid,
        "task_id": tid,
        **current(tid),
    }
    response = save(client, auth_headers, body)
    assert response.status_code == 200 and response.json()["removed_dependencies"] == 1
    assert save(client, auth_headers, body).json()["replayed"]
    with SessionLocal() as db:
        assert db.get(Task, tid) is None
        assert not db.query(TaskDependency).filter_by(successor_id=tid).count()


def test_atomic_scope_and_missing_predecessor(
    client, auth_headers, project_factory, iam_user, bearer
):
    lead = iam_user("atomic-lead", "project_lead")
    own = project_factory(lead)
    other = project_factory("t-admin")
    assert save(client, bearer(lead, "project_lead"), draft(other)).status_code == 404
    assert (
        save(
            client, bearer(lead, "project_lead"), draft(own, predecessor_ids=[f"{other}-t1"])
        ).status_code
        == 404
    )
    assert save(client, auth_headers, draft(own, predecessor_ids=["missing"])).status_code == 422
    rd = iam_user("atomic-rd", "rd")
    assert save(client, bearer(rd, "rd"), draft(own)).status_code == 403


def test_snapshot_detects_dependency_edit_without_task_revision(
    client, auth_headers, project_factory
):
    pid = project_factory("t-admin")
    tid = save(client, auth_headers, draft(pid)).json()["task_id"]
    body = draft(pid, operation="update", task_id=tid, **current(tid))
    with SessionLocal() as db:
        db.query(TaskDependency).filter_by(successor_id=tid).one().lag_days = 7
        db.commit()
    assert save(client, auth_headers, body).status_code == 409


def test_update_failure_rolls_back_fields_and_dependencies(
    client, auth_headers, project_factory, monkeypatch
):
    pid = project_factory("t-admin")
    tid = save(client, auth_headers, draft(pid)).json()["task_id"]
    body = draft(
        pid,
        operation="update",
        task_id=tid,
        name="不应保留的名称",
        predecessor_ids=[f"{pid}-t2"],
        **current(tid),
    )

    def fail(*args, **kwargs):
        raise HTTPException(422, "合成依赖记录失败")

    monkeypatch.setattr(milestones, "record_activity", fail)
    assert save(client, auth_headers, body).status_code == 422
    with SessionLocal() as db:
        assert db.get(Task, tid).name == "审核节点"
        assert (
            db.query(TaskDependency).filter_by(successor_id=tid).one().predecessor_id == f"{pid}-t1"
        )


def test_edit_preserves_invisible_dependencies_and_delete_requires_scope(
    client, auth_headers, project_factory, iam_user, bearer
):
    lead = iam_user("atomic-external-lead", "project_lead")
    own, outside = project_factory(lead), project_factory("t-admin")
    tid = save(client, auth_headers, draft(own)).json()["task_id"]
    with SessionLocal() as db:
        db.add_all(
            [
                TaskDependency(
                    id=f"{outside}-incoming",
                    predecessor_id=f"{outside}-t1",
                    successor_id=tid,
                    type="FF",
                    lag_days=2,
                ),
                TaskDependency(
                    id=f"{outside}-outgoing",
                    predecessor_id=tid,
                    successor_id=f"{outside}-t2",
                    type="FS",
                    lag_days=1,
                ),
            ]
        )
        db.commit()

    headers = bearer(lead, "project_lead")

    def visible_state():
        response = client.get(f"/api/v1/task-dependencies?task_id={tid}", headers=headers)
        assert response.status_code == 200, response.text
        dependencies = response.json()
        assert len(dependencies) == 1
        return {
            "expected_revision": current(tid)["expected_revision"],
            "expected_dependencies": [
                (
                    row["id"],
                    row["predecessor_id"],
                    row["successor_id"],
                    row["type"],
                    row["lag_days"],
                )
                for row in dependencies
            ],
        }

    body = draft(
        own,
        operation="update",
        task_id=tid,
        name="更新后的名称",
        predecessor_ids=[f"{own}-t2"],
        **visible_state(),
    )
    response = save(client, headers, body)
    assert response.status_code == 200, response.text
    deletion = save(
        client,
        headers,
        {
            "request_id": str(uuid4()),
            "operation": "delete",
            "project_id": own,
            "task_id": tid,
            **visible_state(),
        },
    )
    assert deletion.status_code == 409, deletion.text
    assert "权限" in deletion.json()["detail"]
    with SessionLocal() as db:
        incoming = db.get(TaskDependency, f"{outside}-incoming")
        outgoing = db.get(TaskDependency, f"{outside}-outgoing")
        assert (incoming.type, incoming.lag_days) == ("FF", 2)
        assert (outgoing.type, outgoing.lag_days) == ("FS", 1)
        assert db.get(Task, tid).name == "更新后的名称"
        assert {
            row.predecessor_id for row in db.query(TaskDependency).filter_by(successor_id=tid)
        } == {f"{outside}-t1", f"{own}-t2"}
