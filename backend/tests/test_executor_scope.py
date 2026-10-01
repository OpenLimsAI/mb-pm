"""执行者（rd / production / qa_qc）：被分配了任务的项目可见（即使未加入团队），任务仍只看本人。

与前端 src/lib/scope.ts 同一口径；否则执行者能看到任务却看不到所属项目 / 子项目，
个人看板、全局任务、甘特图都无法显示。
"""

from app.db.session import SessionLocal
from app.models import Task


def test_executor_sees_projects_of_own_tasks_but_only_own_tasks(
    client, iam_user, bearer, project_factory
):
    lead = iam_user("ex-pl", "project_lead")
    rd = iam_user("ex-rd", "rd")
    other_rd = iam_user("ex-rd2", "rd")
    assigned = project_factory(owner_id=lead, task_owner_id=rd)  # rd 负责任务，但不是团队成员
    unrelated = project_factory(owner_id=lead)  # 与 rd 无关
    db = SessionLocal()
    try:  # 同项目里别人的任务：项目可见，但该任务不可见
        db.get(Task, f"{assigned}-t2").owner_id = other_rd
        db.commit()
    finally:
        db.close()

    headers = bearer(rd, "rd")
    listed = client.get("/api/v1/projects", params={"page_size": 2000}, headers=headers).json()
    project_ids = {p["id"] for p in listed["items"]}
    assert assigned in project_ids
    assert unrelated not in project_ids
    assert client.get(f"/api/v1/projects/{assigned}", headers=headers).status_code == 200
    assert client.get(f"/api/v1/projects/{unrelated}", headers=headers).status_code == 403

    sub_project_ids = {
        s["project_id"] for s in client.get("/api/v1/sub-projects", headers=headers).json()
    }
    assert assigned in sub_project_ids
    assert unrelated not in sub_project_ids

    tasks = client.get("/api/v1/tasks", params={"page_size": 5000}, headers=headers).json()["items"]
    task_ids = {t["id"] for t in tasks}
    assert f"{assigned}-t1" in task_ids
    assert f"{assigned}-t2" not in task_ids
    assert all(t["owner_id"] == rd for t in tasks)


def test_project_lead_scope_is_unchanged(client, iam_user, bearer, project_factory):
    """项目负责人仍只看自己负责 / 参与的项目：在别人项目里负责任务不会扩大其可见范围。"""
    lead = iam_user("ex-pl3", "project_lead")
    other_lead = iam_user("ex-pl4", "project_lead")
    foreign = project_factory(owner_id=other_lead, task_owner_id=lead)
    headers = bearer(lead, "project_lead")
    listed = client.get("/api/v1/projects", params={"page_size": 2000}, headers=headers).json()
    assert foreign not in {p["id"] for p in listed["items"]}
    assert client.get(f"/api/v1/projects/{foreign}", headers=headers).status_code == 403
