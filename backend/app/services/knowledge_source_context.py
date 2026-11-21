"""Shared Knowledge Sources bridge, catalogue, and archive snapshot context."""

from __future__ import annotations

from fastapi import HTTPException

from app.services.information import bridge
from app.services.knowledge_source_inbox import normalized_folder_ids
from app.services.knowledge_source_status import version_state


def connected(operation: str, subject: str, **values):
    try:
        return bridge.call(operation, subject, **values)
    except bridge.BridgeError as exc:
        status = exc.status if exc.status in (400, 401, 403, 404, 409, 422) else 503
        if exc.code == "paper_delete_plan_expired":
            raise HTTPException(status, {"message": str(exc), "code": exc.code}) from exc
        raise HTTPException(status, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(503, str(exc)) from exc


def library(actor: dict, store=None, imports=None) -> dict:
    # Core registers a package only after ingest. Ask the authenticated BFF to prove
    # unindexed imports from its own durable receipts, never infer access from a path.
    if imports is None:
        imports = [
            {"documentId": v.get("kbDocumentId", v["documentId"]), "sha256": v["sha256"]}
            for v in (store.records("version") if store else [])
            if v.get("kbPath") and v.get("indexStatus") != "ready"
        ]
    chunks = [imports[i : i + 5000] for i in range(0, len(imports), 5000)] or [[]]
    proofs = []
    result = {}
    for chunk in chunks:
        result = connected("library", actor["subject"], imports=chunk)
        proofs.extend(result.get("pendingArchives", []))
    return {**result, "pendingArchives": proofs}


def writable_library(actor: dict, store=None) -> dict:
    result = library(actor, store)
    if not result.get("canWrite"):
        raise HTTPException(403, "当前知识库角色没有文件夹整理权限")
    return result


def pending_archive(version: dict, catalogue: dict) -> dict | None:
    if version.get("indexStatus") == "ready":
        return None
    return next(
        (
            proof
            for proof in catalogue.get("pendingArchives", [])
            if proof.get("documentId") == version.get("kbDocumentId", version["documentId"])
            and proof.get("sha256") == version["sha256"]
            and proof.get("path") == version.get("kbPath")
            and proof.get("indexStatus") in ("not_requested", "pending", "failed")
        ),
        None,
    )


def classifications(store, document: str) -> dict | None:
    return store.get("ks_classification", store.key("ks_classification", document), required=False)


def archive_paper(store, doc: dict, version: dict, source: dict | None, versions=None) -> dict:
    classification = classifications(store, doc["id"])
    return {
        **{
            key: value
            for key, value in doc.get("metadata", {}).items()
            if key in {"authors", "year", "doi", "pmid", "abstract", "journal"}
        },
        "id": "archive:" + version["id"],
        "documentId": doc["id"],
        "versionId": version["id"],
        "title": doc["title"],
        "code": doc.get("code", ""),
        "sourceId": doc["sourceId"],
        "sourceName": source["name"] if source else "来源下载",
        "sourceUrl": doc.get("url"),
        "folderIds": classification["folderIds"] if classification else doc.get("folderIds", []),
        "saved": True,
        "size": version["size"],
        "createdAt": version["createdAt"],
        "indexStatus": version["indexStatus"],
        "parseStatus": version["parseStatus"],
        "originalUrl": (
            f'/api/v1/knowledge-sources/documents/{doc["id"]}/versions/{version["id"]}/original'
        ),
        "kbUrl": version.get("kbUrl"),
        "kbPath": version.get("kbPath"),
        "type": doc.get("documentType", "官方资料"),
        "language": doc.get("language", "来源未标注"),
        "officialDate": version.get("officialDate"),
        "officialStatus": doc.get("officialStatus"),
        "downloadedAt": version["createdAt"],
        "versionStatus": version_state(
            doc,
            [
                v
                for v in (versions if versions is not None else store.records("version"))
                if v["documentId"] == doc["id"]
            ],
        ),
        "error": version.get("error") or (classification.get("error") if classification else None),
    }


def paper_snapshot(store, actor: dict, result: dict) -> list[dict]:
    versions = store.records("version")
    docs = {d["id"]: d for d in store.documents()}
    sources = {s["id"]: s for s in store.records("source")}
    by_path = {v["kbPath"]: v for v in versions if v.get("kbPath")}
    memberships = result.get("memberships", {})
    assignments = result.get("assignments", {})
    active_paths = {p["path"] for p in result.get("papers", []) if isinstance(p.get("path"), str)}
    papers = []
    for value in result.get("papers", []):
        path = value.get("path")
        if not isinstance(path, str):
            continue
        version = by_path.get(path)
        doc = docs.get(version["documentId"]) if version else None
        source = sources.get(doc["sourceId"]) if doc else None
        fallback = [assignments[path]] if assignments.get(path) else []
        folders = memberships.get(path, value.get("folderIds", fallback))
        paper = {
            "id": path,
            "title": value.get("title") or path.rsplit("/", 1)[-1],
            "folderIds": folders,
            "saved": False,
            "indexStatus": value.get("indexStatus", "unknown"),
            "kbUrl": value.get("url"),
            "createdAt": value.get("createdAt") or value.get("updatedAt"),
            "sourceName": "知识库",
            "type": "知识库论文",
        }
        if doc and version:
            paper.update(
                archive_paper(store, doc, version, source, versions), id=path, folderIds=folders
            )
        papers.append(paper)
    for version in versions:
        # A deleted/hidden Core paper must not reappear through its retained original.
        if version["documentId"] not in docs:
            continue
        if version.get("kbPath") in active_paths:
            continue
        proof = pending_archive(version, result) if version.get("kbPath") else None
        if version.get("kbPath") and not proof:
            continue
        doc = docs[version["documentId"]]
        paper = archive_paper(store, doc, version, sources.get(doc["sourceId"]), versions)
        if proof:
            paper["kbUrl"] = None
            paper["indexStatus"] = proof["indexStatus"]
        papers.append(paper)
    # One logical document may have several readable archived versions. Expose a
    # preferred version without removing historical rows or changing their IDs.
    for docid, document in docs.items():
        group = [p for p in papers if p.get("documentId") == docid]
        if not group:
            continue
        verified_ids = {
            v["id"]
            for v in versions
            if v["documentId"] == docid and v["sha256"] == document.get("verifiedSha256")
        }
        preferred = max(
            group, key=lambda p: (p.get("versionId") in verified_ids, p.get("createdAt") or "")
        )
        for paper in group:
            paper["latest"] = paper["id"] == preferred["id"]
    prefs = store.preferences(actor["subject"])
    stars = prefs.get("knowledgeSourceStars", [])
    for paper in papers:
        paper["folderIds"] = normalized_folder_ids(paper["folderIds"], result)
        alias = "archive:" + paper["versionId"] if paper.get("versionId") else None
        paper["starred"] = paper["id"] in stars or alias in stars
    return papers


def workspace_catalogue_context(
    store, actor: dict, connect_fn=connected, library_fn=library
) -> tuple[dict, list[dict]]:
    catalogue = library_fn(actor, store)
    papers = paper_snapshot(store, actor, catalogue)
    # Full metadata paging is deliberate here: rules and duplicates must not act on
    # just the currently displayed page. Text bodies are never included in this loop.
    offset = 0
    enriched = {}
    while True:
        page = connect_fn(
            "queryLibrary",
            actor["subject"],
            query="",
            folderIds=[],
            tags=[],
            offset=offset,
            limit=100,
            sort="recent",
        )
        for item in page.get("papers", []):
            enriched[item.get("path") or item.get("id")] = item
        next_offset = page.get("nextOffset")
        if next_offset is None:
            break
        if not isinstance(next_offset, int) or next_offset <= offset:
            raise HTTPException(503, "知识库分页游标无效，请稍后重试")
        offset = next_offset
    papers = [
        {
            **paper,
            **{
                key: value
                for key, value in enriched.get(paper["id"], {}).items()
                if key in {"metadata", "tags", "hash", "matches"}
            },
        }
        for paper in papers
    ]
    return catalogue, papers
