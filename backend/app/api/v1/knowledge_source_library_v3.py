# ruff: noqa: B008
"""Authenticated, paged library access through the existing signed KB bridge."""

import base64
import binascii
import json
import re
from typing import Literal
from urllib.parse import parse_qs, quote, unquote, urlsplit

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response
from pydantic import Field, field_validator
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.api.v1.knowledge_sources import Input, connected, principal
from app.core.config import settings
from app.db.session import get_db
from app.models.note import PersonalNote
from app.services import knowledge_source_original_delete as original_delete
from app.services.information.extract import extract_pdf
from app.services.information.store import Store
from app.services.knowledge_source_exports_v3 import export_selection
from app.services.knowledge_source_library_v3_service import (
    library_statistics,
    merge_collection_options,
    paper_detail_service,
    paper_usage_service,
    query_library_service,
    set_tags_service,
)
from app.services.knowledge_source_library_v3_service import (
    map_library_paper as _map_paper,
)
from app.services.knowledge_source_upload_v3_service import upload_paper_service

__all__ = [
    "ConfirmDeletePaperInput",
    "DeletePaperInput",
    "ExportInput",
    "MetadataInput",
    "PaperInput",
    "QueryInput",
    "TagInput",
    "UsageInput",
    "_map_paper",
    "extract_pdf",
    "library_statistics",
    "merge_collection_options",
    "router",
    "upload_router",
]

router = APIRouter(prefix="/knowledge-sources/v3/library", tags=["knowledge-sources"])
upload_router = APIRouter(prefix="/knowledge-sources/v3", tags=["knowledge-sources"])


class QueryInput(Input):
    query: str = Field("", max_length=500)
    folder_id: str = Field("all", alias="folderId", max_length=100)
    search_mode: Literal["all", "title"] = Field("all", alias="searchMode")
    offset: int = Field(0, ge=0, le=1000000)
    limit: int = Field(50, ge=1, le=100)
    sort: Literal["recent", "title"] = "recent"
    tag_ids: list[str] = Field(default_factory=list, alias="tagIds", max_length=3)
    type: str | None = Field(None, max_length=200)
    index_status: Literal["ready", "failed", "pending", "not_requested", "unknown"] | None = Field(
        None, alias="indexStatus"
    )
    reading_status: str | None = Field(None, alias="readingStatus", max_length=20)
    collection_id: str | None = Field(None, alias="collectionId", max_length=100)
    saved_after: str | None = Field(None, alias="savedAfter", max_length=40)


class PaperInput(Input):
    paper_id: str = Field(alias="paperId", min_length=1, max_length=1100)
    query: str = Field("", max_length=500)
    offset: int = Field(0, ge=0, le=4000000)
    limit: int = Field(48000, ge=1000, le=64000)


class DeletePaperInput(Input):
    paper_id: str = Field(alias="paperId", min_length=1, max_length=1024)


class ConfirmDeletePaperInput(DeletePaperInput):
    plan_id: str = Field(
        alias="planId", pattern=r"^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
    )


def _deletable_path(value: str):
    if (
        not value.startswith("sources/")
        or not value.endswith(".md")
        or any(part in ("", ".", "..") for part in value.split("/"))
        or "\\" in value
        or any(ord(char) < 32 or ord(char) == 127 for char in value)
    ):
        raise HTTPException(422, "此资料尚未登记到知识库，暂不能在此删除")
    return value


class TagInput(Input):
    paper_ids: list[str] = Field(alias="paperIds", min_length=1, max_length=100)
    tags: list[str] = Field(max_length=3)
    revision: int = Field(ge=0)
    mode: Literal["replace", "add"] = "replace"


class MetadataInput(Input):
    paper_id: str = Field(alias="paperId", min_length=1, max_length=1100)
    revision: int = Field(ge=0)
    metadata: dict

    @field_validator("metadata")
    @classmethod
    def validate_metadata(cls, value: dict) -> dict:
        if len(value) > 30:
            raise ValueError("元数据字段过多")
        for key, item in value.items():
            if not isinstance(key, str) or not key or len(key) > 64:
                raise ValueError("元数据字段名无效")
            if isinstance(item, str):
                if len(item) > 10000:
                    raise ValueError("元数据字段值过长")
            elif isinstance(item, list):
                if len(item) > 100 or any(not isinstance(v, str) or len(v) > 500 for v in item):
                    raise ValueError("元数据列表字段格式无效或过长")
            elif item is not None and not isinstance(item, int | float | bool):
                raise ValueError("元数据不支持嵌套对象")
        if len(json.dumps(value, ensure_ascii=False)) > 32768:
            raise ValueError("元数据总大小超过 32 KB 上限")
        return value


