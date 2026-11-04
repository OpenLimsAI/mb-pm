# ruff: noqa: B008
"""Authenticated, paged library access through the existing signed KB bridge."""

import base64
import binascii
import hashlib
import json
import re
import tempfile
from pathlib import Path
from typing import Literal
from urllib.parse import parse_qs, quote, unquote, urlsplit

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import Response
from pydantic import Field
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.api.v1.knowledge_sources import (
    Input,
    archive_paper,
    connected,
    principal,
)
from app.db.session import get_db
from app.models.information import InformationText
from app.models.note import PersonalNote
from app.services.information.extract import extract_pdf
from app.services.information.store import Store, iso

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


class TagInput(Input):
    paper_ids: list[str] = Field(alias="paperIds", min_length=1, max_length=100)
    tags: list[str] = Field(max_length=3)
    revision: int = Field(ge=0)
    mode: Literal["replace", "add"] = "replace"


class MetadataInput(Input):
    paper_id: str = Field(alias="paperId", min_length=1, max_length=1100)
    revision: int = Field(ge=0)
    metadata: dict


class ExportInput(Input):
    paper_ids: list[str] = Field(alias="paperIds", min_length=1, max_length=100)
    format: Literal["bibtex", "ris", "csv", "zip"]


class UsageInput(Input):
    paper_ids: list[str] = Field(alias="paperIds", min_length=1, max_length=20)


def _map_paper(value, versions, documents, sources, store):
    path = value.get("path", value.get("id"))
    version = next((v for v in versions if v.get("kbPath") == path), None)
    metadata = value.get("metadata") or {}
    result = {
        **value,
        "id": path,
        "path": path,
        "folderIds": value.get("folderIds", []),
        "saved": bool(value.get("originals")),
        "sourceName": "知识库",
        "indexStatus": value.get("indexStatus", "unknown"),
        "kbUrl": value.get("url"),
        **{key: metadata[key] for key in ("authors", "year", "doi", "abstract") if key in metadata},
    }
    result["tags"] = [
        {"id": t, "name": t} if isinstance(t, str) else t for t in value.get("tags", [])
    ]
    result["createdAt"] = value.get("createdAt") or ""
    if isinstance(result.get("authors"), str):
        result["authors"] = [result["authors"]]
    if result.get("year") is not None:
        result["year"] = str(result["year"])
    if version and (document := documents.get(version["documentId"])):
        result.update(
            archive_paper(store, document, version, sources.get(document["sourceId"]), versions)
        )
        result.update(
            id=path,
            path=path,
            title=value.get("title") or document["title"],
            folderIds=value.get("folderIds", []),
        )
        result.update(
            {
                key: str(metadata[key]) if key == "year" else metadata[key]
                for key in ("authors", "year", "doi", "abstract")
                if key in metadata
            }
        )
    if isinstance(result.get("authors"), str):
        result["authors"] = [result["authors"]]
    return result


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


