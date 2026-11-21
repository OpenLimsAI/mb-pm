"""Knowledge Sources V3 library query, detail, statistics, tag, and usage service."""

from __future__ import annotations

import hashlib
import json
import re
from urllib.parse import quote

from fastapi import HTTPException

from app.models.information import InformationText
from app.services.information.store import Store
from app.services.knowledge_source_context import (
    archive_paper,
    connected,
    library,
    pending_archive,
)
from app.services.knowledge_source_inbox import inbox_id, normalized_folder_ids


def map_library_paper(value, versions, documents, sources, store, versions_by_path=None):
    path = value.get("path", value.get("id"))
    version = (
        versions_by_path.get(path)
        if versions_by_path is not None
        else next((v for v in versions if v.get("kbPath") == path), None)
    )
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


def archive_candidates(store, body, summary, actor, extra_queries=None, note_hits=None):
    """Only originals never linked to Core; deleted Core paths cannot reappear."""
    versions = store.records("version")
    documents = {d["id"]: d for d in store.documents()}
    sources = {s["id"]: s for s in store.records("source")}
    latest = {}
    proven_pending = set()
    batch_versions = None
    folder_id = getattr(body, "folder_id", "all")
    search_mode = getattr(body, "search_mode", "all")
    saved_after = getattr(body, "saved_after", None)
    paper_type = getattr(body, "type", None)
    index_status = getattr(body, "index_status", None)
    tag_ids = getattr(body, "tag_ids", [])
    raw_query = getattr(body, "query", "")

    if folder_id.startswith("batch:"):
        job = store.get("job", folder_id[6:])
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
    inbox = inbox_id(summary)
    query = raw_query.casefold()
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
        paper["folderIds"] = normalized_folder_ids(paper["folderIds"], summary)
        folders = set(paper["folderIds"])
        if folder_id == "unsorted" and folders - {inbox}:
            continue
        if (
            folder_id not in ("all", "unsorted", "recent", "starred")
            and not folder_id.startswith("batch:")
            and folder_id not in folders
        ):
            continue
        if saved_after and paper.get("createdAt", "") < saved_after:
            continue
        if paper_type and paper.get("type") != paper_type:
            continue
        if index_status and paper.get("indexStatus") != index_status:
            continue
        title = f'{paper["title"]} {paper.get("code", "")} {paper.get("sourceName", "")}'
        if search_mode == "all":
            title += " " + json.dumps(document.get("metadata", {}), ensure_ascii=False)
        if tag_ids:
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
                if text and text.tenant == store.tenant and search_mode == "all"
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


def merge_collection_options(options: dict, constraints: dict) -> dict:
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


class _TitleOnlySpec:
    folder_id = "all"
    search_mode = "title"
    saved_after = None
    type = None
    index_status = None
    tag_ids: list[str] = []
    query = ""


def library_statistics(store, actor: dict, summary: dict) -> dict:
    """Count signed pending originals once alongside active Core documents."""
    extras = archive_candidates(store, _TitleOnlySpec(), summary, actor)
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
                core_folders.setdefault(document, set()).update(
                    normalized_folder_ids(paper.get("folderIds", []), summary)
                )
    counts = dict(summary.get("folderCounts", {}))
    for paper in extras:
        for ident in paper.get("folderIds", []):
            if ident not in core_folders.get(paper["documentId"], set()):
                counts[ident] = counts.get(ident, 0) + 1
    total = summary.get("total", 0) + sum(p["documentId"] not in core_folders for p in extras)
    return {
        **summary,
        "folderCounts": counts,
        "total": total,
        "_archiveCandidates": extras,
        "_coreArchiveDocs": set(core_folders),
    }


