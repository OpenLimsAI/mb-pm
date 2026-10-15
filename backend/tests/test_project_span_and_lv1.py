"""项目起止按任务实时派生；编辑模式修改项目编号 / 名称（Lv1）；子项目插入与调整顺序（Lv2）。"""

from datetime import date
from uuid import uuid4

from app.db.session import SessionLocal
from app.models import Project, SubProject, Task
from tests.test_project_structure import payload_from, set_task, url


def project_out(client, headers, pid: str) -> dict:
    return client.get(f"/api/v1/projects/{pid}", headers=headers).json()


def test_project_span_follows_tasks(client, auth_headers, project_factory):
    pid = project_factory("t-admin")  # 已存 2026-01-01 → 2026-12-31；任务 01-01 → 06-30
    out = project_out(client, auth_headers, pid)
    assert (out["planned_start"], out["planned_end"]) == ("2026-01-01", "2026-06-30")
    set_task(f"{pid}-t2", planned_end=date(2027, 3, 31))
    set_task(f"{pid}-t1", planned_start=date(2025, 11, 1))
    out = project_out(client, auth_headers, pid)
    assert (out["planned_start"], out["planned_end"]) == ("2025-11-01", "2027-03-31")
    listed = client.get("/api/v1/projects", params={"page_size": 2000}, headers=auth_headers).json()
    row = next(p for p in listed["items"] if p["id"] == pid)
    assert (row["planned_start"], row["planned_end"]) == ("2025-11-01", "2027-03-31")
    # 结构快照与新建基线也用同一起止
    assert (
        client.get(url(pid), headers=auth_headers).json()["project"]["planned_end"] == "2027-03-31"
    )
    res = client.post(
        "/api/v1/baselines", json={"project_id": pid, "label": "起止测试"}, headers=auth_headers
    )
    assert res.status_code in (200, 201), res.text
    assert res.json()["snapshot"]["projectPlannedEnd"] == "2027-03-31"


def test_project_without_tasks_keeps_stored_span(client, auth_headers, project_factory):
    pid = project_factory("t-admin")
    body = payload_from(client.get(url(pid), headers=auth_headers).json())
    body["sub_projects"] = []
    assert client.put(url(pid), json=body, headers=auth_headers).status_code == 200
    out = project_out(client, auth_headers, pid)
    assert (out["planned_start"], out["planned_end"]) == ("2026-01-01", "2026-12-31")


def test_copy_shift_is_relative_to_task_span(client, auth_headers, project_factory):
    pid = project_factory("t-admin")
    for tid in (f"{pid}-t1", f"{pid}-t2"):
        set_task(tid, planned_start=date(2026, 2, 1))  # 任务最早开始 02-01，与已存的 01-01 不同
    res = client.post(
        f"/api/v1/projects/{pid}/copy",
        json={"code": f"CP-{uuid4().hex[:6]}", "name": "不平移", "planned_start": "2026-02-01"},
        headers=auth_headers,
    )
    assert res.status_code == 201, res.text
    assert res.json()["planned_start"] == "2026-02-01"  # 填的就是页面显示的开始日期：不平移
    with SessionLocal() as db:
        tasks = (
            db.query(Task)
            .join(SubProject, SubProject.id == Task.sub_project_id)
            .filter(SubProject.project_id == res.json()["id"])
            .all()
        )
        assert {t.planned_start for t in tasks} == {date(2026, 2, 1)}
    assert (
        client.delete(f"/api/v1/projects/{res.json()['id']}", headers=auth_headers).status_code
        == 204
    )


def test_rename_project_in_edit_mode(client, auth_headers, project_factory, iam_user, bearer):
    owner = iam_user(f"t-pl-{uuid4().hex[:6]}", "project_lead")
    member = iam_user(f"t-pl-{uuid4().hex[:6]}", "project_lead")
    pid = project_factory(owner, member_ids=(member,))
    other = project_factory("t-admin")
    snap = client.get(url(pid), headers=auth_headers).json()
    assert snap["project"]["name"] == "测试项目"

    def save(headers, code, name):
        body = payload_from(client.get(url(pid), headers=auth_headers).json())
        body["project"] = {"code": code, "name": name}
        return client.put(url(pid), json=body, headers=headers)

    new_code = f"RN-{uuid4().hex[:6].upper()}"
    # 参与项目但不是负责人的项目负责人：可改结构，不能改项目编号 / 名称
    res = save(bearer(member, "project_lead"), new_code, "新名称")
    assert res.status_code == 403 and "项目编号和名称" in res.json()["detail"]
    res = save(bearer(owner, "project_lead"), other.upper(), "新名称")
    assert res.status_code == 409 and "已存在" in res.json()["detail"]
    res = save(bearer(owner, "project_lead"), f" {new_code} ", " 新名称 ")
    assert res.status_code == 200, res.text
    assert res.json()["result"]["project_updated"] is True
    assert (res.json()["project"]["code"], res.json()["project"]["name"]) == (new_code, "新名称")
    with SessionLocal() as db:
        assert (db.get(Project, pid).code, db.get(Project, pid).name) == (new_code, "新名称")
    # 原样保存（带同样的编号 / 名称）不算修改，成员也可以保存
    assert (
        save(bearer(member, "project_lead"), new_code, "新名称").json()["result"]["project_updated"]
        is False
    )


def test_concurrent_rename_invalidates_draft(client, auth_headers, project_factory):
    pid = project_factory("t-admin")
    snap = client.get(url(pid), headers=auth_headers).json()
    assert (
        client.patch(
            f"/api/v1/projects/{pid}", json={"name": "他人改名"}, headers=auth_headers
        ).status_code
        == 200
    )
    res = client.put(url(pid), json=payload_from(snap), headers=auth_headers)
    assert res.status_code == 409 and "已被他人修改" in res.json()["detail"]


def test_reorder_and_insert_sub_projects(client, auth_headers, project_factory):
    pid = project_factory("t-admin")
    with SessionLocal() as db:
        db.add(
            SubProject(
                id=f"{pid}-sp2",
                name="第二个",
                project_id=pid,
                stage="IND",
                module="DSP",
                status="未开始",
                sort_order=1,
            )
        )
        db.commit()
    body = payload_from(client.get(url(pid), headers=auth_headers).json())
    body["sub_projects"].reverse()  # 第二个移到最前，其任务随之移动
    res = client.put(url(pid), json=body, headers=auth_headers)
    assert res.status_code == 200, res.text
    assert res.json()["result"]["reordered"] is True and res.json()["result"]["updated_tasks"] == 0
    assert [
        s["name"] for s in sorted(res.json()["sub_projects"], key=lambda s: s["sort_order"])
    ] == ["第二个", "测试子项目"]
    with SessionLocal() as db:
        assert {
            t.sub_project_id for t in db.query(Task).filter(Task.id.in_([f"{pid}-t1", f"{pid}-t2"]))
        } == {f"{pid}-sp"}
    # 在两个子项目之间插入新子项目
    body = payload_from(res.json())
    body["sub_projects"].insert(
        1, {"key": "k-mid", "name": "插入的", "module": "DP", "stage": "IND", "tasks": []}
    )
    res = client.put(url(pid), json=body, headers=auth_headers)
    assert res.status_code == 200, res.text
    assert (
        res.json()["result"]["reordered"] is False
        and res.json()["result"]["created_sub_projects"] == 1
    )
    assert [
        s["name"] for s in sorted(res.json()["sub_projects"], key=lambda s: s["sort_order"])
    ] == ["第二个", "插入的", "测试子项目"]
