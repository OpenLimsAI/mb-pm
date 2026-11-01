# ruff: noqa: B008
"""Knowledge-source library manager. Original information application remains retired."""

from typing import Literal
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.api.deps import require_same_origin
from app.api.v1.portal import session_claims
from app.core.config import settings
from app.db.session import get_db
from app.services import password_policy
from app.services.iam_admin import IAMError
from app.services.information import bridge
from app.services.information.store import Store, tenant_key
from app.services.information.worker import active_account, can_manage

router = APIRouter(prefix="/knowledge-sources", tags=["knowledge-sources"])
APP = "knowledge-sources"


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class FolderInput(Input):
    name: str = Field(min_length=1, max_length=60)
    revision: int = Field(ge=0)


class FolderChange(Input):
    paper_ids: list[str] = Field(alias="paperIds", min_length=1, max_length=500)
    folder_ids: list[str] = Field(alias="folderIds", max_length=30)
    mode: Literal["add", "move", "remove"]
    from_folder_id: str | None = Field(None, alias="fromFolderId", max_length=100)
    revision: int = Field(ge=0)


class SourceInput(Input):
    name: str = Field(min_length=1, max_length=60)
    url: str = Field(min_length=8, max_length=2048)
    scopes: list[Literal["Q", "S", "E", "M"]] = Field(
        default=["Q", "S", "E", "M"], min_length=1, max_length=4
    )
    folder_id: str | None = Field(None, alias="folderId", max_length=100)
    auto_index: bool = Field(True, alias="autoIndex")
    enabled: Literal[False] = False


class SourceChange(Input):
    name: str | None = Field(None, min_length=1, max_length=60)
    scopes: list[Literal["Q", "S", "E", "M"]] | None = Field(None, min_length=1, max_length=4)
    folder_id: str | None = Field(None, alias="folderId", max_length=100)
    auto_index: bool | None = Field(None, alias="autoIndex")


class JobInput(Input):
    source_id: str = Field(alias="sourceId", min_length=1, max_length=64)
    document_ids: list[str] = Field(alias="documentIds", min_length=1, max_length=1500)
    folder_id: str | None = Field(None, alias="folderId", max_length=100)
    parse: bool = True


class JobAction(Input):
    action: Literal["pause", "resume", "retry", "cancel"]


class StarInput(Input):
    paper_id: str = Field(alias="paperId", min_length=1, max_length=1100)
    enabled: bool


def principal(request: Request, db: Session = Depends(get_db)):
    claims = session_claims(request, db)
    password_policy.enforce(db, claims["sub"], request.url.path)
    if not settings.KNOWLEDGE_SOURCE_APP_ENABLED:
        raise HTTPException(410, "知识源暂未启用")
    try:
        account = active_account(claims["sub"])
    except IAMError as exc:
        raise HTTPException(503, "暂时无法确认 IAM 身份，请稍后重试") from exc
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        require_same_origin(request, origin=settings.portal_origin)
    return {
        "subject": claims["sub"],
        "tenant": tenant_key(claims["iss"], claims["owner"]),
        "manage": can_manage(account),
    }


def manager(actor: dict = Depends(principal)):
    if not actor["manage"]:
        raise HTTPException(403, "仅系统管理员或知识库负责人可配置来源和下载任务")
    return actor


