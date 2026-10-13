"""任务手动顺序：编辑模式按位置保存、原样保存不重排、跨子项目移动、新建 / 导入 / 复制 / 老数据补号。"""

from datetime import date
from uuid import uuid4

from app.db.session import SessionLocal
from app.models import SubProject, Task
from app.services.task_order import backfill_all
from tests.test_project_structure import new_task, payload_from, set_task, url


def orders(sub_id: str) -> list[tuple[str, int | None]]:
    with SessionLocal() as db:
        rows = db.query(Task).filter_by(sub_project_id=sub_id).all()
        return sorted(
            ((t.code, t.sort_order) for t in rows), key=lambda r: (r[1] is None, r[1] or 0, r[0])
        )


def add_sub(pid: str, sub_id: str, module: str = "DSP") -> None:
    with SessionLocal() as db:
        db.add(
            SubProject(
                id=sub_id,
                name=f"子项目 {module}",
                project_id=pid,
                stage="IND",
                module=module,
                status="未开始",
                sort_order=9,
            )
        )
        db.commit()


def test_insert_between_keeps_position(client, auth_headers, project_factory):
    pid = project_factory("t-admin")
    snap = client.get(url(pid), headers=auth_headers).json()
    body = payload_from(snap)
    tasks = body["sub_projects"][0]["tasks"]
    tasks.insert(
        1, new_task("k-mid", "T-9", "t-admin", "2026-06-30", "2026-07-10", [tasks[0]["id"]])
    )
    res = client.put(url(pid), json=body, headers=auth_headers)
    assert res.status_code == 200, res.text
    assert res.json()["result"]["reordered"] is False  # 单纯插入不算调整已有任务的先后
    assert orders(f"{pid}-sp") == [("T-1", 1), ("T-9", 2), ("T-2", 3)]
    # 快照按同一顺序返回，并带上顺序号
    snap = client.get(url(pid), headers=auth_headers).json()
    assert [(t["code"], t["sort_order"]) for t in snap["tasks"]] == [
        ("T-1", 1),
        ("T-9", 2),
        ("T-2", 3),
    ]


def test_reorder_only_changes_order(client, auth_headers, project_factory):
    pid = project_factory("t-admin")
    body = payload_from(client.get(url(pid), headers=auth_headers).json())
    body["sub_projects"][0]["tasks"].reverse()
    res = client.put(url(pid), json=body, headers=auth_headers)
    assert res.status_code == 200, res.text
    result = res.json()["result"]
    assert result["reordered"] is True and result["updated_tasks"] == 0
    assert orders(f"{pid}-sp") == [("T-2", 1), ("T-1", 2)]
    # 原样再保存一次：顺序号与版本都不变
    snap = client.get(url(pid), headers=auth_headers).json()
    res = client.put(url(pid), json=payload_from(snap), headers=auth_headers)
    assert res.json()["version"] == snap["version"] and res.json()["result"]["reordered"] is False


def test_move_task_to_another_sub_project(client, auth_headers, project_factory):
    pid = project_factory("t-admin")
    set_task(f"{pid}-t2", progress=50, status="进行中")
    add_sub(pid, f"{pid}-sp2")
    body = payload_from(client.get(url(pid), headers=auth_headers).json())
    first, second = body["sub_projects"]
    second["tasks"].append(first["tasks"].pop())  # T-2 移到第二个子项目
    res = client.put(url(pid), json=body, headers=auth_headers)
    assert res.status_code == 200, res.text
    assert res.json()["result"]["reordered"] is True
    assert orders(f"{pid}-sp") == [("T-1", 1)]
    assert orders(f"{pid}-sp2") == [("T-2", 1)]
    with SessionLocal() as db:  # 两个子项目都重算进度
        assert db.get(SubProject, f"{pid}-sp").progress == 0
        assert db.get(SubProject, f"{pid}-sp2").progress == 50


def test_create_task_appends_and_fills_legacy_order(client, auth_headers, project_factory):
    """老数据没有顺序号：新建任务时先按原显示顺序（计划开始、编号）补号，新任务接在末尾。"""
    pid = project_factory("t-admin")
    set_task(f"{pid}-t2", planned_start=date(2025, 12, 1))  # T-2 开始更早，原显示在 T-1 前
    res = client.post(
        "/api/v1/tasks",
        json={
            "code": "T-3",
            "name": "新建里程碑",
            "sub_project_id": f"{pid}-sp",
            "owner_id": "t-admin",
            "planned_start": "2026-01-01",
            "planned_end": "2026-01-01",
            "is_milestone": True,
        },
        headers=auth_headers,
    )
    assert res.status_code == 201, res.text
    assert res.json()["sort_order"] == 3
    assert orders(f"{pid}-sp") == [("T-2", 1), ("T-1", 2), ("T-3", 3)]


def test_backfill_keeps_display_order_and_updated_at(project_factory, client):
    pid = project_factory("t-admin")
    set_task(f"{pid}-t1", planned_start=date(2026, 3, 1))
    with SessionLocal() as db:
        before = {t.id: t.updated_at for t in db.query(Task).filter_by(sub_project_id=f"{pid}-sp")}
        assert backfill_all(db) >= 1
        db.commit()
        assert backfill_all(db) == 0  # 幂等
    assert orders(f"{pid}-sp") == [("T-2", 1), ("T-1", 2)]
    with SessionLocal() as db:
        after = {t.id: t.updated_at for t in db.query(Task).filter_by(sub_project_id=f"{pid}-sp")}
    assert after == before  # 补号不是用户修改，不动 updated_at


def test_import_and_copy_keep_order(client, auth_headers, project_factory):
    pid = f"tp-{uuid4().hex[:10]}"
    sub = f"{pid}-sp"
    tasks = [
        {
            "id": f"{pid}-{c}",
            "code": c,
            "name": c,
            "sub_project_id": sub,
            "owner_id": "t-admin",
            "planned_start": start,
            "planned_end": start,
        }
        for c, start in (("B", "2026-05-01"), ("A", "2026-01-01"))
    ]
    res = client.post(
        "/api/v1/projects/import",
        json={
            "project": {
                "id": pid,
                "code": pid.upper(),
                "name": "导入",
                "product_type": "单抗",
                "current_stage": "IND",
                "target_stage": "Ph3",
                "owner_id": "t-admin",
                "status": "活跃",
                "health": "green",
                "planned_start": "2026-01-01",
                "planned_end": "2026-12-31",
            },
            "sub_projects": [
                {"id": sub, "name": "S", "project_id": pid, "stage": "IND", "module": "USP"}
            ],
            "tasks": tasks,
        },
        headers=auth_headers,
    )
    assert res.status_code == 201, res.text
    assert orders(sub) == [("B", 1), ("A", 2)]  # 按提交（模板）顺序，而不是日期
    res = client.post(
        f"/api/v1/projects/{pid}/copy",
        json={"code": f"CP-{uuid4().hex[:6]}", "name": "复制"},
        headers=auth_headers,
    )
    assert res.status_code == 201, res.text
    with SessionLocal() as db:
        new_sub = db.query(SubProject).filter_by(project_id=res.json()["id"]).one()
    assert orders(new_sub.id) == [("B", 1), ("A", 2)]
    for project_id in (pid, res.json()["id"]):
        assert (
            client.delete(f"/api/v1/projects/{project_id}", headers=auth_headers).status_code == 204
        )