def _archive_candidates(store, body, summary, actor, extra_queries=None, note_hits=None):
    """Only originals never linked to Core; deleted Core paths cannot reappear."""
    versions = store.records("version")
    documents = {d["id"]: d for d in store.documents()}
    sources = {s["id"]: s for s in store.records("source")}
    latest = {}
    proven_pending = set()
    batch_versions = None
    if body.folder_id.startswith("batch:"):
        job = store.get("job", body.folder_id[6:])
        if job.get("app") != "knowledge-sources":
            raise HTTPException(404, "下载批次不存在")
        batch_versions = {item.get("versionId") for item in job.get("items", [])}
    for version in versions:
        if batch_versions is not None and version["id"] not in batch_versions:
            continue
        pending_proof = any(
            proof.get("path") == version.get("kbPath")
            and proof.get("sha256") == version.get("sha256")
            and proof.get("documentId") == version.get("kbDocumentId", version["documentId"])
            for proof in summary.get("pendingArchives", [])
        )
        if pending_proof:
            proven_pending.add(version["id"])
        if not version.get("kbPath") or pending_proof:
            current = latest.get(version["documentId"])
            if not current or version.get("createdAt", "") > current.get("createdAt", ""):
                latest[version["documentId"]] = version
    guarded = {
        v["documentId"]
        for v in versions
        if v.get("kbPath")
        and v["documentId"] in latest
        and latest[v["documentId"]]["id"] not in proven_pending
    }
    paths = [v["kbPath"] for v in versions if v.get("kbPath") and v["documentId"] in guarded]
    active = set()
    for start in range(0, len(paths), 100):
        permitted = connected(
            "queryLibrary",
            actor["subject"],
            paths=paths[start : start + 100],
            query="",
            offset=0,
            limit=100,
            sort="recent",
        )
        active.update(p["path"] for p in permitted.get("papers", []))
    live_documents = {v["documentId"] for v in versions if v.get("kbPath") in active}
    papers = []
    source_ids = {s.get("archiveFolderId") or s.get("folderId") for s in sources.values()}
    source_names = {
        "ICH" if s.get("adapter") == "ich" else s.get("name")
        for s in sources.values()
        if s.get("adapter") != "manual"
    }
    source_folders = {
        f["id"]
        for f in summary.get("folders", [])
        if f.get("kind") == "source"
        or (not f.get("kind") and (f["id"] in source_ids or f["name"] in source_names))
    }
    known = {f["id"] for f in summary.get("folders", [])}
    query = body.query.casefold()
    for version in latest.values():
        if version["documentId"] in guarded and version["documentId"] not in live_documents:
            continue
        document = documents.get(version["documentId"])
        if not document:
            continue
        paper = archive_paper(store, document, version, sources.get(document["sourceId"]), versions)
        if version["id"] in proven_pending:
            proof = next(
                item
                for item in summary["pendingArchives"]
                if item.get("path") == version.get("kbPath")
                and item.get("sha256") == version.get("sha256")
                and item.get("documentId") == version.get("kbDocumentId", version["documentId"])
            )
            paper.update(kbUrl=None, indexStatus=proof["indexStatus"])
        paper["folderIds"] = [f for f in paper["folderIds"] if f in known]
        folders = set(paper["folderIds"])
        if body.folder_id == "unsorted" and folders - source_folders:
            continue
        if (
            body.folder_id not in ("all", "unsorted", "recent", "starred")
            and not body.folder_id.startswith("batch:")
            and body.folder_id not in folders
        ):
            continue
        if body.saved_after and paper.get("createdAt", "") < body.saved_after:
            continue
        if body.type and paper.get("type") != body.type:
            continue
        if body.index_status and paper.get("indexStatus") != body.index_status:
            continue
        title = f'{paper["title"]} {paper.get("code", "")} {paper.get("sourceName", "")}'
        if body.search_mode == "all":
            title += " " + json.dumps(document.get("metadata", {}), ensure_ascii=False)
        if body.tag_ids:
            continue
        accepted = True
        for index, term in enumerate([query, *(extra_queries or [])]):
            if (
                not term
                or term.casefold() in title.casefold()
                or (index == 0 and paper["id"] in (note_hits or {}))
            ):
                continue
            text = store.db.get(InformationText, version["id"])
            match = (
                re.search(re.escape(term), text.content, flags=re.I)
                if text and text.tenant == store.tenant and body.search_mode == "all"
                else None
            )
            if not match:
                accepted = False
                break
            position = match.start()
            paper["matches"] = [
                {
                    "text": text.content[max(0, position - 80) : position + 180],
                    "offset": position,
                    "field": "body",
                }
            ]
        if not accepted:
            continue
        papers.append(paper)
    return papers


def merge_collection_options(options, constraints):
    result = {**options}
    collection_text = constraints.get("query")
    if collection_text:
        if result.get("query") and result["query"] != collection_text:
            result["extraQueries"] = [collection_text]
        else:
            result["query"] = collection_text
    if constraints.get("folderIds"):
        if result.get("folderIds"):
            intersect = sorted(set(result["folderIds"]) & set(constraints["folderIds"]))
            if not intersect:
                result["paths"] = []
            result["folderIds"] = intersect
        else:
            result["folderIds"] = constraints["folderIds"]
    result["tags"] = sorted(set(result.get("tags", [])) | set(constraints.get("tags", [])))
    if len(result["tags"]) > 3:
        # A paper can have only three shared tags, so this intersection is empty.
        result.update(paths=[], tags=[])
    for key in ("type", "workspaceQuery", "readingStatus"):
        if key in constraints:
            if key == "type" and result.get(key) and result[key] != constraints[key]:
                result["paths"] = []
            result[key] = constraints[key]
    return result