def connected(operation, subject, **values):
    try:
        return bridge.call(operation, subject, **values)
    except bridge.BridgeError as exc:
        status = exc.status if exc.status in (400, 401, 403, 404, 409, 422) else 503
        raise HTTPException(status, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(503, str(exc)) from exc


def library(actor, store=None, imports=None):
    # Core registers a package only after ingest. Ask the authenticated BFF to prove
    # unindexed imports from its own durable receipts, never infer access from a path.
    if imports is None:
        imports = [
            {"documentId": v["documentId"], "sha256": v["sha256"]}
            for v in (store.records("version") if store else [])
            if v.get("kbPath") and v.get("indexStatus") != "ready"
        ]
    chunks = [imports[i : i + 5000] for i in range(0, len(imports), 5000)] or [[]]
    proofs = []
    for chunk in chunks:
        result = connected("library", actor["subject"], imports=chunk)
        proofs.extend(result.get("pendingArchives", []))
    return {**result, "pendingArchives": proofs}


def pending_archive(version, catalogue):
    if version.get("indexStatus") == "ready":
        return None
    return next(
        (
            proof
            for proof in catalogue.get("pendingArchives", [])
            if proof.get("documentId") == version["documentId"]
            and proof.get("sha256") == version["sha256"]
            and proof.get("path") == version.get("kbPath")
            and proof.get("indexStatus") in ("not_requested", "pending", "failed")
        ),
        None,
    )


def classifications(store, document):
    return store.get("ks_classification", store.key("ks_classification", document), required=False)


def paper_snapshot(store, actor, result):
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
            paper.update(archive_paper(store, doc, version, source), id=path, folderIds=folders)
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
        paper = archive_paper(store, doc, version, sources.get(doc["sourceId"]))
        if proof:
            paper["kbUrl"] = None
            paper["indexStatus"] = proof["indexStatus"]
        papers.append(paper)
    prefs = store.preferences(actor["subject"])
    stars = prefs.get("knowledgeSourceStars", [])
    for paper in papers:
        alias = "archive:" + paper["versionId"] if paper.get("versionId") else None
        paper["starred"] = paper["id"] in stars or alias in stars
    return papers


def archive_paper(store, doc, version, source):
    classification = classifications(store, doc["id"])
    return {
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
        "originalUrl": f'/api/v1/knowledge-sources/documents/{doc["id"]}/versions/{version["id"]}/original',
        "kbUrl": version.get("kbUrl"),
        "type": doc.get("documentType", "官方资料"),
        "language": doc.get("language", "来源未标注"),
        "error": version.get("error") or (classification.get("error") if classification else None),
    }


@router.get("/snapshot")
def snapshot(db: Session = Depends(get_db), actor: dict = Depends(principal)):
    store = Store(db, actor["tenant"])
    store.ensure_source()
    result, issue = {}, None
    try:
        result = library(actor, store)
    except HTTPException as exc:
        issue = str(exc.detail)
    folders = [{**f, "writable": bool(result.get("canWrite"))} for f in result.get("folders", [])]
    sources = []
    for source in store.records("source"):
        sources.append(
            {
                **{k: v for k, v in source.items() if k != "managerSubject"},
                "enabled": False,
                "autoIndex": source.get("knowledgeSourceAutoIndex", True),
            }
        )
    docs = store.documents()
    versions = store.records("version")
    for doc in docs:
        doc.pop("description", None)
        doc["versions"] = [
            store.public_version(v) for v in versions if v["documentId"] == doc["id"]
        ]
    jobs = [
        {k: v for k, v in j.items() if k != "actorSubject"}
        for j in store.records("job")
        if j.get("app") == APP
    ]
    papers = paper_snapshot(store, actor, result)
    known_folders = {folder["id"] for folder in result.get("folders", [])}
    for paper in papers:
        paper["folderIds"] = [ident for ident in paper["folderIds"] if ident in known_folders]
    db.commit()
    return {
        "papers": papers,
        "folders": folders,
        "sources": sources,
        "documents": docs,
        "jobs": jobs[-100:],
        "catalogRevision": result.get("revision", 0),
        "canManage": actor["manage"],
        "canOrganize": bool(result.get("canWrite")),
        "starred": [p["id"] for p in papers if p["starred"]],
        "integration": {
            "status": "error" if issue else "ready",
            "message": issue or "与现有知识库共用论文和文件夹，下载与问答索引分别记录。",
            "kbUrl": result.get("url"),
        },
    }


def writable_library(actor, store=None):
    result = library(actor, store)
    if not result.get("canWrite"):
        raise HTTPException(403, "当前知识库角色没有文件夹整理权限")
    return result


def mutate_folder(actor, body):
    writable_library(actor)
    return connected("folderMutation", actor["subject"], mutation=body)


@router.post("/folders", status_code=201)
def create_folder(body: FolderInput, actor: dict = Depends(principal)):
    return mutate_folder(
        actor, {"operation": "create", "name": body.name, "revision": body.revision}
    )


@router.patch("/folders/{ident}")
def rename_folder(ident: str, body: FolderInput, actor: dict = Depends(principal)):
    return mutate_folder(
        actor,
        {"operation": "rename", "folderId": ident, "name": body.name, "revision": body.revision},
    )


@router.post("/papers/folders")
def organize(body: FolderChange, db: Session = Depends(get_db), actor: dict = Depends(principal)):
    store = Store(db, actor["tenant"])
    result = writable_library(actor, store)
    if result.get("revision") != body.revision:
        raise HTTPException(409, "文件夹已更新，请刷新后重试")
    folder_ids = list(dict.fromkeys(body.folder_ids))
    if body.mode == "remove" and not folder_ids and body.from_folder_id:
        folder_ids = [body.from_folder_id]
    if not folder_ids:
        raise HTTPException(400, "请选择文件夹")
    known_folders = {f["id"] for f in result.get("folders", [])}
    if not set(folder_ids) <= known_folders:
        raise HTTPException(409, "目标文件夹已不存在，请刷新后重试")
    if body.mode == "move" and body.from_folder_id not in known_folders:
        raise HTTPException(400, "移动须指定有效的当前文件夹")
    available = {p["id"]: p for p in paper_snapshot(store, actor, result)}
    ids = list(dict.fromkeys(body.paper_ids))
    if not all(ident in available for ident in ids):
        raise HTTPException(404, "部分论文已删除或无权访问，请刷新后重试")
    paths = [ident for ident in ids if not ident.startswith("archive:")]
    if paths:
        mutation = {
            "operation": body.mode,
            "revision": body.revision,
            "paths": paths,
            "folderIds": folder_ids,
        }
        if body.mode == "move" and body.from_folder_id:
            mutation["fromFolderId"] = body.from_folder_id
        connected("folderMutation", actor["subject"], mutation=mutation)
    for ident in ids:
        if not ident.startswith("archive:"):
            continue
        paper = available[ident]
        doc_id = paper["documentId"]
        doc = store.lock("document", doc_id)
        current = classifications(store, doc_id)
        memberships = set(current["folderIds"] if current else doc.get("folderIds", []))
        removed = set(current.get("removedFolderIds", []) if current else [])
        if body.mode == "move":
            memberships.discard(body.from_folder_id)
            removed.add(body.from_folder_id)
        if body.mode == "remove":
            memberships -= set(folder_ids)
            removed |= set(folder_ids)
        else:
            memberships |= set(folder_ids)
            removed -= set(folder_ids)
        store.put(
            "ks_classification",
            {
                "id": store.key("ks_classification", doc_id),
                "documentId": doc_id,
                "folderIds": sorted(memberships),
                "removedFolderIds": sorted(removed),
            },
        )
    store.audit(actor["subject"], "knowledge_source_organized", str(len(ids)))
    db.commit()
    return {"saved": True}


@router.post("/stars")
def star(body: StarInput, db: Session = Depends(get_db), actor: dict = Depends(principal)):
    store = Store(db, actor["tenant"])
    result = library(actor, store)
    available = {p["id"]: p for p in paper_snapshot(store, actor, result)}
    if body.paper_id not in available:
        raise HTTPException(404, "论文不存在或无权访问")
    prefs = store.preferences(actor["subject"])
    stars = set(prefs.get("knowledgeSourceStars", []))
    paper = available[body.paper_id]
    if paper.get("versionId"):
        stars.discard("archive:" + paper["versionId"])
    stars.add(body.paper_id) if body.enabled else stars.discard(body.paper_id)
    if len(stars) > 5000:
        raise HTTPException(400, "收藏数量已达到上限")
    store.save_preferences(actor["subject"], {"knowledgeSourceStars": sorted(stars)})
    db.commit()
    return {"saved": True}


def source_folder(store, actor, source, selected=None):
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
    store.put("source", source)
    return folder


@router.post("/sources", status_code=201)
def create_source(body: SourceInput, db: Session = Depends(get_db), actor: dict = Depends(manager)):
    parts = urlsplit(body.url)
    if parts.scheme != "https" or not parts.hostname or parts.username or parts.password:
        raise HTTPException(400, "请使用不含登录凭据的 HTTPS 官方网站地址")
    store = Store(db, actor["tenant"])
    host = parts.hostname.lower().removeprefix("www.")
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


@router.patch("/sources/{ident}")
def change_source(
    ident: str, body: SourceChange, db: Session = Depends(get_db), actor: dict = Depends(manager)
):
    store = Store(db, actor["tenant"])
    source = store.source(ident)
    changes = body.model_dump(by_alias=True, exclude_unset=True)
    if any(value is None for key, value in changes.items() if key != "folderId"):
        raise HTTPException(400, "来源设置不能为空")
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


def require_worker():
    if not settings.KNOWLEDGE_SOURCE_WORKER_ENABLED:
        raise HTTPException(503, "知识源下载后台尚未启用")


def new_job(store, actor, source, **values):
    require_worker()
    if source["adapter"] != "ich":
        raise HTTPException(400, "该来源尚未适配，不能检查或下载")
    return store.create_job(source["id"], actor["subject"], app=APP, **values)


@router.post("/sources/{ident}/check", status_code=202)
def check_source(ident: str, db: Session = Depends(get_db), actor: dict = Depends(manager)):
    store = Store(db, actor["tenant"])
    source = store.source(ident)
    job = new_job(store, actor, source, kind="check")
    db.commit()
    return {"id": job["id"]}


@router.post("/jobs", status_code=202)
def create_job(body: JobInput, db: Session = Depends(get_db), actor: dict = Depends(manager)):
    store = Store(db, actor["tenant"])
    source = store.source(body.source_id)
    ids = list(dict.fromkeys(body.document_ids))
    for ident in ids:
        if store.get("document", ident)["sourceId"] != source["id"]:
            raise HTTPException(400, "清单包含不属于该来源的资料")
    require_worker()
    folder = source_folder(store, actor, source, body.folder_id)
    job = new_job(
        store, actor, source, kind="import", document_ids=ids, folder_id=folder, parse=body.parse
    )
    job["displayFolderId"] = folder
    store.put("job", job)
    db.commit()
    return {"id": job["id"]}


@router.post("/jobs/{ident}/control")
def control_job(
    ident: str, body: JobAction, db: Session = Depends(get_db), actor: dict = Depends(manager)
):
    store = Store(db, actor["tenant"])
    job = store.get("job", ident)
    if job.get("app") != APP:
        raise HTTPException(404, "知识源任务不存在，旧采集任务仍保持停用")
    if body.action in ("resume", "retry"):
        require_worker()
    job = store.control_job(ident, body.action)
    if body.action in ("resume", "retry"):
        job["actorSubject"] = actor["subject"]
        store.put("job", job)
    db.commit()
    return {"saved": True}


@router.post("/documents/{ident}/retry", status_code=202)
def retry_document(ident: str, db: Session = Depends(get_db), actor: dict = Depends(manager)):
    store = Store(db, actor["tenant"])
    doc = store.document(ident)
    source = store.source(doc["sourceId"])
    require_worker()
    target = source_folder(store, actor, source)
    job = new_job(
        store, actor, source, kind="import", document_ids=[ident], folder_id=target, parse=True
    )
    db.commit()
    return {"id": job["id"]}


@router.get("/documents/{document_id}/versions/{version_id}/original")
def original(
    document_id: str,
    version_id: str,
    db: Session = Depends(get_db),
    actor: dict = Depends(principal),
):
    store = Store(db, actor["tenant"])
    store.get("document", document_id)
    version = store.get("version", version_id)
    if version["documentId"] != document_id:
        raise HTTPException(404, "原文版本不存在")
    if version.get("kbPath"):
        catalogue = library(
            actor, imports=[{"documentId": document_id, "sha256": version["sha256"]}]
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
        filename=f'ICH-{version["sha256"][:12]}.pdf',
        content_disposition_type="inline",
        headers={
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "sandbox",
            "Cache-Control": "private, no-store",
        },
    )
