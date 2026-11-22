"""Scoped task discussion, immutable deliverable versions and milestone acceptance."""

from datetime import UTC, datetime
from pathlib import PurePath
from typing import Annotated
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session, defer

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models import User
from app.models.task_collaboration import TaskAcceptance, TaskActivity, TaskDeliverable
from app.services.scope import visible_task_ids_for
from app.services.task_collaboration_service import (  # noqa: F401
    AcceptanceAction,
    acceptance_deliverables,
    acceptance_out,
    apply_acceptance_action,
    invalidate_acceptance,
    lock_task_for_update,
    new_deliverable,
    record_activity,
    task_access,
    utc_time,
    validate_deliverable_link,
)

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