class ExportInput(Input):
    paper_ids: list[str] = Field(alias="paperIds", min_length=1, max_length=100)
    format: Literal["bibtex", "ris", "csv", "zip"]


class UsageInput(Input):
    paper_ids: list[str] = Field(alias="paperIds", min_length=1, max_length=20)


def note_matches(db, actor, query, versions):
    if not query.strip():
        return {}, False
    escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    rows = db.scalars(
        select(PersonalNote)
        .where(
            PersonalNote.issuer == actor["issuer"],
            PersonalNote.owner_id == actor["subject"],
            PersonalNote.deleted_at.is_(None),
            or_(
                PersonalNote.content.ilike(f"%{escaped}%", escape="\\"),
                PersonalNote.title.ilike(f"%{escaped}%", escape="\\"),
            ),
        )
        .order_by(PersonalNote.updated_at.desc())
        .limit(201)
    ).all()
    result = {}
    for note in rows[:200]:
        payload = (note.source_url or "") + "\n" + note.content
        paths = set()
        for raw in re.findall(r"https?://[^\s<>\"']+", payload):
            url = urlsplit(raw)
            params = parse_qs(url.query)
            if url.fragment:
                params.update(parse_qs(url.fragment.partition("?")[2]))
            for key in ("paper", "path"):
                paths.update(params.get(key, []))
        for version in versions:
            if version["id"] in payload:
                paths.add(version.get("kbPath") or "archive:" + version["id"])
        position = note.content.casefold().find(query.casefold())
        excerpt = (
            note.content[max(0, position - 60) : max(0, position) + 160]
            if position >= 0
            else note.title
        )
        for path in paths:
            path = unquote(path)
            if (
                isinstance(path, str)
                and 0 < len(path) <= 1100
                and (
                    path.startswith("archive:")
                    or (
                        path.startswith("sources/")
                        and path.endswith(".md")
                        and ".." not in path.split("/")
                        and "\\" not in path
                    )
                )
            ):
                result.setdefault(path, []).append(
                    {
                        "field": "note",
                        "text": excerpt,
                        "noteId": note.id,
                        "url": "/notes?note=" + note.id,
                    }
                )
    return result, len(rows) > 200 or len(result) > 200


@router.post("/query")
def query_library(
    body: QueryInput, db: Session = Depends(get_db), actor: dict = Depends(principal)
):
    return query_library_service(body, db, actor, note_matcher=note_matches)


@router.post("/detail")
def paper_detail(body: PaperInput, db: Session = Depends(get_db), actor: dict = Depends(principal)):
    return paper_detail_service(body, db, actor)


@router.post("/delete-preview")
def preview_paper_delete(
    body: DeletePaperInput, actor: dict = Depends(principal), db: Session = Depends(get_db)
):
    if original_delete.archive_id(body.paper_id):
        return original_delete.preview(
            Store(db, actor["tenant"]), actor["subject"], body.paper_id, connected
        )
    return connected("deletePaperPreview", actor["subject"], path=_deletable_path(body.paper_id))


@router.post("/delete")
def confirm_paper_delete(
    body: ConfirmDeletePaperInput, actor: dict = Depends(principal), db: Session = Depends(get_db)
):
    if original_delete.archive_id(body.paper_id):
        return original_delete.confirm(
            Store(db, actor["tenant"]), actor["subject"], body.paper_id, body.plan_id, connected
        )
    return connected(
        "deletePaper", actor["subject"], path=_deletable_path(body.paper_id), planId=body.plan_id
    )


@router.get("/delete-status")
def paper_delete_status(
    operation_id: str = Query(
        alias="operationId",
        pattern=r"^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$",
    ),
    actor: dict = Depends(principal),
    db: Session = Depends(get_db),
):
    status = original_delete.status(Store(db, actor["tenant"]), actor["subject"], operation_id)
    return status or connected("deletePaperStatus", actor["subject"], operationId=operation_id)