def library_statistics(store, actor, summary):
    """Count signed pending originals once alongside active Core documents."""
    extras = _archive_candidates(store, QueryInput(searchMode="title"), summary, actor)
    if not extras:
        return {**summary, "_archiveCandidates": []}
    documents = {p["documentId"] for p in extras}
    versions = {
        v["kbPath"]: v
        for v in store.records("version")
        if v.get("kbPath") and v["documentId"] in documents
    }
    paths, core_folders = list(versions), {}
    for start in range(0, len(paths), 100):
        page = connected(
            "queryLibrary",
            actor["subject"],
            paths=paths[start : start + 100],
            groupLatest=False,
            offset=0,
            limit=100,
            sort="recent",
        )
        for paper in page.get("papers", []):
            if paper["path"] in versions:
                document = versions[paper["path"]]["documentId"]
                core_folders.setdefault(document, set()).update(paper.get("folderIds", []))
    counts = dict(summary.get("folderCounts", {}))
    for paper in extras:
        for ident in paper.get("folderIds", []):
            if ident not in core_folders.get(paper["documentId"], set()):
                counts[ident] = counts.get(ident, 0) + 1
    total = summary.get("total", 0) + sum(p["documentId"] not in core_folders for p in extras)
    return {**summary, "folderCounts": counts, "total": total, "_archiveCandidates": extras}


@router.post("/query")
def query_library(
    body: QueryInput, db: Session = Depends(get_db), actor: dict = Depends(principal)
):
    store = Store(db, actor["tenant"])
    summary = library_statistics(store, actor, connected("librarySummary", actor["subject"]))
    options = {
        "query": body.query,
        "searchMode": body.search_mode,
        "folderIds": []
        if body.folder_id in ("all", "recent", "unsorted", "starred")
        or body.folder_id.startswith("batch:")
        else [body.folder_id],
        "unfiled": body.folder_id == "unsorted",
        "tags": body.tag_ids,
        "sort": body.sort,
    }
    if body.type:
        options["type"] = body.type
    if body.index_status:
        options["status"] = body.index_status
    documents = {d["id"]: d for d in store.documents()}
    preferred = [
        v["kbPath"]
        for v in store.records("version")
        if v.get("kbPath")
        and v.get("sha256") == documents.get(v["documentId"], {}).get("verifiedSha256")
    ]
    if preferred:
        options["preferredPaths"] = preferred[:5000]
    if body.saved_after and body.folder_id != "recent":
        options["savedAfter"] = body.saved_after
    preferences = store.preferences(actor["subject"])
    note_hits, note_truncated = (
        note_matches(db, actor, body.query, store.records("version"))
        if body.search_mode == "all"
        else ({}, False)
    )
    if note_hits:
        options["notePaths"] = [path for path in note_hits if not path.startswith("archive:")][:200]
    if body.folder_id == "starred":
        aliases = {
            "archive:" + v["id"]: v.get("kbPath") or "archive:" + v["id"]
            for v in store.records("version")
        }
        options["paths"] = [
            aliases.get(path, path) for path in preferences.get("knowledgeSourceStars", [])
        ]
    if body.folder_id == "recent":
        options["paths"] = [
            v["kbPath"]
            for v in store.records("version")
            if v.get("kbPath")
            and (not body.saved_after or v.get("createdAt", "") >= body.saved_after)
        ]
    if body.folder_id.startswith("batch:"):
        job = store.get("job", body.folder_id[6:])
        if job.get("app") != "knowledge-sources":
            raise HTTPException(404, "下载批次不存在")
        selected_versions = {i.get("versionId") for i in job.get("items", [])}
        options["paths"] = [
            v.get("kbPath") or "archive:" + v["id"]
            for v in store.records("version")
            if v["id"] in selected_versions
        ]
    # Workspace state/collections are resolved by a single shared evaluator.
    if body.collection_id or body.reading_status:
        from app.services.knowledge_source_workspace_v3 import query_constraints

        options = merge_collection_options(
            options, query_constraints(store, actor, body.collection_id, body.reading_status)
        )
    workspace_query = options.pop("workspaceQuery", None)
    workspace_reading = options.pop("readingStatus", None)
    complex_query = bool(workspace_query or workspace_reading)
    archive_body = body.model_copy(update={"query": options["query"]})
    extras = _archive_candidates(
        store, archive_body, summary, actor, options.get("extraQueries"), note_hits
    )
    if "paths" in options:
        extras = [
            p for p in extras if p["id"] in options["paths"] or p.get("kbPath") in options["paths"]
        ]
    needed = body.offset + body.limit
    values, total, revision = [], 0, summary.get("revision", 0)
    full_merge = bool(extras) or complex_query
    direct_page = not full_merge
    offset = body.offset if direct_page else 0
    search_index, incomplete = None, False
    while True:
        limit = 100 if full_merge else min(100, needed - offset)
        kb_options = {**options}
        if "paths" in kb_options:
            kb_options["paths"] = [
                path for path in kb_options["paths"] if not path.startswith("archive:")
            ]
        page = connected("queryLibrary", actor["subject"], **kb_options, offset=offset, limit=limit)
        search_index, incomplete = page.get("searchIndex"), bool(page.get("incomplete"))
        values.extend(page.get("papers", []))
        total, revision = page.get("total", 0), page.get("revision", revision)
        offset += limit
        if offset >= total or (not full_merge and offset >= needed):
            break
    versions = store.records("version")
    documents = {d["id"]: d for d in store.documents()}
    sources = {s["id"]: s for s in store.records("source")}
    papers = [_map_paper(p, versions, documents, sources, store) for p in values] + extras
    if complex_query:
        from app.services.knowledge_source_workspace_v3 import filter_workspace_papers

        papers = filter_workspace_papers(
            store,
            actor,
            papers,
            collection_id=body.collection_id,
            reading_status=body.reading_status,
            text_already_matched=True,
        )
    if full_merge:
        official = {
            v["id"]
            for v in versions
            if v.get("sha256") == documents.get(v["documentId"], {}).get("verifiedSha256")
        }
        grouped = {}
        for paper in papers:
            key = paper.get("documentId") or paper["id"]
            previous = grouped.get(key)
            if not previous or (
                paper.get("versionId") in official,
                paper.get("createdAt") or "",
            ) > (previous.get("versionId") in official, previous.get("createdAt") or ""):
                grouped[key] = paper
        papers = list(grouped.values())
        papers.sort(
            key=(lambda p: p.get("title", "").casefold())
            if body.sort == "title"
            else (lambda p: p.get("createdAt") or ""),
            reverse=body.sort == "recent",
        )
    from app.services.knowledge_source_workspace_v3 import public_workspace, reading_for

    reading = public_workspace(store, actor["subject"])["reading"]
    for paper in papers:
        paper["reading"] = reading_for(paper, reading)
        if paper["id"] in note_hits:
            paper["matches"] = [*paper.get("matches", []), *note_hits[paper["id"]]][:4]
    count = len(papers) if full_merge else total
    return {
        "papers": papers[: body.limit] if direct_page else papers[body.offset : needed],
        "total": count,
        "offset": body.offset,
        "limit": body.limit,
        "nextOffset": needed if needed < count else None,
        "revision": revision,
        "folderCounts": summary.get("folderCounts", {}),
        "tags": [{"id": t, "name": t} for t in summary.get("tagsCatalog", [])],
        "searchIndex": search_index,
        "incomplete": incomplete,
        "noteSearchTruncated": note_truncated,
    }


