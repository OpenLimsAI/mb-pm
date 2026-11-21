# ruff: noqa: B008
"""Knowledge-source library manager router. Original information application remains retired."""

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.api.deps import require_same_origin
from app.api.v1.portal import session_claims
from app.core.config import settings
from app.db.session import get_db
from app.services import password_policy
from app.services.iam_admin import IAMError
from app.services.information.store import Store, iso, tenant_key
from app.services.information.worker import active_account, can_access_knowledge, can_manage
from app.services.knowledge_source_context import (
    archive_paper,
    classifications,
    connected,
    library,
    paper_snapshot,
    pending_archive,
    writable_library,
)
from app.services.knowledge_source_folders import folder_action, organize_papers, undo_organization
from app.services.knowledge_source_sources_service import (
    APP,
    build_snapshot,
    change_source_service,
    create_job_service,
    create_source_service,
    import_reference_service,
    mutate_folder,
    new_job,
    original_file_response,
    require_worker,
    retry_document_service,
    source_folder,
)
from app.services.knowledge_source_status import job_revision, public_jobs

__all__ = [
    "APP",
    "Input",
    "archive_paper",
    "classifications",
    "connected",
    "library",
    "manager",
    "mutate_folder",
    "new_job",
    "paper_snapshot",
    "pending_archive",
    "principal",
    "require_worker",
    "router",
    "source_folder",
    "writable_library",
]

router = APIRouter(prefix="/knowledge-sources", tags=["knowledge-sources"])


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


class FolderActionInput(Input):
    action: Literal["delete", "merge", "metadata"]
    revision: int = Field(ge=0)
    target_folder_id: str | None = Field(None, alias="targetFolderId", max_length=100)
    kind: Literal["source", "topic"] | None = None
    parent_id: str | None = Field(None, alias="parentId", max_length=100)


class UndoInput(Input):
    token: str = Field(min_length=1, max_length=100)
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


class ScheduleInput(Input):
    frequency: Literal["off", "daily", "weekly"] = "off"
    download_updates: bool = Field(False, alias="downloadUpdates")
    index_updates: bool = Field(False, alias="indexUpdates")


class SourceChange(Input):
    schedule: ScheduleInput | None = None
    name: str | None = Field(None, min_length=1, max_length=60)
    scopes: list[Literal["Q", "S", "E", "M"]] | None = Field(None, min_length=1, max_length=4)
    folder_id: str | None = Field(None, alias="folderId", max_length=100)
    auto_index: bool | None = Field(None, alias="autoIndex")


class ReadInput(Input):
    document_ids: list[str] = Field(alias="documentIds", min_length=1, max_length=1500)


class VerifyInput(Input):
    document_ids: list[str] | None = Field(None, alias="documentIds", max_length=1500)


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


class ReferenceInput(Input):
    origin_app: Literal["solutions", "assistant"] = Field(alias="originApp")
    origin_id: str = Field(alias="originId", min_length=1, max_length=64)
    answer_id: str = Field(alias="answerId", min_length=1, max_length=64)
    reference_id: str = Field(alias="referenceId", min_length=1, max_length=100)
    download: bool = False


def principal(request: Request, db: Session = Depends(get_db)):
    claims = session_claims(request, db)
    password_policy.enforce(db, claims["sub"], request.url.path)
    if not settings.KNOWLEDGE_SOURCE_APP_ENABLED:
        raise HTTPException(410, "知识源暂未启用")
    try:
        account = active_account(claims["sub"])
    except IAMError as exc:
        raise HTTPException(503, "暂时无法确认 IAM 身份，请稍后重试") from exc
    if not can_access_knowledge(account):
        raise HTTPException(403, "当前账号没有知识源访问权限，请联系管理员分配知识库角色")
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        require_same_origin(request, origin=settings.portal_origin)
    return {
        "subject": claims["sub"],
        "issuer": claims["iss"],
        "tenant": tenant_key(claims["iss"], claims["owner"]),
        "manage": can_manage(account),
    }


def manager(actor: dict = Depends(principal)):
    if not actor["manage"]:
        raise HTTPException(403, "仅系统管理员或知识库负责人可配置来源和下载任务")
    return actor


@router.get("/snapshot")
def snapshot(
    db: Session = Depends(get_db), actor: dict = Depends(principal), summary: bool = False
):
    return build_snapshot(db, actor, summary=summary)


@router.post("/folders", status_code=201)
def create_folder(body: FolderInput, actor: dict = Depends(principal)):
    return mutate_folder(
        actor, {"operation": "create", "name": body.name, "revision": body.revision}
    )


