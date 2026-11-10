"""Deterministic work priorities from tasks the current user can see."""

from datetime import date, timedelta
from typing import Annotated
from urllib.parse import quote

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import case, func, or_
from sqlalchemy.orm import Session

from app.models import Project, SubProject, Task, User
from app.services.pm_ai_context import DONE, assert_current_scope
from app.services.scope import _own_task_clause, visible_task_ids_for

DEADLINE_HORIZON_DAYS = 7
ScopeId = Annotated[str, Field(min_length=1, max_length=64)]


class TriageRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    project_ids: list[ScopeId] = Field(default_factory=list, max_length=100)
    task_ids: list[ScopeId] = Field(default_factory=list, max_length=100)
    limit: int = Field(default=5, strict=True, ge=1, le=20)
    mine_only: bool = False


def build_triage(db: Session, user: User, payload: TriageRequest) -> dict:
    project_ids, selected_tasks = assert_current_scope(db, user, payload)
    task_ids = selected_tasks or visible_task_ids_for(user, db)
    today = date.today()
    blocked = Task.status == "阻塞"
    overdue_or_delayed = or_(Task.planned_end < today, Task.status == "延迟")
    near_deadline = Task.planned_end <= today + timedelta(days=DEADLINE_HORIZON_DAYS)

    candidates = (
        db.query(
            Task.id.label("task_id"),
            Project.id.label("project_id"),
            Task.code,
            Task.name,
            Project.name.label("project_name"),
            Task.status,
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
            Project.status == "活跃",
            Task.id.in_(task_ids),
            Task.status.notin_(DONE),
            or_(blocked, overdue_or_delayed, near_deadline),
        )
    )
    if payload.mine_only:
        candidates = candidates.filter(_own_task_clause(user))
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
        if days < 0:
            reasons.append(f"逾期 {-days} 天")
        elif days == 0:
            reasons.append("今天到期")
        elif days <= DEADLINE_HORIZON_DAYS:
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
    }
