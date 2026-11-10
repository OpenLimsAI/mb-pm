"""Task evidence for delegated agents and the logged-in report review."""

import hashlib
import json
import re
from datetime import UTC, date, datetime
from urllib.parse import quote, urlencode

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import Project, ProjectBaseline, SubProject, Task, User
from app.services.scope import is_full_access, visible_project_ids_for, visible_task_ids_for
from app.services.task_deadlines import is_overdue, overdue_clause

REPORT_LIMIT = 50


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


def task_page(db, user, project_id, overdue, page, page_size, today):
    statement = scoped_tasks(db, user)
    if project_id is not None:
        permitted_project(db, user, project_id)
        statement = statement.where(Project.id == project_id)
    if overdue is not None:
        condition = overdue_clause(today)
        statement = statement.where(condition if overdue else ~condition)
    rows, meta = page_of(db, statement.order_by(Task.planned_end, Task.id), page, page_size)
    return {"items": [task_evidence(task, project, today) for task, project in rows], "meta": meta}


def find_task(db, user, task_id):
    row = db.execute(scoped_tasks(db, user).where(Task.id == task_id)).first()
    if row is None:
        raise HTTPException(404, "任务不存在或无权访问")
    return row


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
