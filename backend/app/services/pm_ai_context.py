"""Bounded, permission-aware project facts and stable evidence references."""

import hashlib
import json
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal
from typing import Literal
from urllib.parse import quote

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import case, func, or_
from sqlalchemy.orm.attributes import set_committed_value

from app.core.config import settings
from app.core.security import DEFAULT_ROLE, ROLE_PRIORITY
from app.models import (
    AuditLog,
    IAMIdentity,
    PMRegisterEntry,
    Project,
    ProjectBaseline,
    ProjectMember,
    SubProject,
    Task,
    TaskAcceptance,
    TaskActivity,
    TaskDeliverable,
    TaskDependency,
    User,
)
from app.models.planning import ProjectCalendar
from app.services import accounts
from app.services.planning import calendar_dict
from app.services.scope import visible_project_ids_for, visible_task_ids_for
from app.services.task_deadlines import COMPLETED_STATUSES, is_overdue, overdue_clause

DONE = set(COMPLETED_STATUSES)
MAX_TASKS = 600
MAX_EVENTS = 300
MANAGERS = {"admin", "cmc_lead", "project_lead"}


class ContextBudgetExceeded(HTTPException):
    def __init__(self):
        super().__init__(422, "当前分析资料较多，请缩小项目、任务或时间范围")


class ContextRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    scenario: Literal["priorities", "explain", "weekly", "meeting", "followup"] = "priorities"
    project_ids: list[str] = Field(default_factory=list, max_length=100)
    task_ids: list[str] = Field(default_factory=list, max_length=100)
    start_date: date | None = None
    end_date: date | None = None
    question: str = Field(default="", max_length=2000)
    material: str = Field(default="", max_length=16000)

    @model_validator(mode="after")
    def valid_period(self):
        if self.start_date and self.end_date and self.start_date > self.end_date:
            raise ValueError("开始日期不能晚于结束日期")
        if self.start_date and self.end_date and (self.end_date - self.start_date).days > 366:
            raise ValueError("每次分析的时间范围最多一年")
        if self.scenario == "meeting" and not self.material:
            raise ValueError("请提供需要整理的会议文字")
        return self


def recheck_user(db, user_id):
    user = db.get(User, user_id)
    if not user or not user.is_active:
        raise HTTPException(403, "账号不可用，请重新登录")
    identities = (
        db.query(IAMIdentity).filter_by(issuer=settings.casdoor_issuer, user_id=user.id).all()
    )
    if len(identities) != 1:
        raise HTTPException(403, "登录身份无法确认，请重新登录")
    roles = accounts.live_roles(identities[0].subject)
    role = next((item for item in ROLE_PRIORITY if item in roles), DEFAULT_ROLE)
    set_committed_value(user, "role", role)
    return user


def assert_current_scope(db, user, request):
    projects = visible_project_ids_for(user, db)
    tasks = visible_task_ids_for(user, db)
    selected_projects = set(request.project_ids)
    selected_tasks = set(request.task_ids)
    if not selected_projects <= projects or not selected_tasks <= tasks:
        raise HTTPException(404, "所选项目或任务不存在或不可访问")
    if selected_tasks:
        related = {
            row.project_id
            for row in db.query(SubProject.project_id)
            .join(Task)
            .filter(Task.id.in_(selected_tasks))
        }
        if selected_projects and not related <= selected_projects:
            raise HTTPException(422, "所选任务须属于所选项目")
        if not selected_projects:
            selected_projects = related
    return selected_projects or projects, selected_tasks


def json_value(value):
    if isinstance(value, date | datetime):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    return value


def fields(row, names):
    return {name: json_value(getattr(row, name)) for name in names}


def fingerprint(value):
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True, default=str).encode()
    ).hexdigest()


