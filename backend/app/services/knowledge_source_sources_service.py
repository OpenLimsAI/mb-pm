"""Knowledge Sources snapshot, source configuration, reference import, and job service."""

from __future__ import annotations

import ipaddress
import time
from urllib.parse import urlsplit

from fastapi import HTTPException
from fastapi.responses import FileResponse

from app.core.config import settings
from app.services import knowledge_source_references as references
from app.services.information.store import Store, iso
from app.services.knowledge_source_context import (
    connected,
    library,
    paper_snapshot,
    pending_archive,
    writable_library,
)
from app.services.knowledge_source_inbox import inbox_id
from app.services.knowledge_source_library_v3_service import library_statistics
from app.services.knowledge_source_status import (
    empty_resources,
    public_jobs,
    public_source,
    reference_document_state,
    reference_download_outcomes,
    resources,
    version_state,
)

APP = "knowledge-sources"


def require_worker() -> None:
    if not settings.KNOWLEDGE_SOURCE_WORKER_ENABLED:
        raise HTTPException(503, "知识源下载后台尚未启用")


def new_job(store: Store, actor: dict, source: dict, **values) -> dict:
    require_worker()
    if source["adapter"] != "ich" and not (
        source["adapter"] == "reference" and values.get("kind") == "import"
    ):
        raise HTTPException(400, "该来源尚未适配，不能检查或下载")
    return store.create_job(source["id"], actor["subject"], app=APP, **values)


def mutate_folder(actor: dict, body: dict) -> dict:
    catalogue = writable_library(actor)
    if inbox_id(catalogue) and body.get("folderId") == inbox_id(catalogue):
        raise HTTPException(409, "待整理是系统文件夹，不能重命名")
    return connected("folderMutation", actor["subject"], mutation=body)


def source_folder(store: Store, actor: dict, source: dict, selected: str | None = None) -> str:
    folder = selected or source.get("folderId")
    if folder and folder != "information-archive":
        catalogue = connected("catalogue", actor["subject"])
        if any(f["id"] == folder for f in catalogue.get("folders", [])):
            return folder
        if selected:
            raise HTTPException(409, "目标知识库文件夹已不存在")
    name = "ICH" if source["adapter"] == "ich" else source["name"]
    folder = connected("createFolder", actor["subject"], name=name)["id"]
    source["folderId"] = folder
    source.setdefault("archiveFolderId", folder)
    store.put("source", source)
    return folder


