"""空白项目沿用整包创建接口：不关联模板、零任务持久化、后续可自行规划。"""

from decimal import Decimal
from uuid import uuid4

import pytest

from app.db.session import SessionLocal
from app.models import ProjectFinance


def blank_payload(owner):
    pid = f"blank-{uuid4().hex[:12]}"
    return {
        "project": {
            "id": pid,
            "code": pid.upper(),
            "name": "自主规划项目",
            "product_type": "单抗",
            "current_stage": "IND",
            "target_stage": "BLA",
            "owner_id": owner,
            "status": "活跃",
            "health": "green",
            "progress": 0,
            "planned_start": "2026-10-21",
            "planned_end": "2026-10-21",
            "template_id": None,
            "template_version": None,
        },
        "sub_projects": [],
        "tasks": [],
        "dependencies": [],
        "finance": {
            "project_id": pid,
            "total_budget": 120.5,
            "spent": 0,
            "committed": 0,
            "breakdown": {},
            "fiscal_year": "2026-2026",
        },
    }


@pytest.mark.parametrize("role", ["admin", "cmc_lead"])
def test_blank_project_persists_and_can_add_first_task(
    client, iam_user, bearer, project_rows, role
):
    owner = iam_user(f"blank-{role}", role)
    headers = bearer(owner, role)
    body = blank_payload(owner)
    pid = body["project"]["id"]
    try:
        created = client.post("/api/v1/projects/import", json=body, headers=headers)
        assert created.status_code == 201, created.text
        saved = client.get(f"/api/v1/projects/{pid}", headers=headers).json()
        assert saved["template_id"] is None and saved["template_version"] is None
        assert saved["progress"] == 0 and saved["health"] == "green"
        assert saved["planned_start"] == saved["planned_end"] == "2026-10-21"
        assert project_rows(pid) == {
            "project": 1,
            "members": 0,
            "sub_projects": 0,
            "tasks": 0,
            "dependencies": 0,
            "finances": 1,
            "baselines": 0,
        }
        with SessionLocal() as db:
            assert db.get(ProjectFinance, pid).total_budget == Decimal("120.50")

        # 从真正的空结构开始，通过现有「编辑项目」接口添加第一个子项目和任务。
        endpoint = f"/api/v1/projects/{pid}/structure"
        snapshot = client.get(endpoint, headers=headers).json()
        edited = client.put(
            endpoint,
            headers=headers,
            json={
                "version": snapshot["version"],
                "sub_projects": [
                    {
                        "key": "first-sub",
                        "name": "自行规划的子项目",
                        "module": "USP",
                        "stage": "IND",
                        "tasks": [
                            {
                                "key": "first-task",
                                "code": "TASK-001",
                                "name": "自行规划的任务",
                                "owner_id": owner,
                                "planned_start": "2026-10-21",
                                "planned_end": "2026-11-21",
                            }
                        ],
                    }
                ],
            },
        )
        assert edited.status_code == 200, edited.text
        assert project_rows(pid)["tasks"] == project_rows(pid)["sub_projects"] == 1
        updated = client.get(f"/api/v1/projects/{pid}", headers=headers).json()
        assert updated["planned_end"] == "2026-11-21"
        assert updated["template_id"] is None
    finally:
        client.delete(f"/api/v1/projects/{pid}", headers=headers)


def test_project_member_cannot_create_blank_project(client, iam_user, bearer, project_rows):
    member = iam_user("blank-member", "rd")
    body = blank_payload(member)
    response = client.post("/api/v1/projects/import", json=body, headers=bearer(member, "rd"))
    assert response.status_code == 403
    assert project_rows(body["project"]["id"])["project"] == 0
