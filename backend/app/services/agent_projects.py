"""Task evidence for delegated agents and the logged-in report review."""

import hashlib
import json
import re
from datetime import UTC, date, datetime
from urllib.parse import quote, urlencode

from fastapi import HTTPException
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, defer

from app.api.v1.pm_management import register_view
from app.api.v1.task_collaboration import acceptance_out, utc_time
from app.models import Project, ProjectBaseline, SubProject, Task, TaskDependency, User
from app.models.pm_management import PMRegisterEntry
from app.models.task_collaboration import TaskAcceptance, TaskActivity, TaskDeliverable
from app.services.scope import is_full_access, visible_project_ids_for, visible_task_ids_for
from app.services.task_deadlines import is_overdue, overdue_clause
from app.services.team import team_ids

REPORT_LIMIT = 50
EVIDENCE_TEXT_LIMIT = 5000
TASK_STATUS_MEANINGS = {
    "未开始": "工作尚未开始",
    "进行中": "工作正在进行",
    "阻塞": "任务记录为受阻",
    "延迟": "任务记录为延迟；逾期按计划完成日另行判断",
    "已完成": "工作已完成；如设有验收要求，可另查验收状态",
    "已验证": "任务已验证",
}
TASK_EXECUTION_ACTIONS = ("update_progress", "attach_deliverable", "submit_acceptance")
TASK_PLAN_ACTIONS = ("reassign_task", "schedule")
ACTIVITY_CHANGE_FIELDS = frozenset(
    {
        "name",
        "status",
        "progress",
        "owner_id",
        "priority",
        "planned_start",
        "planned_end",
        "actual_start",
        "actual_end",
    }
)


def project_link(project_id: str, **query: str) -> str:
    path = "/projects/" + quote(project_id, safe="")
    return path + ("?" + urlencode(query) if query else "")


def project_evidence(project: Project) -> dict:
    return {
        "id": project.id,
        "code": project.code,
        "name": project.name,
        "url": project_link(project.id),
    }


def page_of(db, statement, page, page_size):
    total = db.scalar(select(func.count()).select_from(statement.order_by(None).subquery()))
    rows = db.execute(statement.offset((page - 1) * page_size).limit(page_size)).all()
    return rows, {
        "page": page,
        "page_size": page_size,
        "total": total,
        "has_more": page * page_size < total,
    }


def project_page(db, user, page, page_size):
    statement = select(Project).order_by(Project.code, Project.id)
    if not is_full_access(user):
        statement = statement.where(Project.id.in_(visible_project_ids_for(user, db)))
    rows, meta = page_of(db, statement, page, page_size)
    return {"items": [project_evidence(project) for (project,) in rows], "meta": meta}


def permitted_project(db: Session, user: User, project_id: str) -> Project:
    if not is_full_access(user) and project_id not in visible_project_ids_for(user, db):
        raise HTTPException(404, "项目不存在或无权访问")
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(404, "项目不存在或无权访问")
    return project


def project_context(db, user, project, page, page_size):
    sub_projects = select(SubProject).where(SubProject.project_id == project.id)
    if not is_full_access(user) and user.role != "project_lead":
        sub_projects = sub_projects.where(
            SubProject.id.in_(
                select(Task.sub_project_id).where(Task.id.in_(visible_task_ids_for(user, db)))
            )
        )
    subs, sub_meta = page_of(
        db, sub_projects.order_by(SubProject.sort_order, SubProject.id), page, page_size
    )
    members, member_meta = page_of(
        db,
        select(User.id, User.display_name)
        .where(User.id.in_(team_ids(db, project)), User.is_active.is_(True))
        .order_by(User.display_name, User.id),
        page,
        page_size,
    )
    manager = may_save_report(user, project)
    return {
        "project": project_evidence(project),
        "sub_projects": {"items": [sub for (sub,) in subs], "meta": sub_meta},
        "members": {
            "items": [
                {"id": ident, "display_name": name, "is_project_owner": ident == project.owner_id}
                for ident, name in members
            ],
            "meta": member_meta,
        },
        "capabilities": {
            "proposal_actions": (
                ["create_task", "register_risk", *TASK_PLAN_ACTIONS, *TASK_EXECUTION_ACTIONS]
                if manager
                else []
            ),
            "task_capabilities_at_detail": True,
            "can_assign_members": manager,
            "review_risk_report": manager,
        },
        "task_statuses": TASK_STATUS_MEANINGS,
    }


def scoped_tasks(db, user):
    statement = (
        select(Task, Project)
        .select_from(Task)
        .join(SubProject, SubProject.id == Task.sub_project_id)
        .join(Project, Project.id == SubProject.project_id)
    )
    if not is_full_access(user):
        statement = statement.where(Task.id.in_(visible_task_ids_for(user, db)))
    return statement