def build_snapshot(db, actor: dict, summary: bool = False) -> dict:
    store = Store(db, actor["tenant"])
    store.ensure_source()
    result, issue = {}, None
    try:
        result = connected("librarySummary", actor["subject"]) if summary else library(actor, store)
        if summary:
            result = library_statistics(store, actor, result)
    except HTTPException as exc:
        result = {}
        issue = str(exc.detail)
        if exc.status_code in (401, 403):
            return {
                "papers": [],
                "folders": [],
                "sources": [],
                "documents": [],
                "jobs": [],
                "changes": [],
                "resources": empty_resources(),
                "refreshedAt": iso(),
                "catalogRevision": 0,
                "canManage": False,
                "canOrganize": False,
                "canEdit": False,
                "starred": [],
                "libraryV3": False,
                "libraryTotal": 0,
                "folderCounts": {},
                "tags": [],
                "integration": {
                    "status": "error",
                    "message": issue,
                    "kbUrl": None,
                },
            }
    folders = [{**f, "writable": bool(result.get("canWrite"))} for f in result.get("folders", [])]
    sources = []
    for source in store.records("source"):
        if source.get("adapter") in {"manual", "folder"}:
            continue
        if not source.get("archiveFolderId"):
            canonical = "ICH" if source["adapter"] == "ich" else source["name"]
            match = next(
                (f for f in folders if f["name"] == canonical and f.get("kind") != "topic"), None
            )
            if match:
                source["archiveFolderId"] = match["id"]
                store.put("source", source)
        sources.append(public_source(source))
    source_folders = {s.get("archiveFolderId") for s in sources}
    for folder in folders:
        folder.setdefault("kind", "source" if folder["id"] in source_folders else "topic")
    prefs = store.preferences(actor["subject"])
    read_documents = prefs.get("knowledgeSourceRead", {})
    docs = store.documents()
    versions = store.records("version")
    jobs = public_jobs(store, actor["subject"])
    reference_outcomes = reference_download_outcomes(store.records("job"))
    source_by_id = {source["id"]: source for source in sources}
    source_scopes = {source["id"]: set(source.get("scopes", [])) for source in sources}
    for doc in docs:
        doc.pop("description", None)
        doc["isNew"] = bool(
            set(doc.get("newInScopes", [])) & source_scopes.get(doc["sourceId"], set())
        )
        doc["versions"] = [
            store.public_version(v) for v in versions if v["documentId"] == doc["id"]
        ]
        doc["versionStatus"] = version_state(doc, doc["versions"])
        reference_document_state(doc, source_by_id.get(doc["sourceId"]), reference_outcomes)
        doc["unread"] = bool(
            doc.get("firstNewAt") and doc.get("firstNewAt", "") > read_documents.get(doc["id"], "")
        )
        for version in doc["versions"]:
            version["originalUrl"] = (
                f'/api/v1/knowledge-sources/documents/{doc["id"]}/versions/{version["id"]}/original'
            )
    papers = [] if summary else paper_snapshot(store, actor, result)
    known_folders = {folder["id"] for folder in result.get("folders", [])}
    for paper in papers:
        paper["folderIds"] = [ident for ident in paper["folderIds"] if ident in known_folders]
    db.commit()
    return {
        "papers": papers,
        "folders": folders,
        "sources": sources,
        "documents": docs,
        "jobs": jobs,
        "changes": [
            {
                **e,
                "summary": (e.get("summary") or "")[:2000],
                "read": not e.get("documentId")
                or e.get("createdAt", "") <= read_documents.get(e.get("documentId"), ""),
            }
            for e in store.records("event", limit=100)
        ],
        "resources": resources(store),
        "refreshedAt": iso(),
        "catalogRevision": result.get("revision", 0),
        "canManage": actor["manage"],
        "canOrganize": bool(result.get("canWrite")),
        "canEdit": bool(result.get("canEdit") or result.get("canWrite")),
        "starred": prefs.get("knowledgeSourceStars", [])
        if summary
        else [p["id"] for p in papers if p["starred"]],
        "libraryV3": bool(summary and not issue),
        "libraryTotal": result.get("total", len(papers)),
        "folderCounts": result.get("folderCounts", {}),
        "tags": [{"id": tag, "name": tag} for tag in result.get("tagsCatalog", [])],
        "integration": {
            "status": "error" if issue else "ready",
            "message": issue or "与现有知识库共用论文和文件夹，下载与问答索引分别记录。",
            "kbUrl": result.get("url"),
        },
    }


def create_source_service(body, db, actor: dict) -> dict:
    parts = urlsplit(body.url)
    if parts.scheme != "https" or not parts.hostname or parts.username or parts.password:
        raise HTTPException(400, "请使用不含登录凭据的 HTTPS 官方网站地址")
    try:
        port = parts.port
    except ValueError as exc:
        raise HTTPException(400, "官方网站端口无效") from exc
    if port not in (None, 443):
        raise HTTPException(400, "请使用标准 HTTPS（443）官方网站地址")
    host_raw = parts.hostname.lower()
    if host_raw in {"localhost", "localhost.localdomain"} or host_raw.endswith(
        (".local", ".internal", ".localhost")
    ):
        raise HTTPException(400, "不支持添加本地或内网地址作为知识源")
    try:
        ip = ipaddress.ip_address(host_raw)
    except ValueError:
        ip = None
    if ip is not None and not ip.is_global:
        raise HTTPException(400, "不支持添加私有或内网 IP 作为知识源")
    store = Store(db, actor["tenant"])
    host = host_raw.removeprefix("www.")
    if host == "ich.org":
        source = store.ensure_source()
    else:
        if len(store.records("source")) >= 20:
            raise HTTPException(400, "搜索源数量达到上限")
        existing = next(
            (s for s in store.records("source") if urlsplit(s["url"]).hostname == parts.hostname),
            None,
        )
        source = existing or {
            "id": store.key("source", parts.hostname),
            "adapter": "unsupported",
            "status": "unsupported",
            "scopeStatus": {},
            "baselineScopes": [],
        }
    source.update(
        name=body.name.strip(),
        url=body.url,
        scopes=list(dict.fromkeys(body.scopes)),
        knowledgeSourceAutoIndex=body.auto_index,
    )
    store.put("source", source)
    source["folderId"] = source_folder(store, actor, source, body.folder_id)
    store.put("source", source)
    store.audit(actor["subject"], "knowledge_source_created", source["id"])
    db.commit()
    return {"id": source["id"]}


