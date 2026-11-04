"""Real scoped management data and personal inbox; no double-counted costs."""

from datetime import UTC, date, datetime, timedelta
from uuid import uuid4

import pytest

from app.db.session import SessionLocal
from app.models import Task
from app.models.pm_management import PMNotificationPreference
from app.models.task_collaboration import TaskAcceptance, TaskActivity


@pytest.fixture
def setup(project_factory, admin_user, iam_user, bearer, auth_headers):
    member = iam_user(f"pm-member-{uuid4().hex[:8]}", "rd")
    outsider = iam_user(f"pm-other-{uuid4().hex[:8]}", "rd")
    pid = project_factory(admin_user, (member,))
    return pid, member, outsider, bearer(member, "rd"), bearer(outsider, "rd"), auth_headers


def risk(owner, **kwargs):
    return {
        "kind": "risk",
        "title": "关键试验外部依赖",
        "owner_id": owner,
        "due_date": date.today().isoformat(),
        "mitigation": "确认CRO档期",
        **kwargs,
    }


def cost(**kwargs):
    return {
        "kind": "actual",
        "title": "分析检测",
        "category": "CRO",
        "amount": 7,
        "occurred_on": date.today().isoformat(),
        **kwargs,
    }


def test_register_permissions_closure_and_revision(client, setup):
    pid, member, outsider, member_headers, outsider_headers, admin = setup
    path = f"/api/v1/pm/projects/{pid}/register"
    assert client.get(path).status_code == 401
    assert client.get(path, headers=outsider_headers).status_code == 404
    assert client.post(path, json=risk(member), headers=member_headers).status_code == 403
    assert client.post(path, json=risk(outsider), headers=admin).status_code == 422
    assert client.post(path, json=risk(member, status="closed"), headers=admin).status_code == 422
    response = client.post(path, json=risk(member), headers=admin)
    assert response.status_code == 201, response.text
    row = response.json()
    assert row["revision"] == 1
    assert client.get(path, headers=member_headers).json()[0]["id"] == row["id"]
    payload = risk(member, status="closed", closure="已落实合同和试验档期", expected_revision=1)
    updated = client.put(f"{path}/{row['id']}", json=payload, headers=admin)
    assert updated.status_code == 200, updated.text
    assert updated.json()["revision"] == 2
    assert client.put(f"{path}/{row['id']}", json=payload, headers=admin).status_code == 409


def test_cost_reconciliation_forecast_and_validation(client, setup, project_factory, admin_user):
    pid, _, _, member_headers, outsider_headers, admin = setup
    path = f"/api/v1/pm/projects/{pid}/costs"
    with SessionLocal() as db:
        db.get(Task, f"{pid}-t1").actual_cost = 7
        db.commit()
    assert client.post(path, json=cost(), headers=member_headers).status_code == 403
    assert client.get(path, headers=outsider_headers).status_code == 404
    assert client.post(path, json=cost(amount=0), headers=admin).status_code == 422
    assert (
        client.post(path, json=cost(evidence_url="javascript:alert(1)"), headers=admin).status_code
        == 422
    )
    other = project_factory(admin_user)
    assert client.post(path, json=cost(task_id=f"{other}-t1"), headers=admin).status_code == 422
    actual = client.post(path, json=cost(task_id=f"{pid}-t1"), headers=admin)
    assert actual.status_code == 201, actual.text
    for kind, amount in (("payment", 5), ("remaining", 3)):
        assert (
            client.post(path, json=cost(kind=kind, amount=amount), headers=admin).status_code == 201
        )
    data = client.get(path, headers=admin).json()
    assert data["spent"] == 7 and data["recorded_actual"] == 7
    assert data["unreconciled"] == 0 and data["forecast"] == 15
    row = actual.json()
    assert (
        client.put(
            f"{path}/{row['id']}", json=cost(amount=6, expected_revision=1), headers=admin
        ).status_code
        == 200
    )
    assert (
        client.put(f"{path}/{row['id']}", json=cost(expected_revision=1), headers=admin).status_code
        == 409
    )


def test_quality_zero_not_missing_and_resolution(client, setup):
    pid, _, _, member_headers, _, admin = setup
    path = f"/api/v1/pm/projects/{pid}/quality"
    with SessionLocal() as db:
        task = db.get(Task, f"{pid}-t1")
        task.status, task.actual_cost, task.cost_budget = "已完成", 0, 0
        db.commit()
    rows = client.get(path, headers=member_headers).json()["items"]
    assert [row["reason"] for row in rows if row["task_id"] == f"{pid}-t1"] == [
        "已完成但未填实际结束日期"
    ]
    with SessionLocal() as db:
        db.get(Task, f"{pid}-t1").actual_end = date.today()
        db.commit()
    assert not any(
        row["task_id"] == f"{pid}-t1" for row in client.get(path, headers=admin).json()["items"]
    )


def test_weekly_changes_real_events_and_scope(client, setup, project_factory, admin_user):
    pid, member, _, member_headers, outsider_headers, admin = setup
    path = f"/api/v1/pm/projects/{pid}/changes"
    other = project_factory(admin_user)
    with SessionLocal() as db:
        for task_id, body, days in (
            (f"{pid}-t1", "真实更新", 0),
            (f"{pid}-t2", "十天前记录", 10),
            (f"{other}-t1", "不可泄露", 0),
        ):
            db.add(
                TaskActivity(
                    id=f"ta-{uuid4().hex}",
                    task_id=task_id,
                    actor_id=member,
                    kind="change",
                    body=body,
                    changes={"planned_end": {"before": "2026-01-01", "after": "2026-01-03"}},
                    created_at=datetime.now(UTC) - timedelta(days=days),
                )
            )
        db.commit()
    assert client.get(path, headers=outsider_headers).status_code == 404
    rows = client.get(path, headers=member_headers).json()["items"]
    assert [row["detail"] for row in rows] == ["真实更新"]
    assert rows[0]["changes"]["planned_end"]["after"] == "2026-01-03"
    assert client.get(path, headers=admin).json()["summary"]["delayed"] == 1
    assert len(client.get(path + "?days=30", headers=admin).json()["items"]) == 2


