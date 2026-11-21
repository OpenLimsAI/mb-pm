"""Deterministic work priorities from tasks the current user can see."""

from datetime import date, timedelta
from typing import Annotated, Literal
from urllib.parse import quote

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import case, func, or_, true
from sqlalchemy.orm import Session

from app.models import Project, SubProject, Task, User
from app.services.pm_ai_context import DONE, assert_current_scope
from app.services.scope import _own_task_clause, visible_task_ids_for
from app.services.task_deadlines import is_overdue, overdue_clause

DEADLINE_HORIZON_DAYS = 7
ScopeId = Annotated[str, Field(min_length=1, max_length=64)]
TaskFilter = Literal["attention", "overdue", "delayed", "blocked"]


class TriageRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    project_ids: list[ScopeId] = Field(default_factory=list, max_length=100)
    task_ids: list[ScopeId] = Field(default_factory=list, max_length=100)
    limit: int = Field(default=5, strict=True, ge=1, le=20)
    mine_only: bool = False
    owner_id: ScopeId | None = None
    priority: Literal["高", "中", "低"] | None = None
    start_date: date | None = None
    end_date: date | None = None

    @model_validator(mode="after")
    def valid_filters(self):
        if (
            bool(self.start_date) != bool(self.end_date)
            or self.start_date
            and (self.start_date > self.end_date or (self.end_date - self.start_date).days > 366)
        ):
            raise ValueError("计划完成日期需要完整起止范围，最多一年")
        if self.owner_id and self.mine_only:
            raise ValueError("本人及指定负责人条件不能混用")
        return self

    task_filter: TaskFilter = Field(
        default="attention",
        description="attention 为活跃项目重点；overdue 为当前逾期；delayed 包含标记延迟及逾期；blocked 仅阻塞任务",
    )


def build_triage(db: Session, user: User, payload: TriageRequest) -> dict:
    project_ids, selected_tasks = assert_current_scope(db, user, payload)
    task_ids = selected_tasks or visible_task_ids_for(user, db)
    today = date.today()
    blocked = Task.status == "阻塞"
    overdue_or_delayed = or_(overdue_clause(today), Task.status == "延迟")
    near_deadline = (Task.planned_end >= today) & (
        Task.planned_end <= today + timedelta(days=DEADLINE_HORIZON_DAYS)
    )
    condition = {
        "attention": true()
        if payload.start_date
        else or_(blocked, overdue_or_delayed, near_deadline),
        "overdue": overdue_clause(today),
        "delayed": overdue_or_delayed,
        "blocked": blocked,
    }[payload.task_filter]

    candidates = (
        db.query(
            Task.id.label("task_id"),
            Project.id.label("project_id"),
            Task.code,
            Task.name,
            Project.name.label("project_name"),
            Task.status,
            Task.progress,
            Task.planned_end,
            User.display_name.label("owner_name"),
            Task.is_milestone,
            Task.is_critical_path,
            func.count().over().label("total_candidates"),
        )
        .join(SubProject, Task.sub_project_id == SubProject.id)
        .join(Project, SubProject.project_id == Project.id)
        .join(User, Task.owner_id == User.id)
        .filter(
            Project.id.in_(project_ids),
            Task.id.in_(task_ids),
            Task.status.notin_(DONE),
            condition,
        )
    )
    if payload.task_filter == "attention":
        candidates = candidates.filter(Project.status == "活跃")
    if payload.mine_only:
        candidates = candidates.filter(_own_task_clause(user))
    owner_name = None
    if payload.owner_id:
        owners = candidates.filter(Task.owner_id == payload.owner_id)
        # Validate visibility independently of status/date filtering: an empty result is valid.
        owner = (
            db.query(User)
            .join(Task, Task.owner_id == User.id)
            .join(SubProject, Task.sub_project_id == SubProject.id)
            .filter(
                User.id == payload.owner_id,
                Task.id.in_(task_ids),
                SubProject.project_id.in_(project_ids),
            )
            .first()
        )
        if not owner:
            raise HTTPException(404, "负责人不存在或不在当前可见任务范围")
        candidates, owner_name = owners, owner.display_name
    if payload.priority:
        candidates = candidates.filter(Task.priority == payload.priority)
    if payload.start_date:
        candidates = candidates.filter(
            Task.planned_end >= payload.start_date, Task.planned_end <= payload.end_date
        )
    rank = case(
        (blocked, 0),
        (overdue_or_delayed, 1),
        (or_(Task.is_milestone, Task.is_critical_path), 2),
        else_=3,
    )
    # After severity and date, codes and the task ID make ties stable across requests.
    rows = (
        candidates.order_by(rank, Task.planned_end, Project.code, Task.code, Task.id)
        .limit(payload.limit)
        .all()
    )
    items = []
    for row in rows:
        days = (row.planned_end - today).days
        reasons = []
        if row.status == "阻塞":
            reasons.append("已阻塞")
        if row.status == "延迟":
            reasons.append("标记延迟")
        if is_overdue(row, today):
            reasons.append(f"逾期 {-days} 天")
        elif days == 0:
            reasons.append("今天到期")
        elif 0 < days <= DEADLINE_HORIZON_DAYS:
            reasons.append(f"{days} 天后到期")
        if row.is_milestone:
            reasons.append("里程碑")
        if row.is_critical_path:
            reasons.append("标记为关键路径")
        items.append(
            {
                "task_id": row.task_id,
                "project_id": row.project_id,
                "code": row.code,
                "name": row.name,
                "project_name": row.project_name,
                "status": row.status,
                "planned_end": row.planned_end.isoformat(),
                "owner_name": row.owner_name,
                "reasons": reasons,
                "href": (
                    f"/projects/{quote(row.project_id, safe='')}"
                    f"?tab=wbs&task={quote(row.task_id, safe='')}"
                ),
            }
        )
    return {
        "business_date": today.isoformat(),
        "items": items,
        "total_candidates": rows[0].total_candidates if rows else 0,
        "limit": payload.limit,
        "mine_only": payload.mine_only,
        "task_filter": payload.task_filter,
        "filters": {
            "owner_id": payload.owner_id,
            "owner_name": owner_name,
            "priority": payload.priority,
            "start_date": payload.start_date.isoformat() if payload.start_date else None,
            "end_date": payload.end_date.isoformat() if payload.end_date else None,
        },
    }
