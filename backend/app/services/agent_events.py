"""Cursor-based pull subscriptions over the current user's visible task activity."""

from datetime import UTC, datetime, timedelta
from typing import Literal

from cryptography.fernet import InvalidToken
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as postgres_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from app.core.security import seal, unseal
from app.models import Project, SubProject, Task, TaskActivity
from app.models.agent_events import AgentEventPublication as Publication
from app.services.agent_projects import activity_changes, permitted_project, project_link
from app.services.scope import is_full_access, visible_task_ids_for

EventKind = Literal["delay", "deliverable", "approval", "task_update"]

PURPOSE = "agent-project-events-v1"
PUBLISH_BATCH = 200
HISTORY_DAYS = 90
CURSOR_IDLE_DAYS = 30
ACTIVITY_KINDS = ("change", "progress", "deliverable", "acceptance")


def _checkpoint(cursor, user_id, project_id, kind, days, now):
    binding = {"purpose": PURPOSE, "user_id": user_id, "project_id": project_id, "kind": kind}
    if not cursor:
        since = now - timedelta(days=days)
        return binding, since, 0
    try:
        data = unseal(cursor)
        if not isinstance(data, dict) or any(data.get(k) != v for k, v in binding.items()):
            raise ValueError("cursor scope mismatch")
        since = datetime.fromisoformat(data["since"])
        expires = datetime.fromisoformat(data["expires_at"])
        sequence = data["sequence"]
        if (
            since.tzinfo is None
            or expires.tzinfo is None
            or type(sequence) is not int
            or sequence < 0
        ):
            raise ValueError("invalid cursor position")
    except (InvalidToken, ValueError, TypeError, KeyError):
        raise HTTPException(422, "变更游标无效或与当前账号、项目和类型不匹配") from None
    if expires <= now:
        raise HTTPException(410, "变更游标已过期，请重新选择历史范围")
    return binding, since, sequence


def _kind(activity):
    if activity.kind == "deliverable":
        return "deliverable"
    if activity.kind == "acceptance":
        return "approval"
    changes = activity_changes(activity)
    end = changes.get("planned_end", {})
    before, after = end.get("before"), end.get("after")
    status = changes.get("status", {})
    if (isinstance(before, str) and isinstance(after, str) and after > before) or (
        status.get("after") == "延迟" and status.get("before") != "延迟"
    ):
        return "delay"
    return "task_update"


def _visible_activities(db, user, project_id, since):
    query = (
        select(TaskActivity)
        .join(Task, TaskActivity.task_id == Task.id)
        .join(SubProject, Task.sub_project_id == SubProject.id)
        .where(
            SubProject.project_id == project_id,
            TaskActivity.created_at >= since,
            TaskActivity.kind.in_(ACTIVITY_KINDS),
        )
    )
    if not is_full_access(user):
        query = query.where(TaskActivity.task_id.in_(visible_task_ids_for(user, db)))
    return query


def _publish(db, base_query, project_id):
    rows = db.scalars(
        base_query.where(
            ~select(Publication.activity_id)
            .where(Publication.activity_id == TaskActivity.id)
            .exists()
        )
        .order_by(TaskActivity.created_at, TaskActivity.id)
        .limit(PUBLISH_BATCH + 1)
    ).all()
    if rows:
        insert = postgres_insert if db.get_bind().dialect.name == "postgresql" else sqlite_insert
        statement = insert(Publication).values(
            [
                {"project_id": project_id, "activity_id": activity.id, "kind": _kind(activity)}
                for activity in rows[:PUBLISH_BATCH]
            ]
        )
        db.execute(statement.on_conflict_do_nothing(index_elements=[Publication.activity_id]))
    return len(rows) > PUBLISH_BATCH


def changes(
    db, user, project_id: str, cursor: str | None, kind: EventKind | None, limit: int, days: int
):
    permitted_project(db, user, project_id)
    now = datetime.now(UTC)
    binding, since, sequence = _checkpoint(cursor, user.id, project_id, kind, days, now)
    # Only committed activities are published. Serialize publication per project
    # so a delayed commit can never land behind a cursor already returned to a subscriber.
    locked = db.scalar(select(Project.id).where(Project.id == project_id).with_for_update())
    if locked is None:
        raise HTTPException(404, "项目不存在或无权访问")
    permitted_project(db, user, project_id)
    base = _visible_activities(db, user, project_id, since)
    unpublished = _publish(db, base, project_id)
    query = (
        base.join(Publication, Publication.activity_id == TaskActivity.id)
        .add_columns(Publication)
        .where(Publication.project_id == project_id, Publication.sequence > sequence)
        .order_by(Publication.sequence)
        .limit(limit + 1)
    )
    if kind:
        query = query.where(Publication.kind == kind)
    rows = db.execute(query).all()
    items = []
    for activity, published in rows[:limit]:
        created_at = activity.created_at
        if created_at.tzinfo is None:
            created_at = created_at.replace(tzinfo=UTC)
        items.append(
            {
                "id": activity.id,
                "kind": published.kind,
                "task_id": activity.task_id,
                "project_id": project_id,
                "occurred_at": created_at,
                "url": project_link(project_id, tab="wbs", task=activity.task_id),
                "changes": activity_changes(activity),
                "summary": activity.body[:500]
                if activity.kind in ("deliverable", "acceptance")
                else "",
            }
        )
        sequence = published.sequence
    next_cursor = seal(
        {
            **binding,
            "since": since.isoformat(),
            "sequence": sequence,
            "expires_at": (now + timedelta(days=CURSOR_IDLE_DAYS)).isoformat(),
        }
    )
    db.commit()
    return {
        "items": items,
        "next_cursor": next_cursor,
        "has_more": unpublished or len(rows) > limit,
    }
