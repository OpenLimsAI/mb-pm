# ruff: noqa: B008
"""Feedback visible to signed-in members of the organization."""

import hashlib
import json
from datetime import UTC
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session, selectinload
from starlette.datastructures import UploadFile

from app.api.multipart import upload_form
from app.api.v1 import portal
from app.api.v1.solutions import identity
from app.db.session import get_db
from app.models.feedback import Feedback, FeedbackActivity, FeedbackImage
from app.services import accounts
from app.services.iam_admin import IAMError

router = APIRouter(prefix="/feedback", tags=["feedback"])
MAX_IMAGE = 5 * 1024 * 1024
APPLICATIONS = frozenset(
    {
        "platform",
        "pm",
        "kb",
        "knowledge-sources",
        "solutions",
        "assistant",
        "notes",
        "models",
        "settings",
        "mdm",
        "accounts",
        "feedback",
        "other",
    }
)


def can_delete(row: Feedback, claims: dict) -> bool:
    return row.issuer == claims["iss"] and (
        row.author_id == claims["sub"] or "admin" in portal.enabled_roles(claims)
    )


def summaries(db: Session, claims: dict, feedback_id: str | None = None):
    query = (
        select(
            FeedbackActivity.feedback_id,
            func.count(FeedbackActivity.id).filter(FeedbackActivity.body != ""),
            func.max(FeedbackActivity.created_at),
        )
        .join(Feedback)
        .where(Feedback.issuer == claims["iss"])
        .group_by(FeedbackActivity.feedback_id)
    )
    if feedback_id is not None:
        query = query.where(FeedbackActivity.feedback_id == feedback_id)
    return {ident: (count, latest) for ident, count, latest in db.execute(query)}


def output(row, claims, summary=None):
    count, latest = summary or (0, None)
    dates = [row.created_at] + ([latest] if latest is not None else [])
    latest = max(value.replace(tzinfo=UTC) if value.tzinfo is None else value for value in dates)
    return {
        "id": row.id,
        "category": row.category,
        "application": row.application,
        "description": row.description,
        "status": row.status,
        "author_name": row.author_name,
        "created_at": row.created_at.isoformat(),
        "images": [image.id for image in row.images],
        "can_delete": can_delete(row, claims),
        "is_mine": row.author_id == claims["sub"],
        "reply_count": count,
        "last_activity_at": latest.isoformat(),
    }


def activity_output(row):
    return {
        "id": row.id,
        "kind": row.kind,
        "body": row.body,
        "author_name": row.author_name,
        "created_at": row.created_at.isoformat(),
        "from_status": row.from_status,
        "to_status": row.to_status,
    }


def find_feedback(db: Session, feedback_id: str, claims: dict, *, lock=False, read=False):
    query = (
        select(Feedback)
        .options(selectinload(Feedback.images).defer(FeedbackImage.content))
        .where(Feedback.id == feedback_id, Feedback.issuer == claims["iss"])
        .execution_options(populate_existing=True)
    )
    if lock:
        query = query.with_for_update(read=read)
    row = db.scalar(query)
    if row is None:
        raise HTTPException(404, "反馈不存在")
    return row


def new_activity(row, claims, body="", status=None, **extra):
    changed = status is not None and status != row.status
    activity = FeedbackActivity(
        id=uuid4().hex,
        feedback_id=row.id,
        author_id=claims["sub"],
        author_name=str(claims.get("displayName") or claims.get("name") or claims["sub"])[:255],
        kind="status" if changed else "comment",
        body=body,
        from_status=row.status if changed else None,
        to_status=status if changed else None,
        **extra,
    )
    if changed:
        row.status = status
    return activity


async def json_input(request: Request, model):
    # Identity and Origin have passed before even malformed JSON is parsed.
    content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type and content_type != "application/json" and not content_type.endswith("+json"):
        raise HTTPException(415, "请使用 JSON 提交")
    data = bytearray()
    async for chunk in request.stream():
        if len(data) + len(chunk) > 16_000:
            raise HTTPException(413, "提交内容过长")
        data.extend(chunk)
    try:
        return model.model_validate_json(bytes(data))
    except ValidationError:
        raise HTTPException(422, "请检查处理状态或回复内容（回复为 1 至 2000 字）") from None