def query_library_service(body, db, actor: dict, note_matcher=None) -> dict:
    store = Store(db, actor["tenant"])
    summary = library_statistics(store, actor, connected("librarySummary", actor["subject"]))
    is_inbox = body.folder_id == inbox_id(summary)
    options = {
        "query": body.query,
        "searchMode": body.search_mode,
        "folderIds": []
        if is_inbox
        or body.folder_id in ("all", "recent", "unsorted", "starred")
        or body.folder_id.startswith("batch:")
        else [body.folder_id],
        "unfiled": is_inbox or body.folder_id == "unsorted",
        "tags": body.tag_ids,
        "sort": body.sort,
    }
    if body.type:
        options["type"] = body.type
    if body.index_status:
        options["status"] = body.index_status
    versions = store.records("version")
    documents = {d["id"]: d for d in store.documents()}
    sources = {s["id"]: s for s in store.records("source")}
    preferred = [
        v["kbPath"]
        for v in versions
        if v.get("kbPath")
        and v.get("sha256") == documents.get(v["documentId"], {}).get("verifiedSha256")
    ]
    if preferred:
        options["preferredPaths"] = preferred[:5000]
    if body.saved_after and body.folder_id != "recent":
        options["savedAfter"] = body.saved_after
    preferences = store.preferences(actor["subject"])
    note_hits, note_truncated = (
        note_matcher(db, actor, body.query, versions)
        if body.search_mode == "all" and note_matcher
        else ({}, False)
    )
    if note_hits:
        options["notePaths"] = [path for path in note_hits if not path.startswith("archive:")][:200]
    if body.folder_id == "starred":
        aliases = {"archive:" + v["id"]: v.get("kbPath") or "archive:" + v["id"] for v in versions}
        options["paths"] = [
            aliases.get(path, path) for path in preferences.get("knowledgeSourceStars", [])
        ]
    if body.folder_id == "recent":
        options["paths"] = [
            v["kbPath"]
            for v in versions
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
            for v in versions
            if v["id"] in selected_versions
        ]
    if body.collection_id or body.reading_status:
        from app.services.knowledge_source_workspace_v3 import query_constraints

        options = merge_collection_options(
            options, query_constraints(store, actor, body.collection_id, body.reading_status)
        )
    workspace_query = options.pop("workspaceQuery", None)
    workspace_reading = options.pop("readingStatus", None)
    complex_query = bool(workspace_query or workspace_reading)
    can_reuse_candidates = (
        body.folder_id == "all"
        and not options["query"]
        and not options.get("extraQueries")
        and not body.tag_ids
        and not body.type
        and not body.index_status
        and not body.saved_after
        and not note_hits
        and "paths" not in options
        and "_archiveCandidates" in summary
    )
    if can_reuse_candidates:
        extras = [dict(p) for p in summary["_archiveCandidates"]]
    else:
        archive_body = body.model_copy(update={"query": options["query"]})
        extras = archive_candidates(
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
    bounded_window = (
        full_merge and not complex_query and "paths" not in options and len(extras) <= 200
    )
    window_limit = needed + len(extras) * 2 if bounded_window else None
    offset = body.offset if direct_page else 0
    search_index, incomplete = None, False
    while True:
        if direct_page:
            limit = min(100, needed - offset)
        elif window_limit is not None:
            limit = min(100, max(1, window_limit - offset))
        else:
            limit = 100
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
        if offset >= total or (direct_page and offset >= needed):
            break
        if window_limit is not None and offset >= window_limit:
            break
    versions_by_path = {v["kbPath"]: v for v in versions if v.get("kbPath")}
    papers = [
        map_library_paper(p, versions, documents, sources, store, versions_by_path=versions_by_path)
        for p in values
    ] + extras
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
        paper["folderIds"] = normalized_folder_ids(paper.get("folderIds", []), summary)
        paper["reading"] = reading_for(paper, reading)
        if paper["id"] in note_hits:
            paper["matches"] = [*paper.get("matches", []), *note_hits[paper["id"]]][:4]
    if full_merge and window_limit is not None and offset < total:
        core_docs = summary.get("_coreArchiveDocs", set())
        count = total + sum(1 for e in extras if e.get("documentId") not in core_docs)
    else:
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


def paper_detail_service(body, db, actor: dict) -> dict:
    store = Store(db, actor["tenant"])
    connected("librarySummary", actor["subject"])
    if body.paper_id.startswith("archive:"):
        version = store.get("version", body.paper_id[8:])
        proof = None
        if version.get("kbPath"):
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
    paper = map_library_paper(
        result,
        store.records("version"),
        {d["id"]: d for d in store.documents()},
        {s["id"]: s for s in store.records("source")},
        store,
    )
    originals = result.get("originals", [])
    original_url = paper.get("originalUrl")
    if not original_url and originals:
        original_url = (
            f'/api/v1/knowledge-sources/v3/library/original?paperId={quote(body.paper_id, safe="")}'
            f'&attachmentId={quote(originals[0]["attachmentId"], safe="")}'
        )
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


def set_tags_service(body, actor: dict) -> dict:
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


class _UsagePaperSpec:
    def __init__(self, paper_id: str):
        self.paper_id = paper_id
        self.query = ""
        self.offset = 0
        self.limit = 1000


def paper_usage_service(paper_ids: list[str], db, actor: dict) -> dict:
    from app.services.knowledge_source_changes_v3 import usage_links

    store, items, folders = Store(db, actor["tenant"]), {}, set()
    all_versions = store.records("version")
    versions_by_doc: dict[str, list[dict]] = {}
    for v in all_versions:
        versions_by_doc.setdefault(v["documentId"], []).append(v)
    for ident in dict.fromkeys(paper_ids):
        detail = paper_detail_service(_UsagePaperSpec(ident), db, actor)
        paper = detail["paper"]
        folders.update(paper.get("folderIds", []))
        doc_id = paper.get("documentId")
        document = store.get("document", doc_id, required=False) if doc_id else None
        versions = sorted(
            versions_by_doc.get(doc_id, []),
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
