"""复制项目：结构与计划照搬、执行数据重置、日期平移、人员处理、校验与权限。"""

import json
from datetime import date
from uuid import uuid4

from app.db.session import SessionLocal
from app.models import AuditLog, ProjectFinance, SubProject, Task, TaskDependency, User


def url(pid: str) -> str:
    return f"/api/v1/projects/{pid}/copy"


def new_code() -> str:
    return f"CP-{uuid4().hex[:8].upper()}"


def tasks_of(project_id: str) -> dict[str, Task]:
    with SessionLocal() as db:
        rows = (
            db.query(Task)
            .join(SubProject, SubProject.id == Task.sub_project_id)
            .filter(SubProject.project_id == project_id)
            .all()
        )
        db.expunge_all()
        return {t.name: t for t in rows}


def update(model, key, **values) -> None:
    with SessionLocal() as db:
        row = db.get(model, key)
        for k, v in values.items():
            setattr(row, k, v)
        db.commit()


def test_copy_keeps_structure_and_resets_execution(
    client, auth_headers, project_factory, project_rows, iam_user
):
    lead = iam_user(f"t-pl-{uuid4().hex[:6]}", "project_lead")
    member = iam_user(f"t-rd-{uuid4().hex[:6]}", "rd")
    pid = project_factory(lead, member_ids=(member,))
    source_code = pid.upper()
    update(
        Task,
        f"{pid}-t1",
        status="已完成",
        progress=100,
        actual_start=date(2026, 1, 5),
        actual_end=date(2026, 3, 1),
        actual_effort=3,
        actual_cost=8,
        cost_budget=12.5,
        estimated_effort=4,
        notes="方法开发说明",
        tags=["关键"],
        collaborator_ids=[member],
        is_critical_path=True,
        priority="高",
    )
    update(Task, f"{pid}-t2", code=f"{source_code}-USP-002", status="进行中", progress=40)
    update(ProjectFinance, pid, breakdown={"人力": 20, "外部服务": 30})

    code = new_code()
    res = client.post(
        url(pid), json={"code": f" {code} ", "name": "复制的项目"}, headers=auth_headers
    )
    assert res.status_code == 201, res.text
    out = res.json()
    new_id = out["id"]
    assert new_id != pid and out["code"] == code and out["name"] == "复制的项目"
    assert out["owner_id"] == lead and out["member_ids"] == [member]
    assert out["status"] == "活跃" and out["progress"] == 0
    assert (out["planned_start"], out["planned_end"]) == ("2026-01-01", "2026-12-31")
    assert project_rows(new_id) == {
        "project": 1,
        "members": 1,
        "sub_projects": 1,
        "tasks": 2,
        "dependencies": 1,
        "finances": 1,
        "baselines": 0,  # 基线不复制
    }

    copied = tasks_of(new_id)
    t1, t2 = copied["测试任务 1"], copied["测试任务 2"]
    for t in (t1, t2):
        assert (t.status, t.progress) == ("未开始", 0)
        assert t.actual_start is t.actual_end is t.actual_cost is t.actual_effort is None
    assert t1.code == "T-1" and t2.code == f"{code}-USP-002"  # 以原项目编号为前缀的任务编号随之更换
    assert float(t1.cost_budget) == 12.5 and float(t1.estimated_effort) == 4
    assert t1.notes == "方法开发说明" and t1.tags == ["关键"] and t1.collaborator_ids == [member]
    assert t1.is_critical_path and t1.priority == "高" and t1.owner_id == member
    with SessionLocal() as db:
        dep = db.query(TaskDependency).filter(TaskDependency.successor_id == t2.id).one()
        assert dep.predecessor_id == t1.id and (dep.type, dep.lag_days) == ("FS", 0)
        fin = db.get(ProjectFinance, new_id)
        assert float(fin.total_budget) == 100 and float(fin.committed) == 0
        assert fin.breakdown == {"人力": 0, "外部服务": 0} and source_code in fin.notes
        sub = db.query(SubProject).filter_by(project_id=new_id).one()
        assert (sub.name, sub.status, sub.progress) == ("测试子项目", "未开始", 0)
        log = db.query(AuditLog).filter_by(action="复制项目", target_id=new_id[:40]).one()
        detail = json.loads(log.detail)
        assert detail["source_id"] == pid and detail["tasks"] == 2 and detail["shift_days"] == 0

    # 原项目不受影响
    source = tasks_of(pid)
    assert (source["测试任务 1"].status, source["测试任务 1"].progress) == ("已完成", 100)
    assert client.delete(f"/api/v1/projects/{new_id}", headers=auth_headers).status_code == 204


