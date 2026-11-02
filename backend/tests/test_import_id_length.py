"""issue #4 回归测试 —— 模板实例化产生的拼接式组合 ID 长度。

前端把层级 ID 拼成 ``${projectId}-${childCode}``（见 src/lib/instantiate.ts）：
  - projectId        ~17 字符  (pu-mqvxxw0m-7dl1q)
  - subProjectId     ~24 字符  (…-sp-usp)
  - taskId           ~30 字符  (…-USP-PROC-001)

最初的 VARCHAR(20) 列宽放不下这些值。SQLite 不强制长度（开发期看不出问题），
而 PostgreSQL 在 INSERT 时抛 StringDataRightTruncation → /projects/import 返回 500。
"""

from datetime import date

import pytest
from sqlalchemy import String

from app.db.session import SessionLocal
from app.models import Project, SubProject, Task, TaskDependency

# 列宽下限：足以容纳上述组合 ID（含余量）。
MIN_ID_LEN = 64

# (模型, 列名) —— 项目→子项目→任务→依赖 这条链上参与拼接式 ID 的主键/外键。
_ID_COLUMNS = [
    (Project, "id"),
    (SubProject, "id"),
    (SubProject, "project_id"),
    (Task, "id"),
    (Task, "sub_project_id"),
    (TaskDependency, "id"),
    (TaskDependency, "predecessor_id"),
    (TaskDependency, "successor_id"),
]


@pytest.mark.parametrize(
    "model, column_name",
    _ID_COLUMNS,
    ids=[f"{m.__tablename__}.{c}" for m, c in _ID_COLUMNS],
)
def test_id_column_wide_enough_for_composite_ids(model, column_name):
    """每个 ID 列的声明宽度必须 >= MIN_ID_LEN，才能容纳拼接式组合 ID。"""
    column = model.__table__.columns[column_name]
    assert isinstance(column.type, String)
    length = column.type.length or 0
    assert length >= MIN_ID_LEN, (
        f"{model.__tablename__}.{column_name} 列宽仅 {length}，"
        f"无法容纳前端拼接式组合 ID（需 >= {MIN_ID_LEN}）"
    )


def _import_payload():
    """模拟前端实例化输出：组合 ID 均超过 20 字符。"""
    project_id = "pu-mqvxxw0m-7dl1q"  # 17
    sp_id = f"{project_id}-sp-usp"  # 24
    task_a = f"{project_id}-USP-PROC-001"  # 30
    task_b = f"{project_id}-USP-PROC-002"  # 30
    return {
        "project": {
            "id": project_id,
            "code": "PU-IMPORT-TEST-001",
            "name": "组合 ID 导入测试项目",
            "product_type": "mAb",
            "current_stage": "临床前",
            "target_stage": "IND",
            "owner_id": "t-admin",
            "status": "活跃",
            "health": "green",
            "progress": 0,
            "planned_start": date(2026, 1, 1).isoformat(),
            "planned_end": date(2027, 1, 1).isoformat(),
        },
        "sub_projects": [
            {
                "id": sp_id,
                "name": "上游工艺开发 (USP)",
                "project_id": project_id,
                "stage": "临床前",
                "module": "USP",
                "owner_id": "t-admin",
                "status": "未开始",
                "progress": 0,
                "sort_order": 1,
            }
        ],
        "tasks": [
            {
                "id": task_a,
                "code": "PU-USP-PROC-001",
                "name": "细胞株构建",
                "sub_project_id": sp_id,
                "owner_id": "t-admin",
                "status": "未开始",
                "priority": "高",
                "planned_start": date(2026, 1, 1).isoformat(),
                "planned_end": date(2026, 3, 1).isoformat(),
            },
            {
                "id": task_b,
                "code": "PU-USP-PROC-002",
                "name": "工艺放大",
                "sub_project_id": sp_id,
                "owner_id": "t-admin",
                "status": "未开始",
                "priority": "中",
                "planned_start": date(2026, 3, 1).isoformat(),
                "planned_end": date(2026, 5, 1).isoformat(),
            },
        ],
        "dependencies": [
            {
                "id": f"{project_id}-dep-1",
                "predecessor_id": task_a,
                "successor_id": task_b,
                "type": "FS",
                "lag_days": 0,
            }
        ],
    }


def test_import_project_with_long_composite_ids(client, auth_headers):
    """整包导入带超长组合 ID 的项目应成功并持久化全部层级。

    在 PostgreSQL 上，这正是 issue #4 的真实复现（修复前返回 500）。
    """
    payload = _import_payload()

    resp = client.post("/api/v1/projects/import", json=payload, headers=auth_headers)
    assert resp.status_code == 201, resp.text

    project_id = payload["project"]["id"]
    db = SessionLocal()
    try:
        assert db.get(Project, project_id) is not None
        assert db.get(SubProject, payload["sub_projects"][0]["id"]) is not None
        assert (
            db.query(Task).filter_by(sub_project_id=payload["sub_projects"][0]["id"]).count() == 2
        )
        assert (
            db.query(TaskDependency).filter_by(id=f"{project_id}-dep-1").one_or_none() is not None
        )
    finally:
        db.close()
