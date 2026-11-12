"""Scoped task discussion, immutable deliverable versions and milestone acceptance."""

import json
from datetime import UTC, date, datetime
from pathlib import PurePath
from typing import Annotated
from urllib.parse import quote, urlsplit
from uuid import uuid4

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session, defer

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models import AuditLog, Project, SubProject, Task, User
from app.models.task_collaboration import TaskAcceptance, TaskActivity, TaskDeliverable
from app.services.rollup import rollup_for_task
from app.services.scope import is_full_access, visible_task_ids_for

router = APIRouter(prefix="/tasks", tags=["task collaboration"])
Db = Annotated[Session, Depends(get_db)]
CurrentUser = Annotated[User, Depends(get_current_user)]

MAX_FILE = 10 * 1024 * 1024
ALLOWED_FILES = {
    ".pdf",
    ".doc",
    ".docx",
    ".xls",
    ".xlsx",
    ".csv",
    ".txt",
    ".md",
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".ppt",
    ".pptx",
    ".zip",
}


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


@router.get("/{task_id}/collaboration")
def collaboration(task_id: str, db: Db, user: CurrentUser):
    task_access(db, user, task_id)
    activities = (
        db.query(TaskActivity)
        .filter_by(task_id=task_id)
        .order_by(TaskActivity.created_at.desc(), TaskActivity.id.desc())
        .limit(301)
        .all()
    )
    files = (
        db.query(TaskDeliverable)
        .options(defer(TaskDeliverable.content))
        .filter_by(task_id=task_id)
        .order_by(TaskDeliverable.created_at.desc(), TaskDeliverable.id.desc())
        .all()
    )
    return {
        "activities": [_activity_out(item) for item in activities[:300]],
        "next_activity_cursor": activities[299].id if len(activities) > 300 else None,
        "deliverables": [
            {
                "id": x.id,
                "author_id": x.author_id,
                "title": x.title,
                "version": x.version,
                "filename": x.filename,
                "link": x.link,
                "notes": x.notes,
                "created_at": utc_time(x.created_at),
            }
            for x in files
        ],
        "acceptance": acceptance_out(db.get(TaskAcceptance, task_id)),
    }


def _activity_out(item: TaskActivity) -> dict:
    return {
        "id": item.id,
        "actor_id": item.actor_id,
        "kind": item.kind,
        "body": item.body,
        "changes": item.changes,
        "mention_ids": item.mention_ids,
        "created_at": utc_time(item.created_at),
    }


@router.get("/{task_id}/activities")
def older_activities(task_id: str, db: Db, user: CurrentUser, before: str):
    task_access(db, user, task_id)
    cursor = db.get(TaskActivity, before)
    if not cursor or cursor.task_id != task_id:
        raise HTTPException(404, "历史记录不存在")
    rows = (
        db.query(TaskActivity)
        .filter(
            TaskActivity.task_id == task_id,
            or_(
                TaskActivity.created_at < cursor.created_at,
                and_(TaskActivity.created_at == cursor.created_at, TaskActivity.id < cursor.id),
            ),
        )
        .order_by(TaskActivity.created_at.desc(), TaskActivity.id.desc())
        .limit(101)
        .all()
    )
    return {
        "activities": [_activity_out(item) for item in rows[:100]],
        "next_activity_cursor": rows[99].id if len(rows) > 100 else None,
    }


class CommentInput(BaseModel):
    body: str = Field(min_length=1, max_length=5000)
    mention_ids: list[str] = Field(default_factory=list, max_length=30)


@router.post("/{task_id}/comments", status_code=201)
def add_comment(
    task_id: str,
    payload: CommentInput,
    db: Db,
    user: CurrentUser,
):
    task = task_access(db, user, task_id, write=True)
    if not payload.body.strip():
        raise HTTPException(422, "请填写讨论内容")
    mentions = list(dict.fromkeys(payload.mention_ids))
    for ident in mentions:
        person = db.get(User, ident)
        if not person or not person.is_active or task_id not in visible_task_ids_for(person, db):
            raise HTTPException(422, "只能提及可查看此任务的有效成员")
    item = record_activity(db, task, user, "comment", payload.body.strip(), mentions=mentions)
    db.commit()
    return {"id": item.id}