def test_copy_shifts_all_planned_dates(client, auth_headers, project_factory):
    pid = project_factory("t-admin")
    res = client.post(
        url(pid),
        json={"code": new_code(), "name": "平移后的项目", "planned_start": "2026-03-01"},
        headers=auth_headers,
    )
    assert res.status_code == 201, res.text
    out = res.json()
    # 2026-01-01 → 2026-03-01：整体平移 59 天
    assert (out["planned_start"], out["planned_end"]) == ("2026-03-01", "2027-02-28")
    for t in tasks_of(out["id"]).values():
        assert (t.planned_start, t.planned_end) == (date(2026, 3, 1), date(2026, 8, 28))
    with SessionLocal() as db:
        assert db.get(ProjectFinance, out["id"]).fiscal_year == "2026-2027"
    assert client.delete(f"/api/v1/projects/{out['id']}", headers=auth_headers).status_code == 204


def test_copy_reassigns_inactive_people(client, auth_headers, project_factory, iam_user):
    lead = iam_user(f"t-pl-{uuid4().hex[:6]}", "project_lead")
    gone = iam_user(f"t-rd-{uuid4().hex[:6]}", "rd")
    pid = project_factory("t-admin", member_ids=(gone,), task_owner_id=gone)
    update(Task, f"{pid}-t1", collaborator_ids=[gone])
    update(User, gone, is_active=False)
    try:
        res = client.post(
            url(pid),
            json={"code": new_code(), "name": "换人", "owner_id": lead},
            headers=auth_headers,
        )
        assert res.status_code == 201, res.text
        out = res.json()
        assert out["owner_id"] == lead and out["member_ids"] == []  # 已停用成员不带入
        for t in tasks_of(out["id"]).values():
            assert t.owner_id == lead and t.collaborator_ids is None  # 改由新负责人承担
    finally:
        update(User, gone, is_active=True)


def test_copy_validation(client, auth_headers, project_factory, iam_user):
    pid = project_factory("t-admin")
    off = iam_user(f"t-off-{uuid4().hex[:6]}", "project_lead")
    update(User, off, is_active=False)
    try:
        cases = [
            ({"code": pid.upper(), "name": "重复编号"}, 409, "已存在"),
            ({"code": new_code(), "name": "停用负责人", "owner_id": off}, 422, "已停用"),
            ({"code": new_code(), "name": "无此人", "owner_id": "nobody"}, 422, "不存在"),
            ({"code": "   ", "name": "空编号"}, 422, None),
            ({"code": new_code(), "name": ""}, 422, None),
        ]
        for body, code, message in cases:
            res = client.post(url(pid), json=body, headers=auth_headers)
            assert res.status_code == code, (body, res.text)
            if message:
                assert message in res.json()["detail"]
        missing = client.post(
            url("no-such-project"), json={"code": new_code(), "name": "x"}, headers=auth_headers
        )
        assert missing.status_code == 404
    finally:
        update(User, off, is_active=True)


def test_copy_permissions(client, project_factory, iam_user, bearer):
    lead = iam_user(f"t-pl-{uuid4().hex[:6]}", "project_lead")
    member = iam_user(f"t-rd-{uuid4().hex[:6]}", "rd")
    cmc = iam_user(f"t-cmc-{uuid4().hex[:6]}", "cmc_lead")
    pid = project_factory(lead, member_ids=(member,))
    body = {"code": new_code(), "name": "权限"}
    assert client.post(url(pid), json=body).status_code == 401
    # 与新建项目一致：只有管理员 / CMC 负责人可以复制（项目负责人本人也不行）
    assert client.post(url(pid), json=body, headers=bearer(lead, "project_lead")).status_code == 403
    assert client.post(url(pid), json=body, headers=bearer(member, "rd")).status_code == 403
    res = client.post(url(pid), json=body, headers=bearer(cmc, "cmc_lead"))
    assert res.status_code == 201, res.text
    assert (
        client.delete(
            f"/api/v1/projects/{res.json()['id']}", headers=bearer(cmc, "cmc_lead")
        ).status_code
        == 204
    )
