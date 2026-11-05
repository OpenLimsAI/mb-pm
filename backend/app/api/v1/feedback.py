# ruff: noqa: B008
"""Feedback visible to signed-in members of the organization."""

import hashlib
import json
from datetime import UTC, datetime, timedelta
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
from app.core.config import settings
from app.db.session import get_db
from app.models.feedback import (
    Feedback,
    FeedbackActivity,
    FeedbackActivityImage,
    FeedbackImage,
    FeedbackNotice,
    FeedbackVote,
)
from app.services import accounts, iam_admin
from app.services import feedback_workflow as workflow
from app.services.iam_admin import IAMError

router = APIRouter(prefix="/feedback", tags=["feedback"])
MAX_IMAGE = 5 * 1024 * 1024
APPLICATIONS = frozenset(
    {
        "platform",
        "pm",
        "kb",
        "knowledge-sources",
        "data-backup",
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
            func.count(FeedbackActivity.id).filter(
                FeedbackActivity.body != "",
                FeedbackActivity.kind.in_(["comment", "status", "verification"]),
            ),
            func.max(FeedbackActivity.created_at),
        )
        .join(Feedback)
        .where(Feedback.issuer == claims["iss"])
        .group_by(FeedbackActivity.feedback_id)
    )
    if feedback_id is not None:
        query = query.where(FeedbackActivity.feedback_id == feedback_id)
    return {ident: (count, latest) for ident, count, latest in db.execute(query)}


def output(row, claims, summary=None, *, db=None, metadata=None):
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
        "images": [image.id for image in row.images if not image.archived],
        "can_delete": can_delete(row, claims),
        "is_mine": row.author_id == claims["sub"],
        "reply_count": count,
        "last_activity_at": latest.isoformat(),
        **(
            metadata
            if metadata is not None
            else workflow.metadata_rows(db, [row], claims).get(row.id, {})
            if db is not None
            else {}
        ),
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
        "images": [image.id for image in row.images],
        "details": row.details or {},
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


async def json_input(request: Request, model, *, limit=16_000):
    # Identity and Origin have passed before even malformed JSON is parsed.
    content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type and content_type != "application/json" and not content_type.endswith("+json"):
        raise HTTPException(415, "请使用 JSON 提交")
    data = bytearray()
    async for chunk in request.stream():
        if len(data) + len(chunk) > limit:
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
    metadata = workflow.metadata_rows(db, rows, claims)
    return [
        output(row, claims, stats.get(row.id), db=db, metadata=metadata[row.id]) for row in rows
    ]


@router.post("", status_code=201)
async def create(
    request: Request,
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    # Parse only after identity has passed. Never declare File/Form dependencies here.
    async with upload_form(request, max_files=3, max_fields=10, max_part_size=20_000) as form:
        category = form.get("category")
        application = form.get("application")
        description = form.get("description")
        images = form.getlist("images")
        structured = {field: form.get(field, "") for field in workflow.STRUCTURED}
        if any(
            not isinstance(value, str) or len(value) > 2000 or "\x00" in value
            for value in structured.values()
        ):
            raise HTTPException(422, "问题模板各项不能超过2000字")
        source = form.get("source_context")
        try:
            source = json.loads(source) if source is not None else None
        except (ValueError, TypeError):
            raise HTTPException(422, "来源信息格式不正确") from None
        source = workflow.safe_context(source, APPLICATIONS)
        key = form.get("request_id")
        if key is not None and (
            not isinstance(key, str)
            or not 1 <= len(key) <= 64
            or any(ord(c) < 33 or ord(c) == 127 for c in key)
        ):
            raise HTTPException(422, "请求编号格式不正确")
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
    digest = fingerprint(
        "create",
        claims,
        {
            "description": description,
            "category": category,
            "application": application,
            "source_context": source,
            **structured,
            "images": [hashlib.sha256(image.content).hexdigest() for image in attachments],
        },
    )
    # Counter allocation serializes concurrent creations within this issuer. Recheck
    # the request key after that lock, so unknown-result retries cannot create twins.
    number = workflow.allocate_number(db, claims["iss"])
    if key:
        previous = db.scalar(
            select(Feedback).where(
                Feedback.issuer == claims["iss"],
                Feedback.author_id == claims["sub"],
                Feedback.client_request_id == key,
            )
        )
        if previous is not None:
            if previous.request_hash != digest:
                raise HTTPException(409, "请求编号已用于其他内容，请重新提交")
            db.commit()
            return complete(db, previous, claims)
    name = claims.get("displayName") or claims.get("name") or claims["sub"]
    row = Feedback(
        id=uuid4().hex,
        issuer=claims["iss"],
        author_id=claims["sub"],
        author_name=str(name)[:255],
        category=category,
        application=application,
        workflow_version=2,
        issue_number=number,
        client_request_id=key,
        request_hash=digest if key else None,
        source_context=source,
        **structured,
        description=description,
        images=attachments,
    )
    db.add(row)
    db.flush()
    workflow.watch(db, row, claims["sub"])
    db.commit()
    db.refresh(row)
    return output(row, claims, db=db)


Status = Literal["open", "in_progress", "ready", "released", "fixed"]


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
        workflow.change_status(row, claims, payload.status, note=payload.note, legacy=True)
        workflow.record(db, row, new_activity(row, claims, payload.note, payload.status), claims)
    db.commit()
    return output(row, claims, summaries(db, claims, row.id).get(row.id), db=db)


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
    query = (
        select(FeedbackActivity)
        .options(selectinload(FeedbackActivity.images).defer(FeedbackActivityImage.content))
        .where(FeedbackActivity.feedback_id == feedback_id)
    )
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
        "feedback": output(row, claims, summaries(db, claims, row.id).get(row.id), db=db),
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
        if payload.status is not None and payload.status != row.status:
            workflow.change_status(row, claims, payload.status, note=payload.body, legacy=True)
        activity = new_activity(
            row,
            claims,
            payload.body,
            payload.status,
            client_request_id=payload.request_id,
            request_hash=fingerprint if payload.request_id is not None else None,
        )
        workflow.record(db, row, activity, claims)
    db.commit()
    return {
        "feedback": output(row, claims, summaries(db, claims, row.id).get(row.id), db=db),
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
        result = db.scalar(
            select(FeedbackActivityImage)
            .join(FeedbackActivity)
            .join(Feedback)
            .where(FeedbackActivityImage.id == image_id, Feedback.issuer == claims["iss"])
        )
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


class ContentInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    description: str = Field(min_length=1, max_length=5000, strict=True)
    application: str | None = None
    category: Literal["bug", "feature"] | None = None
    steps_to_reproduce: str = Field(default="", max_length=2000, strict=True)
    expected_result: str = Field(default="", max_length=2000, strict=True)
    actual_result: str = Field(default="", max_length=2000, strict=True)
    problem_to_solve: str = Field(default="", max_length=2000, strict=True)
    expected_benefit: str = Field(default="", max_length=2000, strict=True)
    expected_revision: int | None = Field(default=None, ge=1)

    @field_validator("description", *workflow.STRUCTURED)
    @classmethod
    def text(cls, value, info):
        if "\x00" in value or (info.field_name == "description" and not value.strip()):
            raise ValueError("内容不能为空或包含空字符")
        return value.strip()

    @field_validator("application")
    @classmethod
    def application_value(cls, value):
        if value is not None and value not in APPLICATIONS:
            raise ValueError("所属应用无效")
        return value


class ManagementInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    assignee_id: str | None = Field(default=None, max_length=255)
    priority: Literal["p0", "p1", "p2", "p3"] | None = None
    due_at: datetime | None = None
    expected_revision: int | None = Field(default=None, ge=1)


class TransitionInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: str | None = Field(default=None, min_length=1, max_length=64, strict=True)
    body: str = Field(default="", max_length=2000, strict=True)
    note: str = Field(default="", max_length=2000, strict=True)
    status: Status
    resolution: str | None = Field(default=None, max_length=2000, strict=True)
    verification_steps: str | None = Field(default=None, max_length=2000, strict=True)
    release_version: str | None = Field(default=None, max_length=100, strict=True)
    expected_revision: int | None = Field(default=None, ge=1)

    @field_validator("request_id")
    @classmethod
    def request_key(cls, value):
        return ReplyInput.request_key(value)

    @field_validator("body", "note", "resolution", "verification_steps", "release_version")
    @classmethod
    def optional_text(cls, value):
        if value is not None and "\x00" in value:
            raise ValueError("内容包含空字符")
        return value.strip() if value is not None else None


class EnabledInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool = Field(strict=True)


class ReadInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ids: list[str] = Field(default_factory=list, max_length=100)
    all: bool = False


class SimilarInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    description: str = Field(min_length=1, max_length=5000)
    application: str | None = None


class RemindInput(ReplyInput):
    body: str = Field(default="请更新处理进展", min_length=1, max_length=2000)
    status: None = None


def body_dependency(model, *, limit=16_000):
    async def parsed(request: Request, claims: dict = Depends(identity)):
        return await json_input(request, model, limit=limit)

    return parsed


def complete(db, row, claims):
    return output(row, claims, summaries(db, claims, row.id).get(row.id), db=db)


def fingerprint(kind, claims, payload):
    return hashlib.sha256(
        json.dumps(
            {"kind": kind, "author": claims["sub"], "payload": payload},
            ensure_ascii=False,
            sort_keys=True,
            default=str,
        ).encode()
    ).hexdigest()


def replay(db, row, key, digest):
    if key is None:
        return None
    item = db.scalar(
        select(FeedbackActivity).where(
            FeedbackActivity.feedback_id == row.id, FeedbackActivity.client_request_id == key
        )
    )
    if item and item.request_hash != digest:
        raise HTTPException(409, "请求编号已用于其他内容，请重新提交")
    return item


def participants(db, claims):
    try:
        users = iam_admin.list_users()
    except IAMError:
        raise HTTPException(503, "暂时无法读取组织成员，请稍后重试") from None
    return {
        user["id"]: str(user.get("displayName") or user.get("name") or user["id"])[:255]
        for user in users
        if isinstance(user.get("id"), str)
        and user["id"]
        and user.get("owner") == settings.CASDOOR_ORG
        and not user.get("isForbidden")
        and not user.get("isDeleted")
    }


@router.get("/people")
def people(db: Session = Depends(get_db), claims: dict = Depends(identity)):
    return {
        "items": [{"id": key, "name": value} for key, value in participants(db, claims).items()]
    }


def notifications_output(db, claims, unread_only=False):
    query = select(FeedbackNotice).where(
        FeedbackNotice.issuer == claims["iss"], FeedbackNotice.subject == claims["sub"]
    )
    unread = db.scalar(
        select(func.count())
        .select_from(FeedbackNotice)
        .where(
            FeedbackNotice.issuer == claims["iss"],
            FeedbackNotice.subject == claims["sub"],
            FeedbackNotice.read_at.is_(None),
        )
    )
    if unread_only:
        query = query.where(FeedbackNotice.read_at.is_(None))
    rows = db.scalars(
        query.order_by(FeedbackNotice.created_at.desc(), FeedbackNotice.id.desc()).limit(100)
    ).all()
    feedbacks = (
        {
            row.id: row
            for row in db.scalars(
                select(Feedback).where(
                    Feedback.id.in_([notice.feedback_id for notice in rows]),
                    Feedback.issuer == claims["iss"],
                )
            )
        }
        if rows
        else {}
    )
    return {
        "items": [
            {
                "id": notice.id,
                "feedback_id": notice.feedback_id,
                "number": f"FB-{feedbacks[notice.feedback_id].issue_number:04d}"
                if feedbacks[notice.feedback_id].issue_number
                else None,
                "permalink": "/feedback?feedback=" + notice.feedback_id,
                "kind": notice.kind,
                "body": notice.body,
                "created_at": notice.created_at.isoformat(),
                "read_at": notice.read_at.isoformat() if notice.read_at else None,
            }
            for notice in rows
            if notice.feedback_id in feedbacks
        ],
        "unread_count": unread,
    }


@router.get("/notifications")
def notifications(
    unread_only: bool = False, db: Session = Depends(get_db), claims: dict = Depends(identity)
):
    return notifications_output(db, claims, unread_only)


@router.post("/notifications/read")
def read_notifications(
    payload: ReadInput = Depends(body_dependency(ReadInput, limit=16000)),
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    query = select(FeedbackNotice).where(
        FeedbackNotice.issuer == claims["iss"],
        FeedbackNotice.subject == claims["sub"],
        FeedbackNotice.read_at.is_(None),
    )
    if not payload.all:
        query = query.where(FeedbackNotice.id.in_(payload.ids))
    for row in db.scalars(query):
        row.read_at = workflow.now()
    db.commit()
    return notifications_output(db, claims)


@router.get("/workbench")
def workbench(db: Session = Depends(get_db), claims: dict = Depends(identity)):
    rows = db.scalars(
        select(Feedback)
        .options(selectinload(Feedback.images).defer(FeedbackImage.content))
        .where(Feedback.issuer == claims["iss"])
        .order_by(Feedback.created_at.desc(), Feedback.id.desc())
    ).all()
    stats = summaries(db, claims)
    metadata = workflow.metadata_rows(db, rows, claims)
    items = [
        output(row, claims, stats.get(row.id), db=db, metadata=metadata[row.id]) for row in rows
    ]
    firsts = dict(
        db.execute(
            select(FeedbackActivity.feedback_id, func.min(FeedbackActivity.created_at))
            .join(Feedback)
            .where(
                Feedback.issuer == claims["iss"],
                FeedbackActivity.author_id != Feedback.author_id,
                FeedbackActivity.kind.in_(
                    ["comment", "status", "assignment", "management", "verification"]
                ),
            )
            .group_by(FeedbackActivity.feedback_id)
        ).all()
    )
    closes = dict(
        db.execute(
            select(FeedbackActivity.feedback_id, func.max(FeedbackActivity.created_at))
            .join(Feedback)
            .where(Feedback.issuer == claims["iss"], FeedbackActivity.to_status == "fixed")
            .group_by(FeedbackActivity.feedback_id)
        ).all()
    )

    def timings(group):
        response_hours = [
            (workflow.utc(firsts[row.id]) - workflow.utc(row.created_at)).total_seconds() / 3600
            for row in group
            if row.id in firsts and workflow.utc(firsts[row.id]) >= workflow.utc(row.created_at)
        ]
        resolution_hours = [
            (
                workflow.utc(row.resolved_at or closes[row.id]) - workflow.utc(row.created_at)
            ).total_seconds()
            / 3600
            for row in group
            if row.status == "fixed"
            and (row.resolved_at or row.id in closes)
            and workflow.utc(row.resolved_at or closes[row.id]) >= workflow.utc(row.created_at)
        ]
        return {
            "average_first_response_hours": round(sum(response_hours) / len(response_hours), 2)
            if response_hours
            else None,
            "first_response_count": len(response_hours),
            "average_resolution_hours": round(sum(resolution_hours) / len(resolution_hours), 2)
            if resolution_hours
            else None,
            "resolution_count": len(resolution_hours),
        }

    metrics = {status: sum(row.status == status for row in rows) for status in workflow.STATUSES}
    metrics.update(
        overdue=sum(item["is_overdue"] for item in items),
        unassigned=sum(row.assignee_id is None and row.status != "fixed" for row in rows),
        mine=sum(row.assignee_id == claims["sub"] and row.status != "fixed" for row in rows),
        unanswered=sum(item["reply_count"] == 0 and item["status"] != "fixed" for item in items),
        **timings(rows),
    )
    applications = sorted({row.application for row in rows}, key=lambda value: value or "")
    grouped = []
    for application in applications:
        group = [row for row in rows if row.application == application]
        pending = sum(row.status != "fixed" for row in group)
        grouped.append(
            {
                "application": application,
                "total": len(group),
                "open": pending,
                "pending": pending,
                "overdue": sum(metadata[row.id]["is_overdue"] for row in group),
                **timings(group),
            }
        )
    return {"items": items, "metrics": metrics, "by_application": grouped}


@router.post("/similar")
def similar(
    payload: SimilarInput = Depends(body_dependency(SimilarInput, limit=40000)),
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    from difflib import SequenceMatcher

    if payload.application is not None and payload.application not in APPLICATIONS:
        raise HTTPException(422, "所属应用无效")
    text = payload.description.strip().casefold()
    if not text or "\x00" in text:
        raise HTTPException(422, "请填写问题描述")
    query = (
        select(Feedback)
        .options(selectinload(Feedback.images).defer(FeedbackImage.content))
        .where(Feedback.issuer == claims["iss"])
    )
    if payload.application:
        query = query.where(Feedback.application == payload.application)
    rows = db.scalars(query.order_by(Feedback.created_at.desc()).limit(500)).all()

    def grams(value):
        return {value[index : index + 2] for index in range(max(1, len(value) - 1))}

    wanted = grams(text)
    scored = []
    for row in rows:
        existing = row.description.casefold()
        overlap = len(wanted & grams(existing)) / max(1, len(wanted | grams(existing)))
        score = max(
            overlap, SequenceMatcher(None, text[:300], existing[:300], autojunk=True).ratio()
        )
        if score >= 0.25:
            scored.append((score, row))
    scored.sort(key=lambda pair: (-pair[0], pair[1].id))
    selected = scored[:5]
    metadata = workflow.metadata_rows(db, [row for _, row in selected], claims)
    stats = summaries(db, claims)
    return {
        "items": [
            {
                **output(row, claims, stats.get(row.id), db=db, metadata=metadata[row.id]),
                "similarity_score": round(score, 3),
            }
            for score, row in selected
        ]
    }


@router.patch("/{feedback_id}/content")
def edit_content(
    feedback_id: str,
    payload: ContentInput = Depends(body_dependency(ContentInput, limit=64000)),
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    row = find_feedback(db, feedback_id, claims, lock=True)
    workflow.require_edit(row, claims)
    workflow.expected_revision(row, payload)
    before = workflow.snapshot(row)
    for key in {
        "description",
        "application",
        "category",
        *workflow.STRUCTURED,
    } & payload.model_fields_set:
        if key != "category" or payload.category is not None:
            setattr(row, key, getattr(payload, key))
    after = workflow.snapshot(row)
    if before != after:
        activity = new_activity(row, claims, "原反馈内容已编辑")
        activity.kind = "edit"
        activity.details = {"before": before, "after": after}
        workflow.record(db, row, activity, claims)
    db.commit()
    return complete(db, row, claims)


async def uploaded_images(files, *, activity=False):
    if len(files) > 3:
        raise HTTPException(422, "最多上传3张图片")
    result = []
    for file in files:
        if not isinstance(file, UploadFile):
            raise HTTPException(422, "图片必须是文件")
        data = await file.read(MAX_IMAGE + 1)
        media = image_type(data)
        if len(data) > MAX_IMAGE:
            raise HTTPException(413, "每张图片不能超过5 MB")
        if not media:
            raise HTTPException(422, "仅支持PNG、JPEG或WebP图片")
        model = FeedbackActivityImage if activity else FeedbackImage
        result.append(
            model(
                id=("r" + uuid4().hex[:31]) if activity else uuid4().hex,
                content_type=media,
                content=data,
            )
        )
    return result


@router.patch("/{feedback_id}/content-with-images")
async def edit_with_images(
    feedback_id: str,
    request: Request,
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    async with upload_form(request, max_files=3, max_fields=10, max_part_size=20_000) as form:
        values = {
            key: form.get(key)
            for key in {
                "description",
                "application",
                "category",
                "expected_revision",
                *workflow.STRUCTURED,
            }
            if key in form
        }
        if "expected_revision" in values:
            try:
                values["expected_revision"] = int(values["expected_revision"])
            except (ValueError, TypeError):
                raise HTTPException(422, "修订号格式不正确") from None
        try:
            payload = ContentInput.model_validate(values)
            keep = json.loads(form.get("keep_images", "[]"))
        except (ValidationError, ValueError, TypeError):
            raise HTTPException(422, "内容或保留图片格式不正确") from None
        if (
            not isinstance(keep, list)
            or any(not isinstance(ident, str) for ident in keep)
            or len(keep) != len(set(keep))
        ):
            raise HTTPException(422, "保留图片格式不正确")
        pictures = await uploaded_images(form.getlist("images"))
    row = find_feedback(db, feedback_id, claims, lock=True)
    workflow.require_edit(row, claims)
    workflow.expected_revision(row, payload)
    active = {image.id for image in row.images if not image.archived}
    if not set(keep) <= active or len(keep) + len(pictures) > 3:
        raise HTTPException(422, "图片不属于此反馈或总数超过3张")
    before = workflow.snapshot(row)
    for image in row.images:
        if image.id in active and image.id not in keep:
            image.archived = True
    row.images.extend(pictures)
    for key in {
        "description",
        "application",
        "category",
        *workflow.STRUCTURED,
    } & payload.model_fields_set:
        if key != "category" or payload.category is not None:
            setattr(row, key, getattr(payload, key))
    after = workflow.snapshot(row)
    if before != after:
        activity = new_activity(row, claims, "原反馈内容和图片已编辑")
        activity.kind = "edit"
        activity.details = {"before": before, "after": after}
        workflow.record(db, row, activity, claims)
    db.commit()
    return complete(db, row, claims)


@router.post("/{feedback_id}/claim")
def claim(feedback_id: str, db: Session = Depends(get_db), claims: dict = Depends(identity)):
    row = find_feedback(db, feedback_id, claims, lock=True)
    if row.assignee_id == claims["sub"]:
        return complete(db, row, claims)
    if row.status == "fixed":
        # Claiming a closed, unassigned issue must not grant reopen privileges.
        workflow.require_manage(row, claims)
    if row.assignee_id is not None and not workflow.live_admin(claims):
        raise HTTPException(409, "已有处理人，请联系原处理人或管理员转派")
    before = {"assignee_id": row.assignee_id, "assignee_name": row.assignee_name}
    row.assignee_id = claims["sub"]
    row.assignee_name = str(claims.get("displayName") or claims.get("name") or claims["sub"])[:255]
    target = "in_progress" if row.status == "open" else None
    activity = new_activity(row, claims, "已认领处理", target)
    activity.kind = "assignment"
    activity.details = {
        "before": before,
        "after": {"assignee_id": row.assignee_id, "assignee_name": row.assignee_name},
    }
    workflow.watch(db, row, claims["sub"])
    workflow.record(db, row, activity, claims)
    db.commit()
    return complete(db, row, claims)


@router.patch("/{feedback_id}/management")
def management(
    feedback_id: str,
    payload: ManagementInput = Depends(body_dependency(ManagementInput, limit=16000)),
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    row = find_feedback(db, feedback_id, claims, lock=True)
    workflow.require_manage(row, claims)
    workflow.expected_revision(row, payload)
    before = {
        "assignee_id": row.assignee_id,
        "assignee_name": row.assignee_name,
        "priority": row.priority,
        "due_at": workflow.utc(row.due_at).isoformat() if row.due_at else None,
    }
    if "assignee_id" in payload.model_fields_set and payload.assignee_id != row.assignee_id:
        if payload.assignee_id not in (None, claims["sub"]):
            if not workflow.live_admin(claims):
                raise HTTPException(403, "转派他人需要管理员权限")
            names = participants(db, claims)
            if payload.assignee_id not in names:
                raise HTTPException(422, "只能选择同组织参与成员")
            try:
                accounts.live_roles(payload.assignee_id)
            except IAMError:
                raise HTTPException(503, "暂时无法确认目标成员状态，请稍后重试") from None
            row.assignee_name = names[payload.assignee_id]
        elif payload.assignee_id == claims["sub"] and row.assignee_id not in {None, claims["sub"]}:
            if not workflow.live_admin(claims):
                raise HTTPException(409, "已有处理人，请通过管理员转派")
            row.assignee_name = str(
                claims.get("displayName") or claims.get("name") or claims["sub"]
            )[:255]
        elif payload.assignee_id is None:
            if claims["sub"] != row.assignee_id and not workflow.live_admin(claims):
                raise HTTPException(403, "无权取消认领")
            row.assignee_name = None
        else:
            row.assignee_name = str(
                claims.get("displayName") or claims.get("name") or claims["sub"]
            )[:255]
        row.assignee_id = payload.assignee_id
    if payload.priority is not None:
        row.priority = payload.priority
    if "due_at" in payload.model_fields_set:
        row.due_at = workflow.utc(payload.due_at) if payload.due_at else None
    after = {
        "assignee_id": row.assignee_id,
        "assignee_name": row.assignee_name,
        "priority": row.priority,
        "due_at": row.due_at.isoformat() if row.due_at else None,
    }
    if before != after:
        activity = new_activity(row, claims, "处理安排已更新")
        activity.kind = "management"
        activity.details = {"before": before, "after": after}
        workflow.record(db, row, activity, claims)
    db.commit()
    return complete(db, row, claims)


@router.post("/{feedback_id}/transition", status_code=201)
def transition(
    feedback_id: str,
    payload: TransitionInput = Depends(body_dependency(TransitionInput, limit=64000)),
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    row = find_feedback(db, feedback_id, claims, lock=True)
    digest = fingerprint(
        "transition", claims, payload.model_dump(exclude={"request_id", "expected_revision"})
    )
    activity = replay(db, row, payload.request_id, digest)
    if activity is None:
        workflow.expected_revision(row, payload)
        workflow.require_manage(row, claims)
        before = {
            "workflow_version": row.workflow_version,
            "status": row.status,
            "resolution": row.resolution,
            "verification_steps": row.verification_steps,
            "release_version": row.release_version,
        }
        note = payload.note or payload.body
        if row.workflow_version == 1:
            row.workflow_version = 2
        workflow.change_status(
            row,
            claims,
            payload.status,
            note=note,
            resolution=payload.resolution,
            verification_steps=payload.verification_steps,
            release_version=payload.release_version,
            legacy=True,
        )
        activity = new_activity(
            row,
            claims,
            note,
            payload.status,
            client_request_id=payload.request_id,
            request_hash=digest if payload.request_id else None,
        )
        activity.kind = (
            "verification"
            if payload.status == "fixed"
            or (before["status"] == "released" and payload.status == "in_progress")
            else "status"
        )
        activity.details = {
            "before": before,
            "after": {
                "workflow_version": row.workflow_version,
                "status": row.status,
                "resolution": row.resolution,
                "verification_steps": row.verification_steps,
                "release_version": row.release_version,
            },
        }
        workflow.record(db, row, activity, claims)
    db.commit()
    return {"feedback": complete(db, row, claims), "activity": activity_output(activity)}


@router.post("/{feedback_id}/replies-with-images", status_code=201)
async def reply_with_images(
    feedback_id: str,
    request: Request,
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    async with upload_form(request, max_files=3, max_fields=3, max_part_size=12_000) as form:
        try:
            payload = ReplyInput.model_validate(
                {key: form.get(key) for key in ("body", "status", "request_id") if key in form}
            )
        except ValidationError:
            raise HTTPException(422, "请填写1至2000字的回复") from None
        pictures = await uploaded_images(form.getlist("images"), activity=True)
    row = find_feedback(db, feedback_id, claims, lock=True)
    digest = fingerprint(
        "reply-images",
        claims,
        {
            **payload.model_dump(exclude={"request_id"}),
            "images": [hashlib.sha256(image.content).hexdigest() for image in pictures],
        },
    )
    activity = replay(db, row, payload.request_id, digest)
    if activity is None:
        if payload.status is not None and payload.status != row.status:
            workflow.change_status(row, claims, payload.status, note=payload.body, legacy=True)
        activity = new_activity(
            row,
            claims,
            payload.body,
            payload.status,
            client_request_id=payload.request_id,
            request_hash=digest if payload.request_id else None,
        )
        activity.images = pictures
        workflow.record(db, row, activity, claims)
    db.commit()
    return {"feedback": complete(db, row, claims), "activity": activity_output(activity)}


@router.put("/{feedback_id}/vote")
def vote(
    feedback_id: str,
    payload: EnabledInput = Depends(body_dependency(EnabledInput, limit=16000)),
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    row = find_feedback(db, feedback_id, claims, lock=True)
    value = db.get(FeedbackVote, (row.id, claims["sub"]))
    if payload.enabled and value is None:
        db.add(FeedbackVote(feedback_id=row.id, subject=claims["sub"]))
    elif not payload.enabled and value is not None:
        db.delete(value)
    db.commit()
    return complete(db, row, claims)


@router.put("/{feedback_id}/follow")
def follow(
    feedback_id: str,
    payload: EnabledInput = Depends(body_dependency(EnabledInput, limit=16000)),
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    row = find_feedback(db, feedback_id, claims, lock=True)
    workflow.watch(db, row, claims["sub"], payload.enabled)
    db.commit()
    return complete(db, row, claims)


@router.post("/{feedback_id}/read")
def read_feedback(
    feedback_id: str, db: Session = Depends(get_db), claims: dict = Depends(identity)
):
    row = find_feedback(db, feedback_id, claims, lock=True)
    workflow.mark_read(db, row, claims)
    db.commit()
    return complete(db, row, claims)


@router.post("/{feedback_id}/remind", status_code=201)
def remind(
    feedback_id: str,
    payload: RemindInput = Depends(body_dependency(RemindInput, limit=16000)),
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    row = find_feedback(db, feedback_id, claims, lock=True)
    digest = fingerprint("reminder", claims, payload.body)
    activity = replay(db, row, payload.request_id, digest)
    if activity is None:
        meta = workflow.metadata_rows(db, [row], claims)[row.id]
        if not meta["can_remind"] or (
            row.author_id != claims["sub"]
            and not meta["is_following"]
            and not workflow.live_admin(claims)
        ):
            raise HTTPException(403, "只有提交人、关注者或管理员可以催办")
        if row.status == "fixed":
            raise HTTPException(409, "已修复的问题无需催办")
        previous = db.scalar(
            select(FeedbackActivity.id)
            .where(
                FeedbackActivity.feedback_id == row.id,
                FeedbackActivity.author_id == claims["sub"],
                FeedbackActivity.kind == "reminder",
                FeedbackActivity.created_at >= workflow.now() - timedelta(hours=24),
            )
            .limit(1)
        )
        if previous:
            raise HTTPException(429, "24小时内已催办，请等待处理进展")
        activity = new_activity(
            row,
            claims,
            payload.body,
            client_request_id=payload.request_id,
            request_hash=digest if payload.request_id else None,
        )
        activity.kind = "reminder"
        workflow.record(db, row, activity, claims)
    db.commit()
    return {"feedback": complete(db, row, claims), "activity": activity_output(activity)}


@router.get("/{feedback_id}")
def detail(feedback_id: str, db: Session = Depends(get_db), claims: dict = Depends(identity)):
    # Numeric references never bypass the issuer boundary.
    if feedback_id.upper().startswith("FB-"):
        try:
            number = int(feedback_id[3:])
        except ValueError:
            raise HTTPException(404, "反馈不存在") from None
        row = db.scalar(
            select(Feedback).where(
                Feedback.issuer == claims["iss"], Feedback.issue_number == number
            )
        )
        if row is None:
            raise HTTPException(404, "反馈不存在")
        return complete(db, row, claims)
    return complete(db, find_feedback(db, feedback_id, claims), claims)