@router.post("/folders/inbox")
def ensure_inbox_folder(actor: dict = Depends(principal)):
    return connected("ensureInboxFolder", actor["subject"])


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
    return organize_papers(
        store,
        actor,
        body.model_dump(by_alias=True),
        catalogue=result,
        connect=connected,
        papers=paper_snapshot(store, actor, result),
    )


@router.post("/folders/{ident}/actions")
def folder_actions(
    ident: str,
    body: FolderActionInput,
    db: Session = Depends(get_db),
    actor: dict = Depends(principal),
):
    store = Store(db, actor["tenant"])
    result = writable_library(actor, store)
    return folder_action(
        store,
        actor,
        ident,
        body.model_dump(by_alias=True, exclude_unset=True),
        catalogue=result,
        connect=connected,
    )


@router.post("/papers/folders/undo")
def undo_folders(body: UndoInput, db: Session = Depends(get_db), actor: dict = Depends(principal)):
    store = Store(db, actor["tenant"])
    result = writable_library(actor, store)
    return undo_organization(
        store,
        actor,
        body.model_dump(),
        catalogue=result,
        connect=connected,
        papers=paper_snapshot(store, actor, result),
    )


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


@router.post("/sources", status_code=201)
def create_source(body: SourceInput, db: Session = Depends(get_db), actor: dict = Depends(manager)):
    return create_source_service(body, db, actor)


@router.patch("/sources/{ident}")
def change_source(
    ident: str, body: SourceChange, db: Session = Depends(get_db), actor: dict = Depends(manager)
):
    return change_source_service(ident, body, db, actor)


@router.post("/references", status_code=201)
def import_reference(
    body: ReferenceInput, db: Session = Depends(get_db), actor: dict = Depends(principal)
):
    return import_reference_service(body, db, actor)


@router.post("/sources/{ident}/check", status_code=202)
def check_source(ident: str, db: Session = Depends(get_db), actor: dict = Depends(manager)):
    store = Store(db, actor["tenant"])
    source = store.source(ident)
    job = new_job(store, actor, source, kind="check")
    db.commit()
    return {"id": job["id"]}


@router.post("/jobs", status_code=202)
def create_job(body: JobInput, db: Session = Depends(get_db), actor: dict = Depends(manager)):
    return create_job_service(body, db, actor)


@router.post("/jobs/{ident}/control")
def control_job(
    ident: str, body: JobAction, db: Session = Depends(get_db), actor: dict = Depends(manager)
):
    store = Store(db, actor["tenant"])
    job = store.get("job", ident)
    if job.get("app") != APP:
        raise HTTPException(404, "知识源任务不存在，旧采集任务仍保持停用")
    if job.get("kind") == "manual-index":
        raise HTTPException(
            409, "知识库级索引不能通过下载控制停止或重试，请回到资料详情确认真实任务状态"
        )
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
    return retry_document_service(ident, db, actor)


@router.get("/jobs/status")
def job_status(db: Session = Depends(get_db), actor: dict = Depends(principal)):
    jobs = public_jobs(Store(db, actor["tenant"]), actor["subject"])
    return {"jobs": jobs, "revision": job_revision(jobs), "refreshedAt": iso()}


@router.post("/changes/read")
def mark_read(body: ReadInput, db: Session = Depends(get_db), actor: dict = Depends(principal)):
    store = Store(db, actor["tenant"])
    prefs = store.preferences(actor["subject"])
    read = prefs.get("knowledgeSourceRead", {})
    for ident in set(body.document_ids):
        store.get("document", ident)
        read[ident] = iso()
    store.save_preferences(actor["subject"], {"knowledgeSourceRead": read})
    db.commit()
    return {"saved": True}


@router.post("/sources/{ident}/verify", status_code=202)
def verify_source(
    ident: str, body: VerifyInput, db: Session = Depends(get_db), actor: dict = Depends(manager)
):
    store = Store(db, actor["tenant"])
    source = store.source(ident)
    available = {
        d["id"]
        for d in store.documents()
        if d["sourceId"] == ident and set(d["scopes"]) & set(source["scopes"])
    }
    saved_ids = {v["documentId"] for v in store.records("version")}
    ids = (
        list(dict.fromkeys(body.document_ids))
        if body.document_ids is not None
        else sorted(available & saved_ids)
    )
    if not ids or not set(ids) <= available & saved_ids:
        raise HTTPException(400, "请选择本来源已保存的资料进行版本核验")
    job = new_job(store, actor, source, kind="verify", document_ids=ids)
    db.commit()
    return {"id": job["id"]}


@router.get("/documents/{document_id}/versions/{version_id}/original")
def original(
    document_id: str,
    version_id: str,
    db: Session = Depends(get_db),
    actor: dict = Depends(principal),
):
    return original_file_response(document_id, version_id, db, actor)