def test_personal_notification_state_mentions_review_and_dedup(client, setup, admin_user):
    pid, member, _, member_headers, outsider_headers, _ = setup
    path = "/api/v1/pm/notifications"
    with SessionLocal() as db:
        task = db.get(Task, f"{pid}-t1")
        task.planned_end = date.today() + timedelta(days=2)
        db.add(
            TaskActivity(
                id=f"ta-{uuid4().hex}",
                task_id=task.id,
                actor_id=admin_user,
                kind="comment",
                body="请核实实验结果",
                mention_ids=[member],
                created_at=datetime.now(UTC),
            )
        )
        db.add(
            TaskAcceptance(
                task_id=task.id,
                reviewer_id=member,
                state="submitted",
                updated_at=datetime.now(UTC),
            )
        )
        db.commit()
    response = client.get(path, headers=member_headers)
    assert response.status_code == 200, response.text
    data = response.json()
    keys = [item["key"] for item in data["items"]]
    assert len(keys) == len(set(keys))
    assert {"assignment", "due", "mention", "acceptance"}.issubset(
        {item["kind"] for item in data["items"]}
    )
    assert client.get(path, headers=outsider_headers).json()["items"] == []
    state = {"event_keys": [keys[0]], "action": "read"}
    assert client.post(path + "/state", json=state, headers=outsider_headers).status_code == 422
    assert client.post(path + "/state", json=state, headers=member_headers).status_code == 200
    assert next(
        item
        for item in client.get(path, headers=member_headers).json()["items"]
        if item["key"] == keys[0]
    )["read"]
    assert (
        client.post(
            path + "/state", json={**state, "action": "snooze"}, headers=member_headers
        ).status_code
        == 200
    )
    assert keys[0] not in [
        item["key"] for item in client.get(path, headers=member_headers).json()["items"]
    ]
    assert (
        client.put(
            path + "/preferences", json={"mode": "paused"}, headers=member_headers
        ).status_code
        == 200
    )
    paused = client.get(path, headers=member_headers).json()
    assert paused["mode"] == "paused" and paused["badge_count"] == 0


def test_daily_digest_frozen_and_reassignment_creates_new_event(client, setup, admin_user):
    pid, member, _, member_headers, _, _ = setup
    path = "/api/v1/pm/notifications"
    assert (
        client.put(
            path + "/preferences", json={"mode": "daily"}, headers=member_headers
        ).status_code
        == 200
    )
    first = client.get(path, headers=member_headers).json()
    assert first["badge_count"] == 1 and first["digest_keys"]
    assert (
        client.post(
            path + "/state",
            json={"event_keys": first["digest_keys"], "action": "read"},
            headers=member_headers,
        ).status_code
        == 200
    )
    activity_id = f"ta-{uuid4().hex}"
    with SessionLocal() as db:
        db.add(
            TaskActivity(
                id=activity_id,
                task_id=f"{pid}-t1",
                actor_id=admin_user,
                kind="change",
                changes={"owner_id": {"before": admin_user, "after": member}},
                created_at=datetime.now(UTC),
            )
        )
        db.commit()
    second = client.get(path, headers=member_headers).json()
    assert second["digest_keys"] == first["digest_keys"] and second["badge_count"] == 0
    assert any(item["key"].endswith(activity_id) and not item["read"] for item in second["items"])
    with SessionLocal() as db:
        db.get(PMNotificationPreference, member).digest_on = date.today() - timedelta(days=1)
        db.commit()
    third = client.get(path, headers=member_headers).json()
    assert third["badge_count"] == 1
    assert any(key.endswith(activity_id) for key in third["digest_keys"])


def test_void_cost_preserves_history_and_excludes_prediction(client, setup):
    pid, _, _, _, _, admin = setup
    path = f"/api/v1/pm/projects/{pid}/costs"
    row = client.post(path, json=cost(kind="payment"), headers=admin).json()
    assert client.get(path, headers=admin).json()["forecast"] == 7
    assert (
        client.put(
            f"{path}/{row['id']}",
            json=cost(kind="payment", voided=True, expected_revision=1),
            headers=admin,
        ).status_code
        == 422
    )
    result = client.put(
        f"{path}/{row['id']}",
        json=cost(
            kind="payment", voided=True, void_reason="重复录入，作废保留凭据", expected_revision=1
        ),
        headers=admin,
    )
    assert result.status_code == 200, result.text
    summary = client.get(path, headers=admin).json()
    assert summary["forecast"] == 0
    assert summary["items"][0]["voided"]
    assert summary["items"][0]["amount"] == 7
    history = client.get(f"/api/v1/pm/projects/{pid}/changes", headers=admin).json()
    assert any(
        entry["changes"].get("void_reason", {}).get("after") == "重复录入，作废保留凭据"
        for entry in history["items"]
    )


def test_business_context_requires_login_and_uses_server_date(client, auth_headers):
    assert client.get("/api/v1/pm/context").status_code == 401
    data = client.get("/api/v1/pm/context", headers=auth_headers).json()
    assert data["business_date"] == date.today().isoformat()
    assert data["timezone"] == str(datetime.now().astimezone().tzinfo)
