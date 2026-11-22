"""Task collaboration, deliverable versioning, and milestone acceptance services."""

import json
from datetime import UTC, date, datetime
from urllib.parse import urlsplit
from uuid import uuid4

from fastapi import HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session, defer

from app.models import AuditLog, Project, SubProject, Task, User
from app.models.task_collaboration import TaskAcceptance, TaskActivity, TaskDeliverable
from app.services.rollup import rollup_for_task
from app.services.scope import is_full_access, visible_task_ids_for


class AcceptanceAction(BaseModel):
    action: str = Field(pattern="^(submit|accept|reject)$")
    comment: str = Field(default="", max_length=5000)


def lock_task_for_update(db: Session, task_id: str) -> Task | None:
    # All plan and execution writers lock the parent first. The first lookup does
    # not lock a task, so it cannot invert Project -> Task ordering used by planning.
    project_id = (
        db.query(SubProject.project_id)
        .join(Task, Task.sub_project_id == SubProject.id)
        .filter(Task.id == task_id)
        .scalar()
    )
    if project_id is None:
        return None
    project = db.query(Project).filter_by(id=project_id).with_for_update().first()
    if not project:
        return None
    return db.query(Task).filter_by(id=task_id).populate_existing().with_for_update().first()


def task_access(
    db: Session, user: User, task_id: str, write: bool = False, lock: bool = False
) -> Task:
    task = lock_task_for_update(db, task_id) if write or lock else db.get(Task, task_id)
    if not task:
        raise HTTPException(404, "任务不存在")
    if not is_full_access(user) and task_id not in visible_task_ids_for(user, db):
        raise HTTPException(403, "无权查看此任务")
    if (
        write
        and user.role not in ("admin", "cmc_lead", "project_lead")
        and user.id not in [task.owner_id, *(task.collaborator_ids or [])]
    ):
        raise HTTPException(403, "只能更新自己负责或协作的任务")
    return task


def record_activity(
    db: Session,
    task: Task,
    user: User,
    kind: str,
    body: str = "",
    changes: dict | None = None,
    mentions: list[str] | None = None,
) -> TaskActivity:
    item = TaskActivity(
        id=f"ta-{uuid4().hex}",
        task_id=task.id,
        actor_id=user.id,
        kind=kind,
        body=body,
        changes=changes or {},
        mention_ids=mentions or [],
    )
    db.add(item)
    if kind in ("acceptance", "deliverable", "comment"):
        db.add(
            AuditLog(
                id=f"log-{uuid4().hex[:12]}",
                actor_id=user.id,
                action={
                    "acceptance": "任务验收",
                    "deliverable": "提交交付物",
                    "comment": "任务讨论",
                }[kind],
                target="任务",
                target_id=task.id,
                detail=json.dumps(
                    {"body": body, "mention_ids": mentions or []}, ensure_ascii=False
                ),
                created_at=datetime.now(UTC),
            )
        )
    return item


def utc_time(value: datetime) -> str:
    return (value if value.tzinfo else value.replace(tzinfo=UTC)).isoformat()


def acceptance_out(row: TaskAcceptance | None) -> dict | None:
    if not row:
        return None
    return {
        "reviewer_id": row.reviewer_id,
        "required_count": row.required_count,
        "state": row.state,
        "comment": row.comment,
        "updated_at": utc_time(row.updated_at),
        "submitted_deliverable_ids": row.submitted_deliverable_ids or [],
    }


def invalidate_acceptance(db: Session, task: Task, user: User) -> None:
    row = db.get(TaskAcceptance, task.id)
    if row and row.state in ("submitted", "accepted"):
        row.state = "draft"
        row.updated_at = datetime.now(UTC)
        if task.status == "已验证":
            task.status = "已完成"
        record_activity(db, task, user, "acceptance", "任务或交付物发生变化，请重新提交验收")