class LinkInput(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    link: str = Field(min_length=1, max_length=2000)
    notes: str = Field(default="", max_length=5000)


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


@router.post("/{task_id}/deliverables/link", status_code=201)
def add_link(
    task_id: str,
    payload: LinkInput,
    db: Db,
    user: CurrentUser,
):
    task = task_access(db, user, task_id, write=True)
    validate_deliverable_link(payload.link)
    row = new_deliverable(db, task, user, payload.title, payload.notes, link=payload.link)
    db.commit()
    return {"id": row.id, "version": row.version}


@router.post("/{task_id}/deliverables/file", status_code=201)
async def add_file(
    task_id: str,
    db: Db,
    user: CurrentUser,
    title: Annotated[str, Form(max_length=200)],
    file: Annotated[UploadFile, File()],
    notes: Annotated[str, Form(max_length=5000)] = "",
):
    task = task_access(db, user, task_id, write=True)
    filename = (file.filename or "").replace("\\", "/").rsplit("/", 1)[-1]
    filename = "".join(c for c in filename if ord(c) >= 32)[:240]
    if not filename or PurePath(filename).suffix.lower() not in ALLOWED_FILES:
        raise HTTPException(422, "文件格式不支持，请使用文档、表格、图片或 ZIP")
    content = await file.read(MAX_FILE + 1)
    if not content or len(content) > MAX_FILE:
        raise HTTPException(422, "文件不能为空且不能超过10 MB")
    existing_size = (
        db.query(func.coalesce(func.sum(func.length(TaskDeliverable.content)), 0))
        .filter_by(task_id=task_id)
        .scalar()
    )
    if existing_size + len(content) > 100 * 1024 * 1024:
        raise HTTPException(422, "单个任务的交付物文件总量不能超过100 MB")
    row = new_deliverable(
        db,
        task,
        user,
        title,
        notes,
        filename=filename,
        media_type="application/octet-stream",
        content=content,
    )
    db.commit()
    return {"id": row.id, "version": row.version}


@router.get("/{task_id}/deliverables/{deliverable_id}/download")
def download(
    task_id: str,
    deliverable_id: str,
    db: Db,
    user: CurrentUser,
):
    task_access(db, user, task_id)
    row = db.get(TaskDeliverable, deliverable_id)
    if not row or row.task_id != task_id or row.content is None:
        raise HTTPException(404, "文件不存在")
    return Response(
        row.content,
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{quote(row.filename or 'download', safe='')}",
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, no-store",
        },
    )


class AcceptanceConfig(BaseModel):
    reviewer_id: str
    required_count: int = Field(default=1, ge=1, le=100)


@router.put("/{task_id}/acceptance")
def configure_acceptance(
    task_id: str,
    payload: AcceptanceConfig,
    db: Db,
    user: CurrentUser,
):
    task = task_access(db, user, task_id, write=True)
    if user.role not in ("admin", "cmc_lead", "project_lead"):
        raise HTTPException(403, "仅项目负责人可设置验收要求")
    if not task.is_milestone:
        raise HTTPException(422, "验收要求仅用于里程碑")
    reviewer = db.get(User, payload.reviewer_id)
    if not reviewer or not reviewer.is_active or task_id not in visible_task_ids_for(reviewer, db):
        raise HTTPException(422, "验收人须是可查看此任务的有效成员")
    row = db.get(TaskAcceptance, task_id)
    if not row:
        row = TaskAcceptance(task_id=task_id)
        db.add(row)
    row.reviewer_id = payload.reviewer_id
    row.required_count = payload.required_count
    row.state = "draft"
    row.comment = ""
    row.submitted_deliverable_ids = []
    row.updated_at = datetime.now(UTC)
    if task.status == "已验证":
        task.status = "已完成"
    record_activity(
        db,
        task,
        user,
        "acceptance",
        f"设置验收人：{reviewer.display_name}；至少 {payload.required_count} 项交付物",
    )
    db.commit()
    return acceptance_out(row)


class AcceptanceAction(BaseModel):
    action: str = Field(pattern="^(submit|accept|reject)$")
    comment: str = Field(default="", max_length=5000)


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


@router.post("/{task_id}/acceptance/actions")
def acceptance_action(
    task_id: str,
    payload: AcceptanceAction,
    db: Db,
    user: CurrentUser,
):
    task = task_access(db, user, task_id, write=payload.action == "submit", lock=True)
    row = apply_acceptance_action(db, task, user, payload)
    db.commit()
    return acceptance_out(row)


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
