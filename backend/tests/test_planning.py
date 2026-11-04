"""Planning persists real calendars/capacity and applies reviewed schedules atomically."""

from datetime import date

from app.db.session import SessionLocal
from app.models import Task
from app.models.planning import ProjectCalendar, UserWeeklyCapacity
from app.services.planning import move_workdays


def schedule_fixture(pid):
    with SessionLocal() as db:
        first, second = db.get(Task, f"{pid}-t1"), db.get(Task, f"{pid}-t2")
        first.planned_start, first.planned_end = date(2026, 11, 2), date(2026, 11, 6)
        second.planned_start, second.planned_end = date(2026, 11, 6), date(2026, 11, 10)
        db.commit()


def test_calendar_roundtrip_revision_and_permissions(
    client, auth_headers, project_factory, iam_user, bearer
):
    pid = project_factory("t-admin")
    body = {
        "weekdays": [1, 2, 3, 4, 5],
        "holidays": ["2026-11-09"],
        "working_dates": ["2026-11-07"],
        "revision": 0,
    }
    path = f"/api/v1/planning/projects/{pid}/calendar"
    created = client.put(path, headers=auth_headers, json=body)
    assert created.status_code == 200, created.text
    assert created.json()["revision"] == 1
    assert next(
        row
        for row in client.get("/api/v1/planning/calendars", headers=auth_headers).json()
        if row["project_id"] == pid
    )["working_dates"] == ["2026-11-07"]
    assert client.put(path, headers=auth_headers, json=body).status_code == 409
    body["weekdays"] = []
    assert client.put(path, headers=auth_headers, json=body).status_code == 422
    employee = iam_user("planning-rd", "rd")
    assert (
        client.put(path, headers=bearer(employee, "rd"), json={**body, "weekdays": [1]}).status_code
        == 403
    )
    with SessionLocal() as db:
        db.query(ProjectCalendar).filter_by(project_id=pid).delete()
        db.commit()


def test_schedule_preview_locks_stale_and_atomic_apply(client, auth_headers, project_factory):
    pid = project_factory("t-admin")
    schedule_fixture(pid)
    prefix = f"/api/v1/planning/projects/{pid}/schedule-"
    body = {
        "task_id": f"{pid}-t1",
        "new_start": "2026-11-04",
        "new_end": "2026-11-10",
        "locked_ids": [],
    }
    preview = client.post(prefix + "preview", headers=auth_headers, json=body)
    assert preview.status_code == 200, preview.text
    result = preview.json()
    assert len(result["changes"]) == 2
    assert result["changes"][1]["new_start"] == "2026-11-10"
    with SessionLocal() as db:
        assert db.get(Task, f"{pid}-t1").planned_start == date(2026, 11, 2)
    locked = client.post(
        prefix + "preview", headers=auth_headers, json={**body, "locked_ids": [f"{pid}-t2"]}
    ).json()
    assert locked["conflicts"]
    rejected = client.post(
        prefix + "apply",
        headers=auth_headers,
        json={
            **body,
            "locked_ids": [f"{pid}-t2"],
            "fingerprint": locked["fingerprint"],
            "reason": "固定节点不可移动",
        },
    )
    assert rejected.status_code == 409
    # New calendar after preview must invalidate the entire reviewed result.
    client.put(
        f"/api/v1/planning/projects/{pid}/calendar",
        headers=auth_headers,
        json={"revision": 0, "weekdays": [1, 2, 3, 4, 5]},
    )
    assert (
        client.post(
            prefix + "apply",
            headers=auth_headers,
            json={**body, "fingerprint": result["fingerprint"], "reason": "日期变化"},
        ).status_code
        == 409
    )
    result = client.post(prefix + "preview", headers=auth_headers, json=body).json()
    applied = client.post(
        prefix + "apply",
        headers=auth_headers,
        json={**body, "fingerprint": result["fingerprint"], "reason": "外部原料延期"},
    )
    assert applied.status_code == 200, applied.text
    with SessionLocal() as db:
        assert db.get(Task, f"{pid}-t1").planned_start == date(2026, 11, 4)
        assert db.get(Task, f"{pid}-t2").planned_start == date(2026, 11, 10)
        db.query(ProjectCalendar).filter_by(project_id=pid).delete()
        db.commit()
    assert (
        client.post(
            prefix + "apply",
            headers=auth_headers,
            json={**body, "fingerprint": result["fingerprint"], "reason": "重放请求"},
        ).status_code
        == 409
    )


def test_calendar_exceptions_and_full_baseline(client, auth_headers, project_factory):
    pid = project_factory("t-admin")
    schedule_fixture(pid)
    calendar = {
        "weekdays": [1, 2, 3, 4, 5],
        "holidays": ["2026-11-09"],
        "working_dates": ["2026-11-07"],
    }
    assert move_workdays(date(2026, 11, 6), 2, calendar) == date(2026, 11, 10)
    assert move_workdays(date(2026, 11, 10), -2, calendar) == date(2026, 11, 6)
    response = client.post(
        "/api/v1/baselines",
        headers=auth_headers,
        json={"project_id": pid, "label": "完整任务基线", "reason": "锁定申报计划"},
    )
    assert response.status_code == 201, response.text
    snapshot = response.json()["snapshot"]
    assert snapshot["schemaVersion"] == 3
    assert len(snapshot["tasks"]) == 2 and len(snapshot["dependencies"]) == 1
    assert "ownerId" in snapshot["tasks"][0] and "estimatedEffort" in snapshot["tasks"][0]
    assert snapshot["calendar"]["weekdays"] == list(range(1, 8))


