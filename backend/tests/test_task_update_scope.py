"""任务更新按可见项目收窄：项目负责人只能改自己负责 / 参与的项目里的任务（与新建 / 删除同一口径）。"""

from datetime import date

from app.db.session import SessionLocal
from app.models import Task


def test_project_lead_updates_tasks_only_in_visible_projects(
    client, iam_user, bearer, project_factory
):
    lead, other_lead = iam_user("tu-pl", "project_lead"), iam_user("tu-pl2", "project_lead")
    mine = project_factory(owner_id=lead)
    joined = project_factory(owner_id=other_lead, member_ids=(lead,))  # 作为成员参与
    foreign = project_factory(owner_id=other_lead)  # 既非负责人也非成员
    headers = bearer(lead, "project_lead")
    changes = {"cost_budget": 99, "planned_end": "2026-07-31", "owner_id": lead, "status": "进行中"}

    res = client.patch(f"/api/v1/tasks/{foreign}-t1", json=changes, headers=headers)
    assert res.status_code == 403
    with SessionLocal() as db:  # 被拒的更新没有落库
        task = db.get(Task, f"{foreign}-t1")
        assert (task.cost_budget, task.planned_end, task.owner_id, task.status) == (
            None,
            date(2026, 6, 30),
            other_lead,
            "未开始",
        )

    for pid in (mine, joined):
        res = client.patch(f"/api/v1/tasks/{pid}-t1", json=changes, headers=headers)
        assert res.status_code == 200, res.text
        body = res.json()
        assert float(body["cost_budget"]) == 99 and body["planned_end"] == "2026-07-31"
        assert body["owner_id"] == lead and body["status"] == "进行中"
