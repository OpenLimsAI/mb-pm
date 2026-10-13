"""项目结构编辑（编辑模式）：统一保存、版本冲突、删除保护、依赖与成环校验、权限。"""

import json
from collections import defaultdict
from datetime import date
from uuid import uuid4

from app.db.session import SessionLocal
from app.models import AuditLog, SubProject, Task, TaskDependency


def url(pid: str) -> str:
    return f"/api/v1/projects/{pid}/structure"


def payload_from(snapshot: dict) -> dict:
    """把结构快照原样转成保存请求（已有对象 key 用 id）。"""
    preds = defaultdict(list)
    for dep in snapshot["dependencies"]:
        preds[dep["successor_id"]].append(dep["predecessor_id"])
    subs = []
    for sub in snapshot["sub_projects"]:
        tasks = [
            {
                "id": t["id"],
                "key": t["id"],
                "code": t["code"],
                "name": t["name"],
                "is_milestone": t["is_milestone"],
                "owner_id": t["owner_id"],
                "planned_start": t["planned_start"],
                "planned_end": t["planned_end"],
                "estimated_effort": t["estimated_effort"],
                "cost_budget": t["cost_budget"],
                "notes": t["notes"],
                "predecessors": preds[t["id"]],
            }
            for t in snapshot["tasks"]
            if t["sub_project_id"] == sub["id"]
        ]
        subs.append(
            {
                "id": sub["id"],
                "key": sub["id"],
                "name": sub["name"],
                "module": sub["module"],
                "stage": sub["stage"],
                "tasks": tasks,
            }
        )
    return {"version": snapshot["version"], "sub_projects": subs}


def new_task(key, code, owner, start, end, preds=(), milestone=False):
    return {
        "key": key,
        "code": code,
        "name": f"新任务 {code}",
        "is_milestone": milestone,
        "owner_id": owner,
        "planned_start": start,
        "planned_end": end,
        "estimated_effort": 3,
        "cost_budget": 12.5,
        "notes": " 备注 ",
        "predecessors": list(preds),
    }


def set_task(task_id: str, **values) -> None:
    with SessionLocal() as db:
        task = db.get(Task, task_id)
        for k, v in values.items():
            setattr(task, k, v)
        db.commit()


def test_snapshot_and_noop_save(client, auth_headers, project_factory):
    pid = project_factory("t-admin")
    snap = client.get(url(pid), headers=auth_headers).json()
    assert len(snap["version"]) == 64 and snap["project"]["code"] == pid.upper()
    assert [t["code"] for t in snap["tasks"]] == ["T-1", "T-2"]
    assert all(t["locked_reason"] is None for t in snap["tasks"])
    assert [(d["predecessor_id"], d["successor_id"]) for d in snap["dependencies"]] == [
        (f"{pid}-t1", f"{pid}-t2")
    ]
    res = client.put(url(pid), json=payload_from(snap), headers=auth_headers)
    assert res.status_code == 200, res.text
    assert res.json()["result"]["updated_tasks"] == 0
    assert res.json()["version"] == snap["version"]  # 原样保存不改变结构