def new_deliverable(
    db: Session, task: Task, user: User, title: str, notes: str, **values
) -> TaskDeliverable:
    title = title.strip()
    if not title or len(title) > 200 or len(notes) > 5000:
        raise HTTPException(422, "请填写不超过200字的交付物名称，说明不超过5000字")
    if db.query(TaskDeliverable).filter_by(task_id=task.id).count() >= 100:
        raise HTTPException(422, "单个任务最多保存100个交付物版本")
    version = (
        db.query(func.max(TaskDeliverable.version)).filter_by(task_id=task.id, title=title).scalar()
        or 0
    ) + 1
    row = TaskDeliverable(
        id=f"td-{uuid4().hex}",
        task_id=task.id,
        author_id=user.id,
        title=title,
        version=version,
        notes=notes,
        **values,
    )
    db.add(row)
    invalidate_acceptance(db, task, user)
    record_activity(db, task, user, "deliverable", f"提交交付物：{title} · v{version}")
    db.flush()
    return row


def validate_deliverable_link(link: str) -> None:
    try:
        url = urlsplit(link)
    except ValueError as exc:
        raise HTTPException(422, "链接格式无效") from exc
    if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password:
        raise HTTPException(422, "链接须为不含账号密码的 HTTP/HTTPS 地址")


def acceptance_deliverables(
    db: Session, row: TaskAcceptance, selected_ids: list[str] | None = None
) -> list[TaskDeliverable]:
    if row.state in ("submitted", "accepted"):
        raise HTTPException(409, "已提交或已通过验收，无需重复提交")
    files = (
        db.query(TaskDeliverable)
        .options(defer(TaskDeliverable.content))
        .filter_by(task_id=row.task_id)
        .all()
    )
    # Versions of the same deliverable count once.
    latest = {}
    for item in files:
        if item.title not in latest or item.version > latest[item.title].version:
            latest[item.title] = item
    if selected_ids is not None:
        by_id = {item.id: item for item in latest.values()}
        if any(item_id not in by_id for item_id in selected_ids):
            raise HTTPException(409, "交付物已更新或不属于当前任务，请选择最新版本")
        files = [by_id[item_id] for item_id in dict.fromkeys(selected_ids)]
    else:
        files = list(latest.values())
    if len(files) < row.required_count:
        raise HTTPException(422, f"需要至少 {row.required_count} 项不同名称的交付物")
    return files


def apply_acceptance_action(
    db: Session,
    task: Task,
    user: User,
    payload: AcceptanceAction,
    selected_ids: list[str] | None = None,
) -> TaskAcceptance:
    # The parent and task are locked before the acceptance row.
    row = db.query(TaskAcceptance).filter_by(task_id=task.id).with_for_update().first()
    if not row:
        raise HTTPException(422, "尚未设置验收要求")
    if payload.action == "submit":
        row.submitted_deliverable_ids = [
            item.id for item in acceptance_deliverables(db, row, selected_ids)
        ]
        row.state = "submitted"
    else:
        if user.id != row.reviewer_id:
            raise HTTPException(403, "仅指定验收人可处理")
        if row.state != "submitted":
            raise HTTPException(409, "当前没有等待处理的验收")
        if payload.action == "reject" and not payload.comment.strip():
            raise HTTPException(422, "退回时请填写原因")
        row.state = "accepted" if payload.action == "accept" else "rejected"
        if payload.action == "accept":
            old = task.status
            task.status = "已验证"
            task.progress = 100
            task.actual_end = task.actual_end or date.today()
            db.add(
                AuditLog(
                    id=f"log-{uuid4().hex[:12]}",
                    actor_id=user.id,
                    action="任务状态变更",
                    target="任务",
                    target_id=task.id,
                    detail=f"{old} → 已验证（指定验收人验收）",
                    created_at=datetime.now(UTC),
                )
            )
            db.flush()
            rollup_for_task(db, task)
    row.comment = payload.comment.strip()
    row.updated_at = datetime.now(UTC)
    record_activity(
        db,
        task,
        user,
        "acceptance",
        {"submit": "提交验收", "accept": "验收通过", "reject": "验收退回"}[payload.action]
        + (f"：{row.comment}" if row.comment else ""),
    )
    return row
