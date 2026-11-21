"""Small, live review catalog for one persisted analysis batch; never model input."""

from datetime import UTC, datetime

from fastapi import HTTPException

from app.models import PMRegisterEntry, Project, ProjectMember, SubProject, Task, User
from app.services import pm_ai_runs
from app.services.scope import visible_task_ids_for


def review_context(db, user, run_id, batch):
    run = pm_ai_runs.get_run(db, user, run_id)
    if run.state != "succeeded" or not run.result:
        raise HTTPException(409, "请在分析完成后核对修改")
    actions = run.result.get("draft_actions", [])
    if batch and batch * 12 >= len(actions):
        raise HTTPException(404, "核对批次不存在")
    selected = actions[batch * 12 : (batch + 1) * 12]
    task_ids = {action["task_id"] for action in selected if action.get("task_id")}
    entry_ids = {action["entry_id"] for action in selected if action.get("entry_id")}
    source_tasks = {row["id"] for row in run.context.get("tasks", [])}
    source_entries = {row["id"] for row in run.context.get("register_entries", [])}
    if not task_ids <= source_tasks or not entry_ids <= source_entries:
        raise HTTPException(409, "建议对象不在原分析资料中，请重新分析")
    scope = set(run.context["scope"]["project_ids"])
    tasks = (
        db.query(Task, SubProject.project_id)
        .join(SubProject)
        .filter(
            Task.id.in_(task_ids),
            Task.id.in_(visible_task_ids_for(user, db)),
            SubProject.project_id.in_(scope),
        )
        .all()
    )
    entries = (
        db.query(PMRegisterEntry)
        .filter(PMRegisterEntry.id.in_(entry_ids), PMRegisterEntry.project_id.in_(scope))
        .all()
    )
    if len(tasks) != len(task_ids) or len(entries) != len(entry_ids):
        raise HTTPException(404, "建议对象已删除或不再可见，请重新分析")
    project_ids = (
        {pid for _, pid in tasks}
        | {row.project_id for row in entries}
        | {action["project_id"] for action in selected if action.get("project_id")}
    )
    if not project_ids:
        project_ids = scope
    if not project_ids <= scope:
        raise HTTPException(404, "建议项目不在当前分析范围")
    projects = db.query(Project).filter(Project.id.in_(project_ids)).order_by(Project.id).all()
    subs = (
        db.query(SubProject)
        .filter(SubProject.project_id.in_(project_ids))
        .order_by(SubProject.id)
        .all()
    )
    member_ids = (
        {row.owner_id for row in projects}
        | {row.owner_id for row, _ in tasks}
        | {row.owner_id for row in entries}
    )
    member_ids.update(
        row.user_id
        for row in db.query(ProjectMember).filter(ProjectMember.project_id.in_(project_ids))
    )
    members = (
        db.query(User)
        .filter(User.id.in_(member_ids), User.is_active.is_(True))
        .order_by(User.id)
        .all()
    )
    return {
        "schema_version": 1,
        "as_of": datetime.now(UTC).isoformat(),
        "batch": batch,
        "projects": [
            {"id": p.id, "code": p.code, "name": p.name, "owner_id": p.owner_id} for p in projects
        ],
        "tasks": [
            {
                "id": t.id,
                "code": t.code,
                "name": t.name,
                "project_id": pid,
                "sub_project_id": t.sub_project_id,
                "owner_id": t.owner_id,
                "revision": t.revision,
            }
            for t, pid in tasks
        ],
        "register_entries": [
            {"id": e.id, "project_id": e.project_id, "title": e.title, "revision": e.revision}
            for e in entries
        ],
        "sub_projects": [{"id": s.id, "project_id": s.project_id, "name": s.name} for s in subs],
        "members": [{"id": m.id, "name": m.display_name} for m in members],
    }