def build_context(db, user, request):
    project_ids, task_ids = assert_current_scope(db, user, request)
    visible_tasks = visible_task_ids_for(user, db)
    today = date.today()
    now = datetime.now(UTC).isoformat()
    start = request.start_date or today - timedelta(days=7)
    end = request.end_date or today
    refs = []
    truncated = []

    def reference(kind, row, title, href, revision=None):
        value = {
            "id": f"{kind}:{row.id}",
            "type": kind,
            "entity_id": row.id,
            "title": title,
            "href": href,
            "observed_at": now,
        }
        if revision is not None:
            value["revision"] = revision
        refs.append(value)
        return value["id"]

    def task_link(pid, tid):
        return f"/projects/{quote(pid, safe='')}?tab=wbs&task={quote(tid, safe='')}"

    project_rows = (
        db.query(Project)
        .filter(Project.id.in_(project_ids))
        .order_by(Project.code, Project.id)
        .all()
    )
    subs = (
        db.query(SubProject)
        .filter(SubProject.project_id.in_(project_ids))
        .order_by(SubProject.id)
        .all()
    )
    sub_projects = {row.id: row.project_id for row in subs}
    query = db.query(Task).filter(Task.sub_project_id.in_(sub_projects), Task.id.in_(visible_tasks))
    if task_ids:
        edges = (
            db.query(TaskDependency)
            .filter(
                or_(
                    TaskDependency.predecessor_id.in_(task_ids),
                    TaskDependency.successor_id.in_(task_ids),
                )
            )
            .all()
        )
        related_ids = {edge.predecessor_id for edge in edges} | {
            edge.successor_id for edge in edges
        }
        query = query.filter(Task.id.in_(task_ids | related_ids))
    total_tasks = query.count()
    task_rows = query.order_by(Task.planned_end, Task.id).limit(MAX_TASKS).all()
    if total_tasks > len(task_rows):
        truncated.append(f"任务仅纳入按计划结束时间排序的前 {MAX_TASKS} 条，请缩小项目或任务范围")
    ids = [row.id for row in task_rows]
    manager = user.role in MANAGERS
    selected = []
    for row in task_rows:
        names = (
            "id",
            "code",
            "name",
            "sub_project_id",
            "owner_id",
            "collaborator_ids",
            "status",
            "priority",
            "planned_start",
            "planned_end",
            "actual_start",
            "actual_end",
            "progress",
            "estimated_effort",
            "actual_effort",
            "revision",
            "is_milestone",
            "is_critical_path",
            "updated_at",
        )
        item = fields(row, names)
        item["project_id"] = sub_projects[row.sub_project_id]
        item["notes"] = (row.notes or "")[:800]
        if len(row.notes or "") > 800:
            truncated.append(f"任务 {row.code} 的备注仅纳入前 800 字")
        item["overdue"] = is_overdue(row, today)
        item["days_to_start"] = (row.planned_start - today).days
        item["days_to_end"] = (row.planned_end - today).days
        item["evidence_id"] = reference(
            "task",
            row,
            f"{row.code} · {row.name}",
            task_link(item["project_id"], row.id),
            row.revision,
        )
        if manager:
            item.update(fields(row, ("cost_budget", "actual_cost")))
        selected.append(item)
    stats = query.with_entities(
        func.count(Task.id),
        func.sum(case((Task.status.in_(DONE), 1), else_=0)),
        func.sum(case((overdue_clause(today), 1), else_=0)),
        func.sum(case((Task.status.in_(["延迟", "阻塞"]), 1), else_=0)),
    ).one()
    metrics = {
        "visible_tasks": stats[0],
        "completed_tasks": stats[1] or 0,
        "overdue_tasks": stats[2] or 0,
        "delayed_or_blocked_tasks": stats[3] or 0,
    }
    dependencies = []
    task_names = {row.id: row.name for row in task_rows}
    task_projects = {row.id: sub_projects[row.sub_project_id] for row in task_rows}
    for row in (
        db.query(TaskDependency)
        .filter(TaskDependency.predecessor_id.in_(ids), TaskDependency.successor_id.in_(ids))
        .order_by(TaskDependency.id)
        .all()
    ):
        item = fields(row, ("id", "predecessor_id", "successor_id", "type", "lag_days"))
        item["evidence_id"] = reference(
            "dependency",
            row,
            f"{task_names[row.predecessor_id]} → {task_names[row.successor_id]}",
            task_link(task_projects[row.successor_id], row.successor_id),
        )
        dependencies.append(item)
    entries_query = (
        db.query(PMRegisterEntry)
        .filter(PMRegisterEntry.project_id.in_(project_ids))
        .order_by(PMRegisterEntry.due_date, PMRegisterEntry.id)
    )
    entry_total = entries_query.count()
    entries = []
    for row in entries_query.limit(200):
        item = fields(
            row,
            (
                "id",
                "project_id",
                "kind",
                "title",
                "owner_id",
                "due_date",
                "severity",
                "status",
                "revision",
                "updated_at",
            ),
        )
        item["mitigation"], item["closure"] = row.mitigation[:1000], row.closure[:1000]
        if len(row.mitigation) > 1000 or len(row.closure) > 1000:
            truncated.append(f"事项 {row.id} 的处理记录仅纳入前 1000 字")
        item["evidence_id"] = reference(
            "register",
            row,
            row.title,
            f"/projects/{quote(row.project_id, safe='')}?tab=management",
            row.revision,
        )
        entries.append(item)
    if entry_total > len(entries):
        truncated.append("风险、问题和决策仅纳入前 200 条")
    local_zone = datetime.now().astimezone().tzinfo
    period_start = datetime.combine(start, time.min, tzinfo=local_zone).astimezone(UTC)
    period_end = datetime.combine(end + timedelta(days=1), time.min, tzinfo=local_zone).astimezone(
        UTC
    )
    event_query = (
        db.query(TaskActivity)
        .filter(
            TaskActivity.task_id.in_(ids),
            TaskActivity.created_at >= period_start,
            TaskActivity.created_at < period_end,
        )
        .order_by(TaskActivity.created_at.desc(), TaskActivity.id)
    )
    event_total = event_query.count()
    events = []
    by_id = {row.id: row for row in task_rows}
    for row in event_query.limit(MAX_EVENTS):
        item = fields(row, ("id", "task_id", "actor_id", "kind", "created_at"))
        item["body"] = (row.body or "")[:1200]
        if len(row.body or "") > 1200:
            truncated.append(f"变更 {row.id} 的正文仅纳入前 1200 字")
        item["changes"] = {
            key: value
            for key, value in (row.changes or {}).items()
            if manager or key not in {"cost_budget", "actual_cost"}
        }
        item["evidence_id"] = reference(
            "activity",
            row,
            f"{by_id[row.task_id].name} · {row.kind}",
            task_link(sub_projects[by_id[row.task_id].sub_project_id], row.task_id),
        )
        events.append(item)
    if event_total > len(events):
        truncated.append(f"期间变更仅纳入最近 {MAX_EVENTS} 条")
    register_history = []
    register_fields = {
        "title",
        "owner_id",
        "due_date",
        "severity",
        "status",
        "mitigation",
        "closure",
        "kind",
        "revision",
    }
    audit_query = (
        db.query(AuditLog)
        .filter(
            AuditLog.target_id.in_(project_ids),
            AuditLog.action.in_(["创建项目跟进事项", "更新项目跟进事项", "确认 AI 项目建议"]),
            AuditLog.created_at >= period_start,
            AuditLog.created_at < period_end,
        )
        .order_by(AuditLog.created_at.desc(), AuditLog.id)
    )
    if audit_query.count() > 100:
        truncated.append("跟进事项变更仅纳入最近 100 条")
    for row in audit_query.limit(100):
        try:
            detail = json.loads(row.detail or "{}")
        except (ValueError, TypeError):
            continue
        if not isinstance(detail, dict):
            continue
        if row.action == "确认 AI 项目建议" and detail.get("kind") not in {
            "register_create",
            "register_update",
        }:
            continue
        item = {
            "id": row.id,
            "project_id": row.target_id,
            "action": row.action,
            "created_at": row.created_at.isoformat(),
        }
        for name in ("before", "after"):
            values = detail.get(name)
            item[name] = (
                {key: value for key, value in values.items() if key in register_fields}
                if isinstance(values, dict)
                else None
            )
        item["evidence_id"] = reference(
            "audit", row, row.action, f"/projects/{quote(row.target_id, safe='')}?tab=management"
        )
        register_history.append(item)
    deliverables = []
    deliverable_query = (
        db.query(TaskDeliverable)
        .filter(TaskDeliverable.task_id.in_(ids))
        .order_by(TaskDeliverable.created_at.desc())
    )
    if deliverable_query.count() > 200:
        truncated.append("交付物仅纳入最近 200 条摘要")
    for row in deliverable_query.limit(200):
        item = fields(row, ("id", "task_id", "title", "version", "created_at"))
        item["evidence_id"] = reference(
            "deliverable",
            row,
            row.title,
            task_link(sub_projects[by_id[row.task_id].sub_project_id], row.task_id),
        )
        deliverables.append(item)
    acceptances = [
        fields(row, ("task_id", "reviewer_id", "required_count", "state", "updated_at"))
        for row in db.query(TaskAcceptance).filter(TaskAcceptance.task_id.in_(ids)).all()
    ]
    project_data = []
    for row in project_rows:
        item = fields(
            row,
            (
                "id",
                "code",
                "name",
                "owner_id",
                "status",
                "current_stage",
                "target_stage",
                "updated_at",
                "progress_method",
            ),
        )
        item["evidence_id"] = reference(
            "project", row, f"{row.code} · {row.name}", f"/projects/{quote(row.id, safe='')}"
        )
        project_data.append(item)
    members_ids = (
        {row.owner_id for row in project_rows}
        | {row.owner_id for row in task_rows}
        | {item["owner_id"] for item in entries}
    )
    members_ids.update(
        row.user_id
        for row in db.query(ProjectMember).filter(ProjectMember.project_id.in_(project_ids))
    )
    for row in task_rows:
        members_ids.update(row.collaborator_ids or [])
    members = [
        {"id": row.id, "name": row.display_name}
        for row in db.query(User)
        .filter(User.id.in_(members_ids), User.is_active.is_(True))
        .order_by(User.id)
    ]
    baselines = []
    if manager:
        baseline_query = (
            db.query(ProjectBaseline)
            .filter(ProjectBaseline.project_id.in_(project_ids))
            .order_by(ProjectBaseline.created_at.desc())
        )
        if baseline_query.count() > 30:
            truncated.append("基线仅纳入最近 30 条摘要")
        for row in baseline_query.limit(30):
            item = fields(row, ("id", "project_id", "label", "created_at"))
            item["evidence_id"] = reference(
                "baseline",
                row,
                row.label,
                f"/projects/{quote(row.project_id, safe='')}?tab=baseline",
            )
            baselines.append(item)
    if request.material:
        refs.append(
            {
                "id": "material:meeting",
                "type": "material",
                "entity_id": "meeting",
                "title": "本次提供的会议文字",
                "href": "",
                "observed_at": now,
            }
        )
        lines = [
            (index, line)
            for index, line in enumerate(request.material.splitlines(), start=1)
            if line.strip()
        ]
        for index, line in lines[:200]:
            refs.append(
                {
                    "id": f"material:{index}",
                    "type": "material",
                    "entity_id": f"line-{index}",
                    "title": f"会议原文第 {index} 行",
                    "href": "",
                    "observed_at": now,
                    "excerpt": line[:400],
                }
            )
        if len(lines) > 200:
            truncated.append("会议逐行引用仅提供前 200 个非空行，完整原文仍包含在上下文中")
    context = {
        "schema_version": 1,
        "access_role": user.role,
        "project_ids": sorted(project_ids),
        "scope": {"project_ids": sorted(project_ids), "task_ids": sorted(task_ids)},
        "focus_task_ids": sorted(task_ids),
        "as_of": now,
        "business_date": today.isoformat(),
        "timezone": str(datetime.now().astimezone().tzinfo),
        "period": {"start_date": start.isoformat(), "end_date": end.isoformat()},
        "projects": project_data,
        "sub_projects": [fields(row, ("id", "project_id", "name")) for row in subs],
        "tasks": selected,
        "members": members,
        "dependencies": dependencies,
        "calendars": [
            {"project_id": pid, **calendar_dict(db.get(ProjectCalendar, pid))}
            for pid in sorted(project_ids)
        ],
        "register_entries": entries,
        "activities": events,
        "register_history": register_history,
        "deliverables": deliverables,
        "acceptances": acceptances,
        "baselines": baselines,
        "metrics": metrics,
        "material": request.material,
        "definitions": {
            "completed": "已完成或已验证",
            "overdue": "计划结束早于业务日期、状态未完成或未验证；普通任务完成度不足100%，里程碑须状态完成",
            "money_unit": "万元人民币",
            "effort_unit": "人日",
            "days_to_start": "计划开始日期减业务日期的自然日差，负数表示开始日期已过",
            "days_to_end": "计划结束日期减业务日期的自然日差，负数表示结束日期已过",
            "history": "只能根据实际记录解释变化，缺少历史记录不得推算过去状态",
        },
    }
    source = {
        "schema_version": 1,
        "as_of": now,
        "complete": not truncated,
        "truncated": truncated,
        "counts": {
            "projects": len(project_rows),
            "tasks": total_tasks,
            "included_tasks": len(task_rows),
            "activities": event_total,
        },
        "refs": refs,
    }
    source["fingerprint"] = fingerprint(
        {key: value for key, value in context.items() if key != "as_of"}
    )
    context["source"] = source
    if len(json.dumps(context, ensure_ascii=False, default=str)) > 120000:
        raise ContextBudgetExceeded()
    return context