@router.post("/detail")
def paper_detail(body: PaperInput, db: Session = Depends(get_db), actor: dict = Depends(principal)):
    store = Store(db, actor["tenant"])
    connected("librarySummary", actor["subject"])
    if body.paper_id.startswith("archive:"):
        version = store.get("version", body.paper_id[8:])
        proof = None
        if version.get("kbPath"):
            from app.api.v1.knowledge_sources import library, pending_archive

            catalogue = library(
                actor,
                imports=[
                    {
                        "documentId": version.get("kbDocumentId", version["documentId"]),
                        "sha256": version["sha256"],
                    }
                ],
            )
            active = any(p.get("path") == version["kbPath"] for p in catalogue.get("papers", []))
            proof = pending_archive(version, catalogue) if not active else None
            if not active and not proof:
                raise HTTPException(404, "资料已删除或无权访问")
        document = store.get("document", version["documentId"])
        paper = archive_paper(
            store, document, version, store.source(document["sourceId"]), store.records("version")
        )
        if proof:
            paper.update(kbUrl=None, indexStatus=proof["indexStatus"])
        text = version.get("text", "")
        return {
            "paper": paper,
            "text": text[body.offset : body.offset + body.limit],
            "textOffset": body.offset,
            "totalCharacters": len(text),
            "contentHash": hashlib.sha256(text.encode()).hexdigest(),
            "originalUrl": paper["originalUrl"],
            "canWrite": False,
            "positionUnit": "codepoint",
        }
    result = connected(
        "readPaper",
        actor["subject"],
        path=body.paper_id,
        query=body.query,
        offset=body.offset,
        limit=body.limit,
    )
    paper = _map_paper(
        result,
        store.records("version"),
        {d["id"]: d for d in store.documents()},
        {s["id"]: s for s in store.records("source")},
        store,
    )
    originals = result.get("originals", [])
    original_url = paper.get("originalUrl")
    if not original_url and originals:
        original_url = f'/api/v1/knowledge-sources/v3/library/original?paperId={quote(body.paper_id, safe="")}&attachmentId={quote(originals[0]["attachmentId"], safe="")}'
    return {
        **result,
        "paper": paper,
        "text": result.get("body", ""),
        "textOffset": result.get("offset", body.offset),
        "totalCharacters": result.get("totalLength", len(result.get("body", ""))),
        "contentHash": result.get("hash"),
        "originalUrl": original_url,
        "kbUrl": result.get("url"),
        "canWrite": result.get("canWrite", False),
    }


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
    if len(content) > 25 * 1024 * 1024 or not content.lstrip()[:16].startswith(b"%PDF-"):
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
    # All paths are re-authorized by KB; archive-only material must be ingested first.
    if any(path.startswith("archive:") for path in body.paper_ids):
        raise HTTPException(409, "请先将归档资料加入知识库，再使用共享标签")
    results = []
    for path in body.paper_ids:
        try:
            if body.mode == "add" or len(body.paper_ids) > 1:
                current = connected("readPaper", actor["subject"], path=path, limit=1000)
                revision = current.get("insightRevision", 0)
                existing = current.get("tags", []) if body.mode == "add" else []
                tags = list(
                    dict.fromkeys(
                        [
                            *(
                                t.get("name", t.get("id", "")) if isinstance(t, dict) else t
                                for t in existing
                            ),
                            *body.tags,
                        ]
                    )
                )
            else:
                revision, tags = body.revision, body.tags
            if len(tags) > 3:
                raise HTTPException(422, "标签合计超过3个，请在单篇资料中选择保留项")
            result = connected(
                "updatePaperTags", actor["subject"], path=path, tags=tags, revision=revision
            )
            results.append({"paperId": path, "saved": True, **result})
        except HTTPException as exc:
            if len(body.paper_ids) == 1 and body.mode == "replace":
                raise
            results.append(
                {
                    "paperId": path,
                    "saved": False,
                    "status": exc.status_code,
                    "error": str(exc.detail),
                }
            )
    saved = sum(bool(item.get("saved")) for item in results)
    return {
        "saved": saved == len(results),
        "partial": saved < len(results),
        "savedCount": saved,
        "results": results,
    }


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
    from app.services.knowledge_source_changes_v3 import usage_links

    store, items, folders = Store(db, actor["tenant"]), {}, set()
    for ident in dict.fromkeys(body.paper_ids):
        detail = paper_detail(PaperInput(paperId=ident, limit=1000), db, actor)
        paper = detail["paper"]
        folders.update(paper.get("folderIds", []))
        document = (
            store.get("document", paper["documentId"], required=False)
            if paper.get("documentId")
            else None
        )
        versions = sorted(
            [v for v in store.records("version") if v["documentId"] == paper.get("documentId")],
            key=lambda v: v.get("createdAt", ""),
        )
        references = usage_links(
            db,
            actor,
            document or {"id": "", "url": paper.get("kbUrl")},
            versions,
            [ident, paper.get("kbUrl") or ""],
        )
        for reference in references["items"]:
            key = reference["kind"] + ":" + reference["id"]
            record = items.setdefault(key, {**reference, "paperIds": []})
            record["paperIds"].append(ident)
    return {
        "items": list(items.values()),
        "folderIds": sorted(folders),
        "scope": "本人有权访问且带明确资料链接的笔记与报告",
    }