def change_source_service(ident: str, body, db, actor: dict) -> dict:
    store = Store(db, actor["tenant"])
    source = store.source(ident)
    changes = body.model_dump(by_alias=True, exclude_unset=True)
    if source["adapter"] == "reference" and any(
        key in changes for key in ("name", "scopes", "schedule")
    ):
        raise HTTPException(400, "参考论文分类由来源应用确定，不支持修改目录或设置定时检查")
    if any(value is None for key, value in changes.items() if key != "folderId"):
        raise HTTPException(400, "来源设置不能为空")
    if "schedule" in changes:
        schedule = body.schedule.model_dump(by_alias=True)
        changes["schedule"] = schedule
        if source["adapter"] != "ich":
            raise HTTPException(400, "该来源尚未适配，不能设置自动检查")
        if schedule["indexUpdates"] and not schedule["downloadUpdates"]:
            raise HTTPException(400, "自动索引需要同时启用下载更新")
        if schedule["frequency"] != "off":
            require_worker()
            if schedule["downloadUpdates"]:
                source_folder(store, actor, source, changes.get("folderId"))
        seconds = {"off": 0, "daily": 86400, "weekly": 604800}[schedule["frequency"]]
        schedule["nextCheckAt"] = iso(time.time() + seconds) if seconds else None
        changes["scheduleSubject"] = actor["subject"] if seconds else None
    if "autoIndex" in changes:
        source["knowledgeSourceAutoIndex"] = changes.pop("autoIndex")
    if "scopes" in changes:
        changes["scopes"] = list(dict.fromkeys(changes["scopes"]))
    if changes.get("folderId"):
        source_folder(store, actor, source, changes["folderId"])
    source.update(changes)
    store.put("source", source)
    store.audit(actor["subject"], "knowledge_source_updated", ident)
    db.commit()
    return {"saved": True}


def import_reference_service(body, db, actor: dict) -> dict:
    ref = references.saved_reference(db, {"iss": actor["issuer"], "sub": actor["subject"]}, body)
    catalogue = None
    can_download = False
    if actor["manage"]:
        try:
            catalogue = library(actor)
            can_download = bool(catalogue.get("canWrite"))
        except HTTPException:
            if body.download:
                raise
    if body.download and not can_download:
        raise HTTPException(403, "已登录账号可导入资料来源；下载和建立分类需要知识库负责人权限")
    if body.download:
        require_worker()
    store = Store(db, actor["tenant"])
    source, document, existing = references.ensure_reference(store, body, ref)
    result = {
        "sourceId": source["id"],
        "documentId": document["id"],
        "folderId": source.get("folderId"),
        "category": public_source(source)["name"],
        "alreadyImported": existing,
        "canDownload": can_download,
        "status": "imported",
    }
    versions = [v for v in store.records("version") if v["documentId"] == document["id"]]
    if versions:
        result["status"] = "saved"
    if body.download:
        active = [
            j for j in store.active_jobs() if j.get("app") == APP and j["sourceId"] == source["id"]
        ]
        same = next(
            (j for j in active if any(i.get("documentId") == document["id"] for i in j["items"])),
            None,
        )
        if same:
            result.update(jobId=same["id"], status="queued", folderId=same.get("folderId"))
        else:
            latest = versions[-1] if versions else None
            if (
                latest
                and latest.get("kbPath")
                and not any(p.get("path") == latest["kbPath"] for p in catalogue.get("papers", []))
            ):
                proof = library(
                    actor, imports=[{"documentId": document["id"], "sha256": latest["sha256"]}]
                )
                if not pending_archive(latest, proof):
                    raise HTTPException(409, "原知识库论文已删除或不可访问，不会自动重新收录")
            if (
                not latest
                or latest.get("parseStatus") != "ready"
                or latest.get("indexStatus") != "ready"
            ):
                if active:
                    raise HTTPException(
                        409, "此参考论文分类已有未完成下载，请在知识源完成或取消后重试"
                    )
                folder = source_folder(store, actor, source)
                job = new_job(
                    store,
                    actor,
                    source,
                    kind="import",
                    document_ids=[document["id"]],
                    folder_id=folder,
                    parse=True,
                )
                job["displayFolderId"] = folder
                if latest:
                    job["items"][0].update(
                        versionId=latest["id"], phase="resume_saved", result="reused"
                    )
                store.put("job", job)
                result.update(jobId=job["id"], folderId=folder, status="queued")
    store.audit(
        actor["subject"],
        "reference_download" if body.download else "reference_import",
        document["id"],
    )
    db.commit()
    return result


