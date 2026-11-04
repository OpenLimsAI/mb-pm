"""Real scoped writes, revision conflicts, deliverables and acceptance."""

import json

from app.db.session import SessionLocal
from app.models import AuditLog


def test_executor_progress_revision_audit(client, iam_user, bearer, project_factory):
    lead, worker = iam_user("co-lead", "cmc_lead"), iam_user("co-worker", "rd")
    pid = project_factory(lead, (worker,), task_owner_id=worker)
    tid, h = f"{pid}-t1", bearer(worker, "rd")
    original = client.get(f"/api/v1/tasks/{tid}", headers=h).json()
    response = client.patch(
        f"/api/v1/tasks/{tid}",
        json={
            "status": "进行中",
            "progress": 30,
            "actual_cost": 0,
            "actual_effort": 1.5,
            "progress_note": "完成首轮筛选",
            "expected_revision": original["revision"],
        },
        headers=h,
    )
    assert response.status_code == 200, response.text
    latest = response.json()
    assert latest["revision"] == original["revision"] + 1
    assert latest["planned_start"] == original["planned_start"]
    assert float(latest["actual_cost"]) == 0
    conflict = client.patch(
        f"/api/v1/tasks/{tid}",
        json={"progress": 10, "expected_revision": original["revision"]},
        headers=h,
    )
    assert conflict.status_code == 409
    assert conflict.json()["detail"]["current"]["progress"] == 30
    assert (
        client.patch(
            f"/api/v1/tasks/{tid}", json={"planned_start": original["planned_start"]}, headers=h
        ).status_code
        == 403
    )
    timeline = client.get(f"/api/v1/tasks/{tid}/collaboration", headers=h).json()["activities"]
    progress = next(x for x in timeline if x["kind"] == "progress")
    assert progress["body"] == "完成首轮筛选"
    assert progress["changes"]["actual_cost"] == {"before": None, "after": 0}
    with SessionLocal() as db:
        audit = db.query(AuditLog).filter_by(target_id=tid, action="任务字段变更").one()
        assert json.loads(audit.detail)["progress"] == {"before": 0, "after": 30}
    note = client.patch(
        f"/api/v1/tasks/{tid}",
        json={"progress_note": "补充说明", "expected_revision": latest["revision"]},
        headers=h,
    )
    assert note.json()["revision"] == latest["revision"] + 1


def test_scoped_mentions_and_versioned_file_download(client, iam_user, bearer, project_factory):
    lead, worker, outsider = (
        iam_user("file-lead", "cmc_lead"),
        iam_user("file-worker", "rd"),
        iam_user("file-other", "rd"),
    )
    pid = project_factory(lead, (worker,), task_owner_id=worker)
    tid, h, other = f"{pid}-t1", bearer(worker, "rd"), bearer(outsider, "rd")
    assert client.get(f"/api/v1/tasks/{tid}/collaboration", headers=other).status_code == 403
    assert (
        client.post(
            f"/api/v1/tasks/{tid}/comments",
            json={"body": "请确认", "mention_ids": [outsider]},
            headers=h,
        ).status_code
        == 422
    )
    assert (
        client.post(
            f"/api/v1/tasks/{tid}/comments",
            json={"body": "请确认", "mention_ids": [lead]},
            headers=h,
        ).status_code
        == 201
    )
    for version in (1, 2):
        result = client.post(
            f"/api/v1/tasks/{tid}/deliverables/file",
            data={"title": "筛选报告", "notes": f"第{version}稿"},
            files={"file": ("../报告.pdf", b"%PDF-1.7\nreport", "application/pdf")},
            headers=h,
        )
        assert result.status_code == 201, result.text
        assert result.json()["version"] == version
    path = f"/api/v1/tasks/{tid}/deliverables/{result.json()['id']}/download"
    assert client.get(path, headers=other).status_code == 403
    downloaded = client.get(path, headers=h)
    assert downloaded.content == b"%PDF-1.7\nreport"
    assert downloaded.headers["content-disposition"].startswith("attachment;")
    assert downloaded.headers["x-content-type-options"] == "nosniff"
    assert (
        client.post(
            f"/api/v1/tasks/{tid}/deliverables/file",
            data={"title": "不安全"},
            files={"file": ("attack.html", b"<script>evil</script>", "text/html")},
            headers=h,
        ).status_code
        == 422
    )
    assert (
        client.post(
            f"/api/v1/tasks/{tid}/deliverables/link",
            json={"title": "不安全链接", "link": "javascript:alert(1)"},
            headers=h,
        ).status_code
        == 422
    )
    data = client.get(f"/api/v1/tasks/{tid}/collaboration", headers=h).json()
    assert len(data["deliverables"]) == 2
    assert "content" not in data["deliverables"][0]
    assert data["activities"][-1]["mention_ids"] == [lead]