def test_capacity_zero_leave_and_stale_updates(client, auth_headers, iam_user):
    user_id = iam_user("planning-production", "production")
    body = {
        "user_id": user_id,
        "week_start": "2026-11-02",
        "available_hours": 40,
        "leave_hours": 8,
        "revision": 0,
    }
    path = "/api/v1/planning/capacities"
    response = client.put(path, headers=auth_headers, json=body)
    assert response.status_code == 200, response.text
    assert response.json()["leave_hours"] == 8
    assert client.put(path, headers=auth_headers, json=body).status_code == 409
    response = client.put(
        path,
        headers=auth_headers,
        json={**body, "revision": 1, "available_hours": 0, "leave_hours": 0},
    )
    assert response.status_code == 200 and response.json()["available_hours"] == 0
    assert (
        client.put(
            path, headers=auth_headers, json={**body, "revision": 2, "week_start": "2026-11-03"}
        ).status_code
        == 422
    )
    assert (
        client.put(
            path, headers=auth_headers, json={**body, "revision": 2, "leave_hours": 41}
        ).status_code
        == 422
    )
    with SessionLocal() as db:
        db.query(UserWeeklyCapacity).filter_by(user_id=user_id).delete()
        db.commit()


def test_planning_cannot_read_or_write_unrelated_project(client, bearer, iam_user, project_factory):
    lead = iam_user("planning-lead", "project_lead")
    other = iam_user("planning-other", "project_lead")
    pid = project_factory(other)
    headers = bearer(lead, "project_lead")
    body = {"task_id": f"{pid}-t1", "new_start": "2026-11-04", "new_end": "2026-11-10"}
    assert (
        client.post(
            f"/api/v1/planning/projects/{pid}/schedule-preview", headers=headers, json=body
        ).status_code
        == 404
    )
    assert (
        client.put(
            f"/api/v1/planning/projects/{pid}/calendar",
            headers=headers,
            json={"revision": 0, "weekdays": [1]},
        ).status_code
        == 404
    )
    assert (
        client.put(
            "/api/v1/planning/capacities",
            headers=headers,
            json={"user_id": other, "week_start": "2026-11-02", "available_hours": 0},
        ).status_code
        == 404
    )


def test_executor_baseline_does_not_reveal_other_tasks(
    client, auth_headers, bearer, iam_user, project_factory
):
    employee = iam_user("planning-baseline-rd", "rd")
    pid = project_factory("t-admin", member_ids=(employee,))
    with SessionLocal() as db:
        db.get(Task, f"{pid}-t2").owner_id = "t-admin"
        db.commit()
    response = client.post(
        "/api/v1/baselines", headers=auth_headers, json={"project_id": pid, "label": "权限基线"}
    )
    assert response.status_code == 201
    rows = client.get("/api/v1/baselines", headers=bearer(employee, "rd")).json()
    snapshot = next(row for row in rows if row["id"] == response.json()["id"])["snapshot"]
    assert [row["id"] for row in snapshot["tasks"]] == [f"{pid}-t1"]
    assert snapshot["dependencies"] == []


def test_schedule_dependency_types_and_cycles(client, auth_headers, project_factory):
    from app.models import TaskDependency

    pid = project_factory("t-admin")
    schedule_fixture(pid)
    prefix = f"/api/v1/planning/projects/{pid}/schedule-preview"
    body = {"task_id": f"{pid}-t1", "new_start": "2026-11-10", "new_end": "2026-11-14"}
    with SessionLocal() as db:
        edge = db.get(TaskDependency, f"{pid}-dep")
        edge.type = "SS"
        edge.lag_days = 2
        db.commit()
    result = client.post(prefix, headers=auth_headers, json=body).json()
    assert result["changes"][1]["new_start"] == "2026-11-12"
    with SessionLocal() as db:
        edge = db.get(TaskDependency, f"{pid}-dep")
        edge.type, edge.lag_days = "FF", 1
        db.commit()
    result = client.post(prefix, headers=auth_headers, json=body).json()
    assert result["changes"][1]["new_end"] == "2026-11-15"
    with SessionLocal() as db:
        edge = db.get(TaskDependency, f"{pid}-dep")
        edge.type, edge.lag_days = "SF", 3
        db.commit()
    result = client.post(prefix, headers=auth_headers, json=body).json()
    assert result["changes"][1]["new_end"] == "2026-11-13"
    with SessionLocal() as db:
        db.add(
            TaskDependency(
                id=f"{pid}-cycle",
                predecessor_id=f"{pid}-t2",
                successor_id=f"{pid}-t1",
                type="FS",
                lag_days=0,
            )
        )
        db.commit()
    assert client.post(prefix, headers=auth_headers, json=body).status_code == 422


def test_completed_nodes_and_task_revision_invalidate_review(client, auth_headers, project_factory):
    pid = project_factory("t-admin")
    schedule_fixture(pid)
    prefix = f"/api/v1/planning/projects/{pid}/schedule-"
    body = {"task_id": f"{pid}-t1", "new_start": "2026-11-04", "new_end": "2026-11-10"}
    preview = client.post(prefix + "preview", headers=auth_headers, json=body).json()
    with SessionLocal() as db:
        db.get(Task, f"{pid}-t2").status = "已完成"
        db.commit()
    stale = client.post(
        prefix + "apply",
        headers=auth_headers,
        json={**body, "fingerprint": preview["fingerprint"], "reason": "完成节点不可移动"},
    )
    assert stale.status_code == 409
    result = client.post(prefix + "preview", headers=auth_headers, json=body).json()
    assert result["conflicts"]
    assert (
        client.post(
            prefix + "preview", headers=auth_headers, json={**body, "task_id": f"{pid}-t2"}
        ).status_code
        == 422
    )
    with SessionLocal() as db:
        assert db.get(Task, f"{pid}-t1").planned_start == date(2026, 11, 2)