def create_job_service(body, db, actor: dict) -> dict:
    store = Store(db, actor["tenant"])
    source = store.source(body.source_id)
    ids = list(dict.fromkeys(body.document_ids))
    catalogue = writable_library(actor, store) if source["adapter"] == "reference" else None
    for ident in ids:
        if store.get("document", ident)["sourceId"] != source["id"]:
            raise HTTPException(400, "清单包含不属于该来源的资料")
    require_worker()
    if source["adapter"] == "reference":
        existing = next(
            (
                j
                for j in store.active_jobs()
                if j.get("app") == APP
                and j["sourceId"] == source["id"]
                and set(ids) <= {i.get("documentId") for i in j["items"]}
            ),
            None,
        )
        if existing:
            return {"id": existing["id"]}
    retained = {}
    if catalogue is not None:
        for version in store.records("version"):
            if version["documentId"] in ids:
                retained[version["documentId"]] = version
        for version in retained.values():
            if (
                version.get("kbPath")
                and not any(p.get("path") == version["kbPath"] for p in catalogue.get("papers", []))
                and not pending_archive(version, catalogue)
            ):
                raise HTTPException(409, "原知识库论文已删除或不可访问，不会自动重新收录")
    folder = source_folder(store, actor, source, body.folder_id)
    job = new_job(
        store, actor, source, kind="import", document_ids=ids, folder_id=folder, parse=body.parse
    )
    job["displayFolderId"] = folder
    for item in job["items"]:
        if version := retained.get(item["documentId"]):
            item.update(versionId=version["id"], phase="resume_saved", result="reused")
    store.put("job", job)
    db.commit()
    return {"id": job["id"]}


def retry_document_service(ident: str, db, actor: dict) -> dict:
    store = Store(db, actor["tenant"])
    doc = store.document(ident)
    source = store.source(doc["sourceId"])
    if source["adapter"] == "reference":
        writable_library(actor, store)
    versions = doc["versions"]
    if versions and versions[-1].get("kbPath"):
        latest = versions[-1]
        catalogue = library(
            actor,
            imports=[
                {
                    "documentId": latest.get("kbDocumentId", ident),
                    "sha256": latest["sha256"],
                }
            ],
        )
        active = any(p.get("path") == latest["kbPath"] for p in catalogue.get("papers", []))
        if not active and not pending_archive(latest, catalogue):
            raise HTTPException(409, "对应知识库论文已删除，不能通过重试恢复")
    require_worker()
    target = source_folder(store, actor, source)
    job = new_job(
        store, actor, source, kind="import", document_ids=[ident], folder_id=target, parse=True
    )
    if versions:
        job["items"][0].update(versionId=versions[-1]["id"], phase="resume_saved", result="reused")
        store.put("job", job)
    db.commit()
    return {"id": job["id"]}


def original_file_response(document_id: str, version_id: str, db, actor: dict) -> FileResponse:
    store = Store(db, actor["tenant"])
    document = store.get("document", document_id)
    version = store.get("version", version_id)
    if version["documentId"] != document_id:
        raise HTTPException(404, "原文版本不存在")
    source = store.get("source", document["sourceId"])
    if not version.get("kbPath"):
        if source.get("adapter") == "folder":
            connected("librarySummary", actor["subject"])
        else:
            library(actor, imports=[])
    if version.get("kbPath"):
        catalogue = library(
            actor,
            imports=[
                {
                    "documentId": version.get("kbDocumentId", document_id),
                    "sha256": version["sha256"],
                }
            ],
        )
        active = any(p.get("path") == version["kbPath"] for p in catalogue.get("papers", []))
        if not active and not pending_archive(version, catalogue):
            raise HTTPException(404, "知识库论文已删除或无权访问")
    path = store.archive_path(version)
    if not path.is_file():
        raise HTTPException(410, "归档原件暂不可读，请联系管理员恢复")
    return FileResponse(
        path,
        media_type="application/pdf",
        filename=document.get("originalFilename")
        or f'{"Paper" if document.get("originApp") else "ICH"}-{version["sha256"][:12]}.pdf',
        content_disposition_type="inline",
        headers={
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "sandbox",
            "Cache-Control": "private, no-store",
        },
    )