def test_acceptance_enforces_outputs_and_reviewer(client, iam_user, bearer, project_factory):
    lead, worker = iam_user("acc-lead", "cmc_lead"), iam_user("acc-worker", "rd")
    pid = project_factory(lead, (worker,), task_owner_id=worker)
    tid, lh, wh = f"{pid}-t1", bearer(lead, "cmc_lead"), bearer(worker, "rd")
    assert (
        client.patch(f"/api/v1/tasks/{tid}", json={"is_milestone": True}, headers=lh).status_code
        == 200
    )
    config = f"/api/v1/tasks/{tid}/acceptance"
    assert (
        client.put(config, json={"reviewer_id": lead, "required_count": 1}, headers=wh).status_code
        == 403
    )
    assert (
        client.put(config, json={"reviewer_id": lead, "required_count": 2}, headers=lh).status_code
        == 200
    )
    action = f"{config}/actions"
    assert client.post(action, json={"action": "submit"}, headers=wh).status_code == 422
    for _ in range(2):
        assert (
            client.post(
                f"/api/v1/tasks/{tid}/deliverables/link",
                json={"title": "报告", "link": "https://example.com/report"},
                headers=wh,
            ).status_code
            == 201
        )
    assert client.post(action, json={"action": "submit"}, headers=wh).status_code == 422
    assert (
        client.post(
            f"/api/v1/tasks/{tid}/deliverables/link",
            json={"title": "数据", "link": "https://example.com/data"},
            headers=wh,
        ).status_code
        == 201
    )
    assert (
        client.patch(f"/api/v1/tasks/{tid}", json={"status": "已验证"}, headers=wh).status_code
        == 422
    )
    assert client.post(action, json={"action": "submit"}, headers=wh).status_code == 200
    assert client.post(action, json={"action": "accept"}, headers=wh).status_code == 403
    assert client.post(action, json={"action": "reject"}, headers=lh).status_code == 422
    assert (
        client.post(
            action, json={"action": "accept", "comment": "符合要求"}, headers=lh
        ).status_code
        == 200
    )
    current = client.get(f"/api/v1/tasks/{tid}", headers=wh).json()
    assert current["status"] == "已验证" and current["progress"] == 100
    assert client.post(action, json={"action": "accept"}, headers=lh).status_code == 409
    assert (
        client.post(
            f"/api/v1/tasks/{tid}/deliverables/link",
            json={"title": "报告", "link": "https://example.com/revised"},
            headers=wh,
        ).status_code
        == 201
    )
    data = client.get(f"/api/v1/tasks/{tid}/collaboration", headers=wh).json()
    assert data["acceptance"]["state"] == "draft"
    assert len(data["acceptance"]["submitted_deliverable_ids"]) == 2
    assert client.get(f"/api/v1/tasks/{tid}", headers=wh).json()["status"] == "已完成"


def test_activity_history_cursor_preserves_all_rows(client, iam_user, bearer, project_factory):
    from datetime import UTC, datetime

    from app.models.task_collaboration import TaskActivity

    lead = iam_user("history-lead", "cmc_lead")
    pid = project_factory(lead)
    tid = f"{pid}-t1"
    with SessionLocal() as db:
        for i in range(310):
            db.add(
                TaskActivity(
                    id=f"history-{pid}-{i:03d}",
                    task_id=tid,
                    actor_id=lead,
                    kind="comment",
                    body=str(i),
                    created_at=datetime(2026, 1, 1, tzinfo=UTC),
                )
            )
        db.commit()
    data = client.get(f"/api/v1/tasks/{tid}/collaboration", headers=bearer(lead, "cmc_lead")).json()
    assert len(data["activities"]) == 300
    older = client.get(
        f"/api/v1/tasks/{tid}/activities",
        params={"before": data["next_activity_cursor"]},
        headers=bearer(lead, "cmc_lead"),
    ).json()
    assert len(older["activities"]) == 10 and older["next_activity_cursor"] is None
    assert len({row["id"] for row in data["activities"] + older["activities"]}) == 310
