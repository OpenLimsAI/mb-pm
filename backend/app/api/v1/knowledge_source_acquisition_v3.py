# ruff: noqa: B008
"""V3 acquisition and update tools; original download and authorization paths are reused."""

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import Field
from sqlalchemy.orm import Session

from app.api.v1 import knowledge_sources as ks
from app.db.session import get_db
from app.services import knowledge_source_adapters_v3 as adapters
from app.services import knowledge_source_changes_v3 as changes
from app.services import knowledge_source_imports_v3 as imports
from app.services.information.store import Store, iso

router = APIRouter(prefix="/knowledge-sources/v3", tags=["knowledge-source-acquisition"])


class SearchInput(ks.Input):
    template_id: Literal["fda", "ema", "cde", "pubmed"] = Field(alias="templateId")
    query: str = Field(min_length=1, max_length=300)
    limit: int = Field(20, ge=1, le=30)


class ImportItem(ks.Input):
    input: str = Field(min_length=1, max_length=2048)
    title: str | None = Field(None, max_length=1000)


class ImportInput(ks.Input):
    items: list[ImportItem] = Field(default_factory=list, max_length=10)
    preview_token: str | None = Field(None, alias="previewToken", max_length=64)
    document_ids: list[str] = Field(default_factory=list, alias="documentIds", max_length=30)
    folder_id: str | None = Field(None, alias="folderId", max_length=100)
    download: bool = False
    parse: bool = False


class WatchInput(ks.Input):
    id: str | None = Field(None, max_length=64)
    name: str = Field(min_length=1, max_length=100)
    source_ids: list[str] = Field(default_factory=list, alias="sourceIds", max_length=50)
    keywords: str = Field("", max_length=300)
    codes: str = Field("", max_length=200)
    kinds: list[str] = Field(default_factory=list, max_length=20)
    muted: bool = False
    delete: bool = False


class DigestReadInput(ks.Input):
    event_ids: list[str] = Field(alias="eventIds", min_length=1, max_length=1000)


class DiffInput(ks.Input):
    document_id: str = Field(alias="documentId", max_length=64)
    before_id: str = Field(alias="beforeId", max_length=64)
    after_id: str = Field(alias="afterId", max_length=64)


@router.get("/templates")
def templates(actor=Depends(ks.principal)):
    return {"items": adapters.TEMPLATES, "canDownload": actor["manage"]}


@router.post("/acquisition/search")
def search(body: SearchInput, db: Session = Depends(get_db), actor=Depends(ks.principal)):
    try:
        result = adapters.search(body.template_id, body.query, body.limit)
    except ValueError as exc:
        raise HTTPException(502, str(exc)) from None
    store = Store(db, actor["tenant"])
    token = imports.issue_preview(store, actor["subject"], result["items"])
    db.commit()
    return {**result, "previewToken": token, "refreshedAt": iso()}