def test_save_adds_updates_deletes_in_one_go(client, auth_headers, project_factory):
    pid = project_factory("t-admin")
    snap = client.get(url(pid), headers=auth_headers).json()
    body = payload_from(snap)
    sub = body["sub_projects"][0]
    t1 = sub["tasks"][0]
    t1.update(name="改名后的任务", planned_end="2026-05-31")
    sub["tasks"] = [t1, new_task("k-new", "T-3", "t-admin", "2026-06-01", "2026-06-20", [t1["id"]])]
    body["sub_projects"].append(
        {
            "key": "k-sub",
            "name": "下游工艺开发",
            "module": "DSP",
            "stage": "Ph3",
            "tasks": [
                new_task("k-ms", "M-1", "t-admin", "2026-07-01", "2026-07-09", ["k-new"], True)
            ],
        }
    )
    body["summary"] = "补充下游里程碑"
    res = client.put(url(pid), json=body, headers=auth_headers)
    assert res.status_code == 200, res.text
    out = res.json()
    assert out["result"] == {
        "created_sub_projects": 1,
        "deleted_sub_projects": 0,
        "created_tasks": 2,
        "updated_tasks": 1,
        "deleted_tasks": 1,
        "added_dependencies": 2,
        "removed_dependencies": 1,  # T-2 删除时连带删掉 T-1 → T-2
    }
    assert out["version"] != snap["version"]
    codes = {t["code"]: t for t in out["tasks"]}
    assert set(codes) == {"T-1", "T-3", "M-1"}
    assert codes["T-1"]["name"] == "改名后的任务" and codes["T-1"]["planned_end"] == "2026-05-31"
    # 里程碑是时间点：结束 = 开始（工时按提交值保存）；新任务一律「未开始」
    assert codes["M-1"]["planned_end"] == "2026-07-01" and codes["M-1"]["estimated_effort"] == 3
    assert codes["T-3"]["status"] == "未开始" and codes["T-3"]["notes"] == "备注"
    pairs = {(d["predecessor_id"], d["successor_id"]) for d in out["dependencies"]}
    assert pairs == {(f"{pid}-t1", codes["T-3"]["id"]), (codes["T-3"]["id"], codes["M-1"]["id"])}
    assert [s["name"] for s in out["sub_projects"]] == ["测试子项目", "下游工艺开发"]
    with SessionLocal() as db:
        assert db.get(Task, f"{pid}-t2") is None
        log = db.query(AuditLog).filter_by(action="项目结构变更", target_id=pid[:40]).one()
        detail = json.loads(log.detail)
        assert detail["summary"] == "补充下游里程碑" and detail["deleted_task_codes"] == ["T-2"]


def test_stale_version_is_rejected_and_nothing_changes(client, auth_headers, project_factory):
    pid = project_factory("t-admin")
    snap = client.get(url(pid), headers=auth_headers).json()
    # 编辑期间他人改了计划日期
    res = client.patch(
        f"/api/v1/tasks/{pid}-t1", json={"planned_end": "2026-04-30"}, headers=auth_headers
    )
    assert res.status_code == 200
    body = payload_from(snap)
    body["sub_projects"][0]["tasks"][0]["name"] = "不应生效"
    res = client.put(url(pid), json=body, headers=auth_headers)
    assert res.status_code == 409 and "已被他人修改" in res.json()["detail"]
    with SessionLocal() as db:
        assert db.get(Task, f"{pid}-t1").name == "测试任务 1"


def test_progress_entry_does_not_invalidate_draft(client, auth_headers, project_factory):
    """日常录入进度不属于结构，不会让编辑中的草稿失效。"""
    pid = project_factory("t-admin")
    snap = client.get(url(pid), headers=auth_headers).json()
    set_task(f"{pid}-t1", progress=40, status="进行中")
    assert client.put(url(pid), json=payload_from(snap), headers=auth_headers).status_code == 200


def test_started_or_costed_tasks_cannot_be_deleted(client, auth_headers, project_factory):
    pid = project_factory("t-admin")
    for values, reason in (
        ({"status": "进行中", "progress": 10}, "已开始"),
        ({"actual_cost": 5}, "已录实际花费"),
    ):
        set_task(f"{pid}-t2", status="未开始", progress=0, actual_cost=None)
        set_task(f"{pid}-t2", **values)
        snap = client.get(url(pid), headers=auth_headers).json()
        assert {t["code"]: t["locked_reason"] for t in snap["tasks"]}["T-2"] == reason
        body = payload_from(snap)
        tasks = body["sub_projects"][0]["tasks"]
        tasks[0]["name"] = "同批次的其他修改"
        body["sub_projects"][0]["tasks"] = tasks[:1]  # 删除 T-2
        res = client.put(url(pid), json=body, headers=auth_headers)
        assert res.status_code == 409 and f"T-2（{reason}）" in res.json()["detail"]
        with SessionLocal() as db:  # 整批不生效
            assert db.get(Task, f"{pid}-t2") is not None
            assert db.get(Task, f"{pid}-t1").name == "测试任务 1"


def test_deleting_unstarted_subproject_and_rollup(client, auth_headers, project_factory):
    pid = project_factory("t-admin")
    snap = client.get(url(pid), headers=auth_headers).json()
    body = payload_from(snap)
    body["sub_projects"] = []
    res = client.put(url(pid), json=body, headers=auth_headers)
    assert res.status_code == 200, res.text
    assert res.json()["result"]["deleted_sub_projects"] == 1
    with SessionLocal() as db:
        assert db.query(SubProject).filter_by(project_id=pid).count() == 0
        assert db.query(TaskDependency).filter_by(predecessor_id=f"{pid}-t1").count() == 0


def test_validation_errors(client, auth_headers, project_factory, iam_user):
    pid = project_factory("t-admin")
    other = project_factory("t-admin")
    snap = client.get(url(pid), headers=auth_headers).json()
    inactive = iam_user(f"t-off-{uuid4().hex[:6]}", "rd")
    with SessionLocal() as db:
        from app.models import User

        db.get(User, inactive).is_active = False
        db.commit()

    def attempt(mutate) -> tuple[int, str]:
        body = payload_from(snap)
        mutate(body)
        res = client.put(url(pid), json=body, headers=auth_headers)
        return res.status_code, str(res.json().get("detail"))

    t = lambda body, i: body["sub_projects"][0]["tasks"][i]  # noqa: E731
    cases = [
        (lambda b: t(b, 0)["predecessors"].append(f"{pid}-t2"), "形成了环"),
        (lambda b: t(b, 0)["predecessors"].append(f"{pid}-t1"), "不能依赖自己"),
        (lambda b: t(b, 1).update(code="T-1"), "任务编号重复"),
        (lambda b: t(b, 1).update(planned_end="2025-12-01"), "早于计划开始"),
        (lambda b: t(b, 1)["predecessors"].append("no-such-task"), "前置任务不存在"),
        (lambda b: t(b, 1).update(id=f"{other}-t1", key=f"{other}-t1"), "不属于本项目"),
        (
            lambda b: b["sub_projects"][0]["tasks"].append(
                new_task("k-x", "T-9", inactive, "2026-02-01", "2026-02-02")
            ),
            "负责人不存在或已停用",
        ),
    ]
    for mutate, message in cases:
        code, detail = attempt(mutate)
        assert code == 422 and message in detail, (message, code, detail)
    with SessionLocal() as db:
        assert {
            t.code for t in db.query(Task).join(SubProject).filter(SubProject.project_id == pid)
        } == {
            "T-1",
            "T-2",
        }


def test_permissions(client, auth_headers, project_factory, iam_user, bearer):
    lead = iam_user(f"t-pl-{uuid4().hex[:6]}", "project_lead")
    stranger = iam_user(f"t-pl-{uuid4().hex[:6]}", "project_lead")
    member = iam_user(f"t-rd-{uuid4().hex[:6]}", "rd")
    pid = project_factory(lead, member_ids=(member,))
    snap = client.get(url(pid), headers=auth_headers).json()
    body = payload_from(snap)
    assert client.get(url(pid)).status_code == 401
    assert client.get(url(pid), headers=bearer(member, "rd")).status_code == 403
    assert client.put(url(pid), json=body, headers=bearer(member, "rd")).status_code == 403
    assert client.get(url(pid), headers=bearer(stranger, "project_lead")).status_code == 404
    assert (
        client.put(url(pid), json=body, headers=bearer(stranger, "project_lead")).status_code == 404
    )
    assert client.get(url(pid), headers=bearer(lead, "project_lead")).status_code == 200
    res = client.put(url(pid), json=body, headers=bearer(lead, "project_lead"))
    assert res.status_code == 200, res.text