@router.post("/index/refresh", status_code=202)
def refresh_index(actor: dict = Depends(principal)):
    return connected("refreshLibraryIndex", actor["subject"])


@upload_router.post("/upload", status_code=201)
def upload_paper(
    file: UploadFile = File(...),
    folder_id: str = Form("", alias="folderId"),
    parse: bool = Form(False),
    db: Session = Depends(get_db),
    actor: dict = Depends(principal),
):
    catalogue = connected("librarySummary", actor["subject"])
    if not catalogue.get("canWrite"):
        raise HTTPException(403, "上传需要知识库负责人权限")
    if parse:
        raise HTTPException(422, "上传先保留原件，请在知识库中主动建立问答索引")
    original = file.file.read(25 * 1024 * 1024 + 1)
    file.file.close()
    if len(original) > 25 * 1024 * 1024:
        raise HTTPException(413, "单份 PDF 请控制在 25 MB 以内")
    if not original.lstrip()[:16].startswith(b"%PDF-"):
        raise HTTPException(400, "请选择有效的 PDF 文件")
    if len(folder_id) > 100:
        raise HTTPException(422, "请选择目标文件夹")
    text, issue = "", None
    with tempfile.TemporaryDirectory(prefix="knowledge-source-upload-") as directory:
        path = Path(directory) / "original.pdf"
        path.write_bytes(original)
        try:
            text = extract_pdf(path)
            if len(text) > 2_000_000:
                text, issue = "", "正文超过解析大小上限，原件保留，可拆分后另行索引"
        except (ValueError, OSError) as exc:
            issue = str(exc)[:200]
    result = connected(
        "uploadPaper",
        actor["subject"],
        name=(file.filename or "文献.pdf")[:200],
        originalBase64=base64.b64encode(original).decode(),
        sha256=hashlib.sha256(original).hexdigest(),
        text=text,
        **({"folderId": folder_id} if folder_id else {}),
        parse=False,
    )
    store = Store(db, actor["tenant"])
    sha = hashlib.sha256(original).hexdigest()
    source_id, document_id = (
        store.key("source", "manual-upload"),
        store.key("document", "manual:" + sha),
    )
    manual_source = store.get("source", source_id, required=False) or {
        "id": source_id,
        "name": "手动收录",
        "url": "",
        "adapter": "manual",
        "scopes": [],
        "enabled": False,
        "autoIndex": False,
        "createdAt": iso(),
    }
    manual_source["folderId"] = None
    store.put("source", manual_source)
    document = store.get("document", document_id, required=False)
    if not document:
        document = {
            "id": document_id,
            "sourceId": source_id,
            "title": Path(file.filename or "文献.pdf").stem[:500],
            "url": "",
            "scopes": [],
            "folderIds": [],
            "documentType": "手动上传",
            "format": "PDF",
            "language": "未提供",
            "status": "archived",
            "discoveredAt": iso(),
        }
    document["folderIds"] = sorted(set(document.get("folderIds", [])) | {result["folderId"]})
    store.put("document", document)
    version = store.archive(
        document_id, original, text, parse_status="ready" if text else "failed", error=issue
    )
    version.update(
        kbPath=result["path"],
        kbUrl=result.get("url"),
        kbDocumentId=result["documentId"],
        kbPending=not result.get("registered", False),
        indexStatus=result.get("indexStatus", "not_requested"),
    )
    store.put("version", version)
    store.audit(actor["subject"], "knowledge_source_manual_upload", document_id)
    db.commit()
    filing = None
    from app.services.knowledge_source_workspace_v3 import apply_enabled_rules, workspace

    if any(rule.get("enabled") for rule in workspace(store, actor["subject"])["rules"]):
        try:
            from app.api.v1.knowledge_source_workspace_v3 import context

            catalogue, papers = context(store, actor)
            if catalogue.get("canWrite"):
                filing = apply_enabled_rules(
                    store,
                    actor,
                    catalogue=catalogue,
                    papers=papers,
                    connect=connected,
                    paper_ids=["archive:" + version["id"]],
                )
        except Exception:
            db.rollback()
            filing = [
                {
                    "saved": False,
                    "error": "原件已保存，自动归档暂未完成，可在规则面板预览后手动执行",
                }
            ]
    return {
        **result,
        "paperId": result["path"] if result.get("registered") else "archive:" + version["id"],
        "originalSaved": True,
        "textExtracted": bool(text),
        "extractionIssue": issue,
        "indexRequested": False,
        "ruleFiling": filing,
    }


@router.post("/export")
def export_papers(
    body: ExportInput, db: Session = Depends(get_db), actor: dict = Depends(principal)
):
    from app.services.knowledge_source_exports_v3 import export_selection

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