@router.post("/acquisition/import", status_code=201)
def import_items(body: ImportInput, db: Session = Depends(get_db), actor=Depends(ks.manager)):
    store = Store(db, actor["tenant"])
    catalogue = ks.writable_library(actor, store)
    if not body.items and not body.document_ids:
        raise HTTPException(400, "请填写 DOI、PMID、公开链接或选择来源搜索结果")
    if body.document_ids and not body.preview_token:
        raise HTTPException(400, "缺少本人来源搜索回执，请再次搜索")
    if body.folder_id and not any(f["id"] == body.folder_id for f in catalogue.get("folders", [])):
        raise HTTPException(409, "目标文件夹已不存在，请重新选择")
    if body.download:
        ks.require_worker()
    resolved = (
        imports.preview_items(store, actor["subject"], body.preview_token, body.document_ids)
        if body.document_ids
        else []
    )
    failures = []
    if body.items:
        client = adapters.MetadataClient()
        try:
            for item in body.items:
                try:
                    result = adapters.resolve_identifier(item.input, client=client)
                    if item.title and item.title.strip():
                        result["title"] = item.title.strip()
                    resolved.append(result)
                except (ValueError, KeyError, TypeError):
                    failures.append(
                        {
                            "input": item.input,
                            "error": "未能解析该标识符或公开链接，请检查后重试；未保存伪造的文献信息。",
                        }
                    )
        finally:
            client.close()
    results, batches = [], {}
    names = {t["id"]: t["name"] for t in adapters.TEMPLATES}
    for item in resolved:
        template_id = item.get("templateId", "manual")
        source = imports.ensure_source(store, template_id, names.get(template_id, "手动收录"))
        document, existing = imports.ensure_document(store, source, item)
        source_id = document["sourceId"]
        results.append(
            {
                "documentId": document["id"],
                "sourceId": source_id,
                "title": document["title"],
                "alreadyImported": existing,
                "status": "metadata_only",
            }
        )
        batches.setdefault(source_id, []).append(document["id"])
    jobs = []
    if body.download:
        for source_id, ids in batches.items():
            try:
                job = ks.create_job(
                    ks.JobInput(
                        sourceId=source_id,
                        documentIds=list(dict.fromkeys(ids)),
                        folderId=body.folder_id,
                        parse=body.parse,
                    ),
                    db=db,
                    actor=actor,
                )
                jobs.append({"sourceId": source_id, "jobId": job["id"]})
            except HTTPException as exc:
                # Existing metadata is valuable even if another source job occupies
                # the download queue. Report this explicitly, never return false success.
                if exc.status_code not in (400, 409, 422):
                    raise
                failures.append({"sourceId": source_id, "error": str(exc.detail)})
    store.audit(actor["subject"], "acquisition_v3_import", str(len(results)))
    db.commit()
    return {
        "items": results,
        "jobs": jobs,
        "errors": failures,
        "metadataOnly": not body.download,
        "downloadRequested": body.download,
        "indexRequested": body.download and body.parse,
    }


@router.get("/watches")
def get_watches(db: Session = Depends(get_db), actor=Depends(ks.principal)):
    return {"items": changes.watches(Store(db, actor["tenant"]), actor["subject"])}


@router.post("/watches")
def save_watch(body: WatchInput, db: Session = Depends(get_db), actor=Depends(ks.principal)):
    store = Store(db, actor["tenant"])
    source_ids = {s["id"] for s in store.records("source")}
    if not set(body.source_ids) <= source_ids:
        raise HTTPException(404, "关注的来源不存在")
    result = changes.save_watch(store, actor["subject"], body.model_dump(by_alias=True))
    db.commit()
    return result


@router.get("/digest")
def get_digest(
    days: int = Query(7, ge=1, le=90), db: Session = Depends(get_db), actor=Depends(ks.principal)
):
    return changes.digest(Store(db, actor["tenant"]), actor["subject"], days)


@router.post("/digest/read")
def mark_digest_read(
    body: DigestReadInput, db: Session = Depends(get_db), actor=Depends(ks.principal)
):
    result = changes.mark_digest_read(Store(db, actor["tenant"]), actor["subject"], body.event_ids)
    db.commit()
    return result


def readable_document(db, actor, document_id):
    store = Store(db, actor["tenant"])
    catalogue = ks.library(actor, store)
    papers = ks.paper_snapshot(store, actor, catalogue)
    visible = [p for p in papers if p.get("documentId") == document_id]
    if not visible:
        raise HTTPException(404, "资料不存在或无权阅读")
    return store, store.get("document", document_id), visible


@router.post("/versions/diff")
def version_diff(body: DiffInput, db: Session = Depends(get_db), actor=Depends(ks.principal)):
    store, document, papers = readable_document(db, actor, body.document_id)
    ids = {p.get("versionId") for p in papers}
    if body.before_id not in ids or body.after_id not in ids:
        raise HTTPException(404, "版本不存在、已删除或无权阅读")
    before, after = store.get("version", body.before_id), store.get("version", body.after_id)
    if before["documentId"] != document["id"] or after["documentId"] != document["id"]:
        raise HTTPException(400, "只能比较同一文档的两个版本")
    return changes.body_diff(before, after)


@router.get("/documents/{ident}/usage")
def document_usage(ident: str, db: Session = Depends(get_db), actor=Depends(ks.principal)):
    store, document, papers = readable_document(db, actor, ident)
    visible_versions = {p.get("versionId") for p in papers}
    versions = [
        v
        for v in store.records("version")
        if v["documentId"] == ident and v["id"] in visible_versions
    ]
    return changes.usage_links(db, actor, document, versions, [p["id"] for p in papers])