def task_evidence(task: Task, project: Project, today: date) -> dict:
    overdue = is_overdue(task, today)
    return {
        "id": task.id,
        "code": task.code,
        "name": task.name,
        "project": project_evidence(project),
        "planned_start": task.planned_start,
        "planned_end": task.planned_end,
        "actual_end": task.actual_end,
        "status": task.status,
        "progress": task.progress,
        "is_milestone": task.is_milestone,
        "overdue": overdue,
        "overdue_days": (today - task.planned_end).days if overdue else 0,
        "revision": task.revision,
        "url": project_link(project.id, tab="wbs", task=task.id),
    }


def task_summary(task: Task, project: Project, today: date) -> dict:
    return {
        **task_evidence(task, project, today),
        "owner_id": task.owner_id,
        "sub_project_id": task.sub_project_id,
        "priority": task.priority,
    }


def task_page(
    db,
    user,
    project_id,
    overdue,
    page,
    page_size,
    today,
    *,
    sub_project_id=None,
    owner_id=None,
    status=None,
    due_from=None,
    due_to=None,
):
    statement = scoped_tasks(db, user)
    if project_id is not None:
        permitted_project(db, user, project_id)
        statement = statement.where(Project.id == project_id)
    if overdue is not None:
        condition = overdue_clause(today)
        statement = statement.where(condition if overdue else ~condition)
    if sub_project_id is not None:
        statement = statement.where(Task.sub_project_id == sub_project_id)
    if owner_id is not None:
        statement = statement.where(Task.owner_id == owner_id)
    if status is not None:
        statement = statement.where(Task.status == status)
    if due_from is not None:
        statement = statement.where(Task.planned_end >= due_from)
    if due_to is not None:
        statement = statement.where(Task.planned_end <= due_to)
    rows, meta = page_of(db, statement.order_by(Task.planned_end, Task.id), page, page_size)
    return {"items": [task_summary(task, project, today) for task, project in rows], "meta": meta}


def find_task(db, user, task_id):
    row = db.execute(scoped_tasks(db, user).where(Task.id == task_id)).first()
    if row is None:
        raise HTTPException(404, "任务不存在或无权访问")
    return row


def _task_dependencies(db, user, task_id, page, page_size):
    deps = select(TaskDependency).where(
        or_(TaskDependency.predecessor_id == task_id, TaskDependency.successor_id == task_id)
    )
    if not is_full_access(user):
        visible = visible_task_ids_for(user, db)
        deps = deps.where(
            TaskDependency.predecessor_id.in_(visible), TaskDependency.successor_id.in_(visible)
        )
    rows, meta = page_of(db, deps.order_by(TaskDependency.id), page, page_size)
    return {"items": [dep for (dep,) in rows], "meta": meta}


def activity_changes(activity: TaskActivity) -> dict:
    """Expose scalar values only, for fields shared by the Agent activity and event views."""
    if not isinstance(activity.changes, dict):
        return {}
    changes = {}
    for field in ACTIVITY_CHANGE_FIELDS & activity.changes.keys():
        item = activity.changes[field]
        if not isinstance(item, dict):
            continue
        values = {key: item[key] for key in ("before", "after") if key in item}
        if values and all(
            value is None or type(value) in {str, int, bool} for value in values.values()
        ):
            changes[field] = {
                key: value[:200] if isinstance(value, str) else value
                for key, value in values.items()
            }
    return changes


def _task_activities(db, task_id, page, page_size):
    rows, meta = page_of(
        db,
        select(TaskActivity)
        .where(TaskActivity.task_id == task_id)
        .order_by(TaskActivity.created_at.desc(), TaskActivity.id.desc()),
        page,
        page_size,
    )
    return {
        "items": [
            {
                "id": row.id,
                "actor_id": row.actor_id,
                "kind": row.kind,
                "body": row.body[:EVIDENCE_TEXT_LIMIT],
                "changes": activity_changes(row),
                "created_at": utc_time(row.created_at),
            }
            for (row,) in rows
        ],
        "meta": meta,
    }


def _task_deliverables(db, task_id, page, page_size):
    rows, meta = page_of(
        db,
        select(TaskDeliverable)
        .options(defer(TaskDeliverable.content))
        .where(TaskDeliverable.task_id == task_id)
        .order_by(TaskDeliverable.created_at.desc(), TaskDeliverable.id.desc()),
        page,
        page_size,
    )
    return {"items": [row for (row,) in rows], "meta": meta}


def task_context(db, user, task, project, today, page, page_size):
    proposal_actions = []
    if may_save_report(user, project):
        proposal_actions.extend([*TASK_PLAN_ACTIONS, *TASK_EXECUTION_ACTIONS])
    elif user.role in ("rd", "production", "qa_qc") and (
        user.id == task.owner_id or user.id in (task.collaborator_ids or [])
    ):
        proposal_actions.extend(TASK_EXECUTION_ACTIONS)
    return {
        "task": {
            **task_summary(task, project, today),
            "sub_project_name": task.sub_project.name,
            "owner_name": task.owner.display_name,
            "actual_start": task.actual_start,
            "is_critical_path": task.is_critical_path,
            "notes": task.notes[:EVIDENCE_TEXT_LIMIT] if task.notes is not None else None,
            "notes_truncated": len(task.notes or "") > EVIDENCE_TEXT_LIMIT,
        },
        "dependencies": _task_dependencies(db, user, task.id, page, page_size),
        "activities": _task_activities(db, task.id, page, page_size),
        "deliverables": _task_deliverables(db, task.id, page, page_size),
        "acceptance": acceptance_out(db.get(TaskAcceptance, task.id)),
        "proposal_actions": proposal_actions,
    }


def register_page(db, project, kind, status, page, page_size):
    statement = select(PMRegisterEntry).where(PMRegisterEntry.project_id == project.id)
    if kind is not None:
        statement = statement.where(PMRegisterEntry.kind == kind)
    if status is not None:
        statement = statement.where(PMRegisterEntry.status == status)
    rows, meta = page_of(
        db, statement.order_by(PMRegisterEntry.due_date, PMRegisterEntry.id), page, page_size
    )
    return {
        "project": project_evidence(project),
        "items": [register_view(row) for (row,) in rows],
        "meta": meta,
    }


def _baseline_date(item, field):
    try:
        return date.fromisoformat(item.get(field, ""))
    except (TypeError, ValueError):
        return None


def compare_baseline(db, task: Task, project: Project, baseline_id: str | None):
    statement = select(ProjectBaseline).where(ProjectBaseline.project_id == project.id)
    if baseline_id is not None:
        statement = statement.where(ProjectBaseline.id == baseline_id)
    baseline = db.scalars(
        statement.order_by(ProjectBaseline.created_at.desc(), ProjectBaseline.id.desc()).limit(1)
    ).first()
    if baseline is None:
        if baseline_id is not None:
            raise HTTPException(404, "基线不存在或无权访问")
        return {"status": "no_baseline", "baseline": None, "variance": None}
    source = {"id": baseline.id, "label": baseline.label, "created_at": baseline.created_at}
    snapshot = baseline.snapshot if isinstance(baseline.snapshot, dict) else {}
    # Older snapshots may only have milestone dates. Never return an entire snapshot.
    for field in ("tasks", "milestones"):
        entries = snapshot.get(field)
        if not isinstance(entries, list):
            continue
        for item in entries:
            if not isinstance(item, dict) or item.get("id") != task.id:
                continue
            start, end = _baseline_date(item, "plannedStart"), _baseline_date(item, "plannedEnd")
            if start is not None and end is not None:
                return {
                    "status": "compared",
                    "baseline": source,
                    "variance": {
                        "planned_start": start,
                        "planned_end": end,
                        "start_delta_days": (task.planned_start - start).days,
                        "end_delta_days": (task.planned_end - end).days,
                    },
                }
    return {"status": "task_not_in_baseline", "baseline": source, "variance": None}


def may_save_report(user: User, project: Project) -> bool:
    return is_full_access(user) or (user.role == "project_lead" and project.owner_id == user.id)


def _markdown_text(value: str) -> str:
    return re.sub(r"([\\`*_{}\[\]()<>#+.!|~-])", r"\\\1", " ".join(value.split()))


def risk_report(db: Session, user: User, project: Project) -> dict:
    today = date.today()
    rows = db.execute(
        scoped_tasks(db, user)
        .where(Project.id == project.id, overdue_clause(today))
        .add_columns(func.count().over().label("overdue_count"))
        .order_by(Task.planned_end, Task.id)
        .limit(REPORT_LIMIT)
    ).all()
    total = rows[0].overdue_count if rows else 0
    evidence = [task_evidence(task, row_project, today) for task, row_project, _ in rows]
    content = [
        f"# {_markdown_text(project.name)} · 逾期任务报告",
        "",
        f"截至 {today}，在当前账号可见任务中发现 **{total}** 项逾期。",
        "",
    ]
    if total > len(evidence):
        content.extend([f"以下列出计划完成日期最早的 {len(evidence)} 项。", ""])
    for item in evidence:
        content.append(
            f"- [{_markdown_text(item['code'] + ' ' + item['name'])}]({item['url']})"
            f" · 计划完成 {item['planned_end']} · {_markdown_text(item['status'])}"
            f" · 完成度 {item['progress']}% · 逾期 {item['overdue_days']} 天"
        )
    report = {
        "project": project_evidence(project),
        "as_of_date": today.isoformat(),
        "overdue_count": total,
        "truncated": total > len(evidence),
        "items": evidence,
        "content": "\n".join(content),
    }
    if may_save_report(user, project):
        canonical = json.dumps([user.id, report], ensure_ascii=False, sort_keys=True, default=str)
        report["review_key"] = hashlib.sha256(canonical.encode()).hexdigest()
    return {"as_of": datetime.now(UTC), **report}