def image_type(data: bytes):
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


@router.get("")
def listing(db: Session = Depends(get_db), claims: dict = Depends(identity)):
    rows = db.scalars(
        select(Feedback)
        .options(selectinload(Feedback.images).defer(FeedbackImage.content))
        .where(Feedback.issuer == claims["iss"])
        .order_by(Feedback.created_at.desc(), Feedback.id.desc())
    ).all()
    stats = summaries(db, claims)
    return [output(row, claims, stats.get(row.id)) for row in rows]


@router.post("", status_code=201)
async def create(
    request: Request,
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    # Parse only after identity has passed. Never declare File/Form dependencies here.
    async with upload_form(request, max_files=3, max_fields=3, max_part_size=20_000) as form:
        category = form.get("category")
        application = form.get("application")
        description = form.get("description")
        images = form.getlist("images")
        if category not in ("bug", "feature"):
            raise HTTPException(422, "请选择反馈类型")
        if application is not None and (
            not isinstance(application, str) or application not in APPLICATIONS
        ):
            raise HTTPException(422, "请选择有效的所属应用")
        if (
            not isinstance(description, str)
            or not 1 <= len(description.strip()) <= 5000
            or "\x00" in description
        ):
            raise HTTPException(422, "请填写 1 至 5000 字的反馈描述")
        description = description.strip()
        attachments = []
        for file in images:
            if not isinstance(file, UploadFile):
                raise HTTPException(422, "图片字段必须是文件")
            data = await file.read(MAX_IMAGE + 1)
            if len(data) > MAX_IMAGE:
                raise HTTPException(413, "每张图片不能超过 5 MB")
            content_type = image_type(data)
            if not content_type:
                raise HTTPException(422, "仅支持 PNG、JPEG 或 WebP 图片")
            attachments.append(
                FeedbackImage(id=uuid4().hex, content_type=content_type, content=data)
            )
    name = claims.get("displayName") or claims.get("name") or claims["sub"]
    row = Feedback(
        id=uuid4().hex,
        issuer=claims["iss"],
        author_id=claims["sub"],
        author_name=str(name)[:255],
        category=category,
        application=application,
        description=description,
        images=attachments,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return output(row, claims)


Status = Literal["open", "in_progress", "fixed"]


class StatusInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: Status
    note: str = Field(default="", max_length=2000, strict=True)

    @field_validator("note")
    @classmethod
    def trim_note(cls, value):
        if "\x00" in value:
            raise ValueError("说明不能包含空字符")
        return value.strip()


class ReplyInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    body: str = Field(min_length=1, max_length=2000, strict=True)
    status: Status | None = None
    request_id: str | None = Field(default=None, min_length=1, max_length=64, strict=True)

    @field_validator("body")
    @classmethod
    def trim_body(cls, value):
        value = value.strip()
        if not value or "\x00" in value:
            raise ValueError("回复不能为空或包含空字符")
        return value

    @field_validator("request_id")
    @classmethod
    def request_key(cls, value):
        if value is not None and (
            not value.strip()
            or value != value.strip()
            or any(ord(char) < 32 or ord(char) == 127 for char in value)
        ):
            raise ValueError("无效的请求编号")
        return value


async def status_input(request: Request, claims: dict = Depends(identity)):
    return await json_input(request, StatusInput)


async def reply_input(request: Request, claims: dict = Depends(identity)):
    return await json_input(request, ReplyInput)


@router.patch("/{feedback_id}")
def update(
    feedback_id: str,
    payload: StatusInput = Depends(status_input),
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    row = find_feedback(db, feedback_id, claims, lock=True)
    if row.status == payload.status and payload.note:
        raise HTTPException(409, "状态已更新，请通过回复补充处理说明")
    if row.status != payload.status:
        db.add(new_activity(row, claims, payload.note, payload.status))
    db.commit()
    return output(row, claims, summaries(db, claims, row.id).get(row.id))


@router.get("/{feedback_id}/activities")
def activities(
    feedback_id: str,
    before: str | None = Query(default=None, min_length=1, max_length=32),
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    # A short shared parent-row lock keeps metadata, history and counts from
    # mixing two commits under PostgreSQL READ COMMITTED. Writers lock this same row.
    row = find_feedback(db, feedback_id, claims, lock=True, read=True)
    query = select(FeedbackActivity).where(FeedbackActivity.feedback_id == feedback_id)
    if before is not None:
        cursor = db.scalar(query.where(FeedbackActivity.id == before))
        if cursor is None:
            raise HTTPException(404, "处理记录不存在")
        query = query.where(
            or_(
                FeedbackActivity.created_at < cursor.created_at,
                and_(
                    FeedbackActivity.created_at == cursor.created_at,
                    FeedbackActivity.id < cursor.id,
                ),
            )
        )
    rows = db.scalars(
        query.order_by(FeedbackActivity.created_at.desc(), FeedbackActivity.id.desc()).limit(51)
    ).all()
    page = rows[:50]
    return {
        "items": [activity_output(activity) for activity in reversed(page)],
        "next_cursor": page[-1].id if len(rows) > 50 else None,
        "feedback": output(row, claims, summaries(db, claims, row.id).get(row.id)),
    }


@router.post("/{feedback_id}/replies", status_code=201)
def reply(
    feedback_id: str,
    payload: ReplyInput = Depends(reply_input),
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    row = find_feedback(db, feedback_id, claims, lock=True)
    fingerprint = hashlib.sha256(
        json.dumps(
            {"author": claims["sub"], "body": payload.body, "status": payload.status},
            ensure_ascii=False,
            sort_keys=True,
        ).encode()
    ).hexdigest()
    activity = None
    if payload.request_id is not None:
        activity = db.scalar(
            select(FeedbackActivity).where(
                FeedbackActivity.feedback_id == row.id,
                FeedbackActivity.client_request_id == payload.request_id,
            )
        )
        if activity is not None and activity.request_hash != fingerprint:
            raise HTTPException(409, "该回复请求已用于其他内容，请重新提交")
    if activity is None:
        activity = new_activity(
            row,
            claims,
            payload.body,
            payload.status,
            client_request_id=payload.request_id,
            request_hash=fingerprint if payload.request_id is not None else None,
        )
        db.add(activity)
    db.commit()
    return {
        "feedback": output(row, claims, summaries(db, claims, row.id).get(row.id)),
        "activity": activity_output(activity),
    }


@router.get("/images/{image_id}")
def image(image_id: str, db: Session = Depends(get_db), claims: dict = Depends(identity)):
    result = db.execute(
        select(FeedbackImage)
        .join(Feedback)
        .where(FeedbackImage.id == image_id, Feedback.issuer == claims["iss"])
    ).scalar_one_or_none()
    if not result:
        raise HTTPException(404, "图片不存在")
    return Response(
        result.content,
        media_type=result.content_type,
        headers={
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'",
        },
    )


@router.delete("/{feedback_id}", status_code=204)
def delete_feedback(
    feedback_id: str,
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    row = find_feedback(db, feedback_id, claims, lock=True)
    if not can_delete(row, claims):
        raise HTTPException(403, "只有反馈提交人或系统管理员可以删除")
    if row.author_id != claims["sub"]:
        try:
            roles = accounts.live_roles(claims["sub"])
        except IAMError as exc:
            raise HTTPException(503, "暂时无法确认管理员权限，请稍后重试") from exc
        if "admin" not in roles:
            raise HTTPException(403, "只有反馈提交人或系统管理员可以删除")
    db.delete(row)
    db.commit()
    return Response(status_code=204)