@router.get("/original")
def paper_original(
    paper_id: str = Query(alias="paperId", min_length=1, max_length=1100),
    attachment_id: str = Query(alias="attachmentId", min_length=1, max_length=200),
    actor: dict = Depends(principal),
):
    result = connected("readOriginal", actor["subject"], path=paper_id, attachmentId=attachment_id)
    try:
        content = base64.b64decode(result["base64"], validate=True)
    except (KeyError, ValueError, binascii.Error) as exc:
        raise HTTPException(502, "原件返回格式无效") from exc
    max_bytes = max(25, int(settings.KNOWLEDGE_FOLDER_IMPORT_MAX_FILE_MB)) * 1024 * 1024
    if len(content) > max_bytes or not content.lstrip()[:16].startswith(b"%PDF-"):
        raise HTTPException(502, "原件未通过 PDF 校验")
    return Response(
        content,
        media_type="application/pdf",
        headers={
            "Content-Disposition": "inline",
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "sandbox",
        },
    )


@router.post("/tags")
def set_tags(body: TagInput, actor: dict = Depends(principal)):
    return set_tags_service(body, actor)


@router.post("/metadata")
def set_metadata(body: MetadataInput, actor: dict = Depends(principal)):
    return connected(
        "updatePaperMetadata",
        actor["subject"],
        path=body.paper_id,
        revision=body.revision,
        metadata=body.metadata,
    )


@router.post("/usage")
def paper_usage(body: UsageInput, db: Session = Depends(get_db), actor: dict = Depends(principal)):
    return paper_usage_service(body.paper_ids, db, actor)


@router.post("/index/refresh", status_code=202)
def refresh_index(actor: dict = Depends(principal)):
    return connected("refreshLibraryIndex", actor["subject"])


@upload_router.post("/upload", status_code=201)
async def upload_paper(
    request: Request,
    db: Session = Depends(get_db),
    actor: dict = Depends(principal),
):
    from starlette.datastructures import UploadFile as StarletteUploadFile

    from app.api.multipart import upload_form

    catalogue = connected("librarySummary", actor["subject"])
    if not catalogue.get("canWrite"):
        raise HTTPException(403, "上传需要知识库负责人权限")
    async with upload_form(request, max_files=1, max_fields=10, max_part_size=64 * 1024) as form:
        uploaded = form.get("file")
        if not isinstance(uploaded, StarletteUploadFile):
            raise HTTPException(422, "请选择有效的 PDF 文件")
        raw_folder = form.get("folderId")
        if raw_folder is None:
            raw_folder = form.get("folder_id", "")
        folder_id = raw_folder if isinstance(raw_folder, str) else ""
        raw_no_folder = form.get("noFolder")
        if raw_no_folder is None:
            raw_no_folder = form.get("no_folder", "")
        no_folder = isinstance(raw_no_folder, str) and raw_no_folder.strip().lower() in {
            "1",
            "true",
            "yes",
            "on",
        }
        raw_parse = form.get("parse", "")
        parse = isinstance(raw_parse, str) and raw_parse.strip().lower() in {
            "1",
            "true",
            "yes",
            "on",
        }
        if parse:
            raise HTTPException(422, "上传先保留原件，请在知识库中主动建立问答索引")
        if no_folder and folder_id:
            raise HTTPException(422, "请选择文件夹或待整理，不能同时指定")
        original = await uploaded.read(25 * 1024 * 1024 + 1)
        filename = uploaded.filename or "文献.pdf"
    return upload_paper_service(
        db,
        actor,
        original=original,
        filename=filename,
        folder_id=folder_id,
        no_folder=no_folder,
        catalogue=catalogue,
        extract_pdf_fn=extract_pdf,
    )


@router.post("/export")
def export_papers(
    body: ExportInput, db: Session = Depends(get_db), actor: dict = Depends(principal)
):
    content, content_type = export_selection(
        Store(db, actor["tenant"]), actor, body.paper_ids, body.format, connected
    )
    filename = "知识源资料." + ("bib" if body.format == "bibtex" else body.format)
    return Response(
        content,
        media_type=content_type,
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename, safe='')}",
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )
