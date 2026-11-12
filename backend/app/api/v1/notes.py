"""Private note CRUD: portal sessions only, with no KB dependency."""
# ruff: noqa: B008

import hashlib
import json
from datetime import UTC, datetime
from typing import Literal
from urllib.parse import urlsplit
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.encoders import jsonable_encoder
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import require_same_origin
from app.api.v1 import portal
from app.core.config import settings
from app.db.session import get_db
from app.models.note import NoteWisdomSync, PersonalNote
from app.services import note_sync, password_policy

router = APIRouter(prefix="/notes", tags=["personal-notes"])
Source = Literal["manual", "solutions", "information", "knowledge"]


def identity(request: Request, db: Session = Depends(get_db)):
    # A mounted KB and the portal can have the same Origin. Only a distinct
    # configured KB origin needs the cross-origin exception; caller identity is
    # still pinned below by whichever explicit binding headers it supplies.
    knowledge_request = (
        request.headers.get("origin") == settings.KNOWLEDGE_NOTES_ORIGIN
        and settings.KNOWLEDGE_NOTES_ORIGIN != settings.portal_origin
    )
    if request.method not in ("GET", "HEAD", "OPTIONS") and not knowledge_request:
        require_same_origin(request, origin=settings.portal_origin)
    claims = portal.session_claims(request, db)
    password_policy.enforce(db, claims["sub"], request.url.path)
    expected_portal_identity = request.headers.get("x-notes-portal-identity")
    if (
        expected_portal_identity is not None
        and expected_portal_identity != portal.identity_namespace(claims)
    ):
        raise HTTPException(403, "登录账号已变化，请保留当前草稿并使用原账号重新登录")
    expected_identity = request.headers.get("x-notes-identity")
    actual_identity = hashlib.sha256(
        json.dumps(
            [claims["iss"], claims["sub"]], ensure_ascii=False, separators=(",", ":")
        ).encode()
    ).hexdigest()
    if expected_identity is not None and expected_identity != actual_identity:
        raise HTTPException(403, "知识库和工作台登录的账号不一致，请重新登录")
    expected_issuer = request.headers.get("x-notes-issuer")
    expected_subject = request.headers.get("x-notes-subject")
    if (knowledge_request or expected_issuer is not None or expected_subject is not None) and (
        expected_issuer != claims["iss"] or expected_subject != claims["sub"]
    ):
        raise HTTPException(403, "知识库和工作台登录的账号不一致，请重新登录")
    if all(
        value is None
        for value in (
            expected_portal_identity,
            expected_identity,
            expected_issuer,
            expected_subject,
        )
    ):
        raise HTTPException(403, "无法确认当前笔记所属账号，请刷新页面并重新确认登录账号")
    return claims


class NoteInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=1, max_length=200)
    content: str = Field(min_length=1, max_length=50000)
    source_app: Source = "manual"
    source_title: str = Field(default="", max_length=500)
    source_url: str = Field(default="", max_length=2000)

    @field_validator("title", "content")
    @classmethod
    def present(cls, value):
        if not value.strip():
            raise ValueError("笔记标题和正文不能为空")
        return value

    @field_validator("source_url")
    @classmethod
    def safe_source(cls, value):
        if not value:
            return value
        if "\\" in value or any(ord(char) < 32 for char in value):
            raise ValueError("来源链接无效")
        parts = urlsplit(value)
        if value.startswith("/") and not value.startswith("//"):
            return value
        if (
            parts.scheme not in ("https", "http")
            or not parts.hostname
            or parts.username
            or parts.password
        ):
            raise ValueError("来源链接须为站内路径或 HTTP(S) 地址")
        return value


class NoteCreate(NoteInput):
    id: UUID


class NoteSave(NoteInput):
    revision: int = Field(ge=1)


class NoteRevision(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: int = Field(ge=1)


def owned(claims):
    return (PersonalNote.issuer == claims["iss"]) & (PersonalNote.owner_id == claims["sub"])


def get_note(db, note_id, claims):
    row = db.scalar(select(PersonalNote).where(PersonalNote.id == note_id, owned(claims)))
    if not row:
        raise HTTPException(404, "笔记不存在")
    return row


def output(row, db=None):
    def value(name):
        result = getattr(row, name)
        if isinstance(result, datetime) and result.tzinfo is None:
            return result.replace(tzinfo=UTC)
        return result

    result = jsonable_encoder(
        {
            name: value(name)
            for name in (
                "id",
                "title",
                "content",
                "source_app",
                "source_title",
                "source_url",
                "revision",
                "created_at",
                "updated_at",
                "deleted_at",
            )
        }
    )

    mirror = db.get(NoteWisdomSync, row.id) if db else None
    result["wisdom"] = note_sync.summary(mirror)
    return result


@router.get("")
def listing(
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
    search: str = Query(default="", max_length=200),
    source_app: Source | None = None,
    trashed: bool = False,
    offset: int = Query(default=0, ge=0),
):
    statement = select(PersonalNote).where(
        owned(claims),
        PersonalNote.deleted_at.is_not(None) if trashed else PersonalNote.deleted_at.is_(None),
    )
    if search.strip():
        statement = statement.where(
            or_(
                PersonalNote.title.icontains(search.strip(), autoescape=True),
                PersonalNote.content.icontains(search.strip(), autoescape=True),
            )
        )
    if source_app:
        statement = statement.where(PersonalNote.source_app == source_app)
    total = db.scalar(select(func.count()).select_from(statement.subquery()))
    rows = db.scalars(
        statement.order_by(PersonalNote.updated_at.desc(), PersonalNote.id.desc())
        .offset(offset)
        .limit(50)
    ).all()
    return {"items": [output(row, db) for row in rows], "total": total}


@router.get("/{note_id}")
def detail(note_id: str, db: Session = Depends(get_db), claims: dict = Depends(identity)):
    row = get_note(db, note_id, claims)
    if row.deleted_at:
        raise HTTPException(404, "笔记不存在或已移至回收站")
    return output(row, db)


@router.post("", status_code=201)
def create(payload: NoteCreate, db: Session = Depends(get_db), claims: dict = Depends(identity)):
    data = payload.model_dump(exclude={"id"})
    existing = db.get(PersonalNote, str(payload.id))
    if existing:
        if (
            existing.issuer == claims["iss"]
            and existing.owner_id == claims["sub"]
            and existing.deleted_at is None
            and all(getattr(existing, name) == value for name, value in data.items())
        ):
            return output(existing, db)
        raise HTTPException(409, "笔记已创建或标识不可用，请刷新笔记列表后核对")
    row = PersonalNote(id=str(payload.id), issuer=claims["iss"], owner_id=claims["sub"], **data)
    db.add(row)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(409, "笔记已创建，请刷新笔记列表后核对") from exc
    return output(row, db)


def change(db, row, claims, revision, values):
    if row.revision != revision:
        raise HTTPException(409, "笔记已在其他页面更新，请保留当前内容并重新打开核对")
    count = db.execute(
        update(PersonalNote)
        .where(PersonalNote.id == row.id, owned(claims), PersonalNote.revision == revision)
        .values(**values, revision=revision + 1, updated_at=datetime.now(UTC))
    ).rowcount
    if not count:
        db.rollback()
        raise HTTPException(409, "笔记已在其他页面更新，请保留当前内容并重新打开核对")
    note_sync.enqueue(db, row.id, revision + 1)
    db.commit()
    db.refresh(row)
    return output(row, db)


@router.put("/{note_id}")
def save(
    note_id: str, payload: NoteSave, db: Session = Depends(get_db), claims: dict = Depends(identity)
):
    row = get_note(db, note_id, claims)
    if row.deleted_at:
        raise HTTPException(409, "笔记已在回收站，请先恢复")
    return change(db, row, claims, payload.revision, payload.model_dump(exclude={"revision"}))


@router.post("/{note_id}/trash")
def trash(
    note_id: str,
    payload: NoteRevision,
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    row = get_note(db, note_id, claims)
    if row.deleted_at:
        raise HTTPException(409, "笔记已在回收站")
    return change(db, row, claims, payload.revision, {"deleted_at": datetime.now(UTC)})


@router.post("/{note_id}/restore")
def restore(
    note_id: str,
    payload: NoteRevision,
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    row = get_note(db, note_id, claims)
    if not row.deleted_at:
        raise HTTPException(409, "笔记已恢复")
    return change(db, row, claims, payload.revision, {"deleted_at": None})


class NoteShare(NoteRevision):
    enabled: bool


@router.post("/{note_id}/wisdom")
def share(
    note_id: str,
    payload: NoteShare,
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    row = get_note(db, note_id, claims)
    if row.deleted_at:
        raise HTTPException(409, "请先恢复笔记")
    if payload.enabled:
        note_sync.require_editor(claims["sub"])
        if not note_sync.configured():
            raise HTTPException(503, "知识库检索连接尚未配置")
    mirror = db.get(NoteWisdomSync, row.id)
    if not mirror:
        mirror = NoteWisdomSync(
            note_id=row.id, enabled=payload.enabled, desired_revision=row.revision
        )
        db.add(mirror)
        db.flush()
    else:
        mirror.enabled = payload.enabled
    return change(db, row, claims, payload.revision, {})