def test_removing_a_predecessor_keeps_both_tasks(client, auth_headers, project_factory):
    pid = project_factory("t-admin")
    snap = client.get(url(pid), headers=auth_headers).json()
    body = payload_from(snap)
    body["sub_projects"][0]["tasks"][1]["predecessors"] = []  # T-2 不再依赖 T-1
    res = client.put(url(pid), json=body, headers=auth_headers)
    assert res.status_code == 200, res.text
    assert res.json()["result"]["removed_dependencies"] == 1
    assert res.json()["dependencies"] == []
    with SessionLocal() as db:
        assert db.get(Task, f"{pid}-t1") and db.get(Task, f"{pid}-t2")


def test_untouched_milestone_keeps_its_effort(client, auth_headers, project_factory):
    """模板实例化的里程碑可能带工时：保存其他修改时不能把它清零（也不计入「修改」）。"""
    pid = project_factory("t-admin")
    set_task(f"{pid}-t1", is_milestone=True, planned_end=date(2026, 1, 1), estimated_effort=4)
    snap = client.get(url(pid), headers=auth_headers).json()
    body = payload_from(snap)
    body["sub_projects"][0]["tasks"][1]["name"] = "只改了这一个"
    res = client.put(url(pid), json=body, headers=auth_headers)
    assert res.status_code == 200, res.text
    assert res.json()["result"]["updated_tasks"] == 1
    with SessionLocal() as db:
        assert float(db.get(Task, f"{pid}-t1").estimated_effort) == 4


def test_noop_save_keeps_sort_order_and_version(client, auth_headers, project_factory):
    """排序号从 1 开始等旧数据：原样保存不能重排（否则版本变化，打断他人编辑）；新子项目接在最后。"""
    pid = project_factory("t-admin")
    with SessionLocal() as db:
        db.get(SubProject, f"{pid}-sp").sort_order = 5
        db.add(
            SubProject(
                id=f"{pid}-sp2",
                name="第二个",
                project_id=pid,
                stage="IND",
                module="DSP",
                status="未开始",
                sort_order=7,
            )
        )
        db.commit()
    snap = client.get(url(pid), headers=auth_headers).json()
    res = client.put(url(pid), json=payload_from(snap), headers=auth_headers)
    assert res.status_code == 200, res.text
    assert res.json()["version"] == snap["version"]
    body = payload_from(res.json())
    body["sub_projects"].append(
        {"key": "k-new", "name": "新增", "module": "DP", "stage": "IND", "tasks": []}
    )
    res = client.put(url(pid), json=body, headers=auth_headers)
    assert res.status_code == 200, res.text
    assert [(s["name"], s["sort_order"]) for s in res.json()["sub_projects"]] == [
        ("测试子项目", 5),
        ("第二个", 7),
        ("新增", 8),
    ]


def test_rollup_only_recomputed_when_tasks_added_or_removed(client, auth_headers, project_factory):
    pid = project_factory("t-admin")
    set_task(f"{pid}-t1", progress=40, status="进行中")
    with SessionLocal() as db:
        db.get(SubProject, f"{pid}-sp").progress = 77  # 已存的汇总值
        db.commit()
    snap = client.get(url(pid), headers=auth_headers).json()
    body = payload_from(snap)
    body["sub_projects"][0]["tasks"][1]["name"] = "只改名称"
    assert client.put(url(pid), json=body, headers=auth_headers).status_code == 200
    with SessionLocal() as db:
        assert db.get(SubProject, f"{pid}-sp").progress == 77  # 只改名称不动进度
    body = payload_from(client.get(url(pid), headers=auth_headers).json())
    body["sub_projects"][0]["tasks"].append(
        new_task("k-3", "T-3", "t-admin", "2026-07-01", "2026-07-02")
    )
    assert client.put(url(pid), json=body, headers=auth_headers).status_code == 200
    with SessionLocal() as db:
        assert db.get(SubProject, f"{pid}-sp").progress == 13  # (40 + 0 + 0) / 3，新增任务后重算
