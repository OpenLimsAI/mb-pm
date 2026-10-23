"""Portal-authenticated real information application. No preview identity is accepted."""

import time
from datetime import UTC, datetime
from typing import Annotated, Literal
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Query, Request
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

router = APIRouter(prefix="/information", tags=["information"])
ARCHIVE = "information-archive"


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class SourceCreate(Input):
    name: str = Field(min_length=1, max_length=150)
    url: str = Field(min_length=8, max_length=2048)
    scopes: list[Literal["Q", "S", "E", "M"]] = Field(
        default=["Q", "S", "E", "M"], min_length=1, max_length=4
    )
    folder_id: str | None = Field(None, alias="folderId", max_length=100)
    frequency: Literal["daily", "weekly"] = "daily"
    enabled: bool = False


class SourceChange(Input):
    scopes: list[Literal["Q", "S", "E", "M"]] | None = Field(None, min_length=1, max_length=4)
    folder_id: str | None = Field(None, alias="folderId", max_length=100)
    frequency: Literal["daily", "weekly"] | None = None
    enabled: bool | None = None


class JobCreate(Input):
    source_id: str = Field(alias="sourceId", min_length=1, max_length=64)
    document_ids: list[str] = Field(alias="documentIds", min_length=1, max_length=1500)
    folder_id: str = Field(alias="folderId", min_length=1, max_length=100)
    parse: bool = False
    new_folder: str | None = Field(None, alias="newFolder", min_length=1, max_length=60)


class Action(Input):
    action: Literal["pause", "resume", "retry", "cancel"]


class Switch(Input):
    enabled: bool


class Read(Input):
    read: bool


class Preferences(Input):
    note: str | None = Field(None, max_length=800)
    digest: Literal["每日汇总", "即时提醒", "暂停提醒"] | None = None
    minor: bool | None = None


def principal(request: Request, db: Annotated[Session, Depends(get_db)]):
    claims = session_claims(request, db)
    password_policy.enforce(db, claims["sub"], request.url.path)
    try:
        account = active_account(claims["sub"])
    except IAMError as exc:
        raise HTTPException(503, "暂时无法确认 IAM 身份，请稍后重试") from exc
    # The signed issuer/org partition is independent of mutable login names.
    return {
        "subject": claims["sub"],
        "tenant": tenant_key(claims["iss"], claims["owner"]),
        "manage": can_manage(account),
        "claims": claims,
        "name": account.get("displayName") or account["name"],
        "username": account["name"],
    }


def writer(request: Request, actor: Annotated[dict, Depends(principal)]):
    require_same_origin(request, origin=settings.portal_origin)
    return actor


def manager(actor: Annotated[dict, Depends(writer)]):
    if not actor["manage"]:
        raise HTTPException(403, "仅系统管理员或知识库负责人可管理信息源和采集任务")
    return actor


def folders(store, actor):
    catalogue = [
        {
            "id": ARCHIVE,
            "name": "信息获取原文归档",
            "url": "/information/library?folder=" + ARCHIVE,
            "writable": actor["manage"],
        }
    ]
    status = {
        "status": "archive_only",
        "message": "原文可真实归档及检索；知识库连接未配置时不会显示为已入库。",
        "kbUrl": settings.KNOWLEDGE_PUBLIC_URL
        if hasattr(settings, "KNOWLEDGE_PUBLIC_URL")
        else "https://kb.openlims.ai",
    }
    cached = store.records("folder")
    if actor["manage"] and settings.INFORMATION_KB_URL and settings.INFORMATION_KB_SECRET:
        try:
            result = bridge.call("catalogue", actor["subject"])
            for folder in result.get("folders", []):
                store.put(
                    "folder",
                    {
                        "id": store.key("folder", folder["id"]),
                        "folderId": folder["id"],
                        "name": folder["name"],
                        "url": result.get("url", "https://kb.openlims.ai"),
                    },
                )
            store.db.commit()
            cached = store.records("folder")
            available = {f["id"] for f in result.get("folders", [])}
            cached = [f for f in cached if f["folderId"] in available]
            status = {
                "status": "ready",
                "message": "已连接知识库，原文归档、正文解析和知识库索引分别核对。",
                "kbUrl": result.get("url", "https://kb.openlims.ai"),
            }
        except ValueError as exc:
            status.update(status="unavailable", message=str(exc))
    if not actor["manage"]:
        used = {source.get("folderId") for source in store.records("source")}
        used.update(folder for doc in store.documents() for folder in doc.get("folderIds", []))
        cached = [folder for folder in cached if folder["folderId"] in used]
        if settings.INFORMATION_KB_URL and settings.INFORMATION_KB_SECRET:
            status.update(
                status="configured",
                message="可浏览团队资料；知识库权限独立核对，实际索引结果以各资料状态为准。",
            )
    catalogue += [
        {
            "id": f["folderId"],
            "name": f["name"],
            "url": f["url"],
            "writable": actor["manage"] and status["status"] == "ready",
        }
        for f in cached
    ]
    return catalogue, status


@router.get("/snapshot")
def snapshot(
    request: Request,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[dict, Depends(principal)],
):
    store = Store(db, actor["tenant"])
    store.ensure_source()
    db.commit()
    targets, integration = folders(store, actor)
    prefs = store.preferences(actor["subject"])
    docs = store.documents()
    versions = store.records("version")
    for doc in docs:
        doc.pop("description", None)
        doc["versions"] = [
            store.public_version(v) for v in versions if v["documentId"] == doc["id"]
        ]
    events = store.records("event", limit=500)
    start_today = datetime.now(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
    for event in events:
        doc = next((d for d in docs if d["id"] == event.get("documentId")), None)
        matches = f'source:{event["sourceId"]}' in prefs["follows"] or (
            doc
            and (
                f'document:{doc["id"]}' in prefs["follows"]
                or any(f"scope:{s}" in prefs["follows"] for s in doc["scopes"])
            )
        )
        due = prefs["digest"] == "即时提醒" or (
            prefs["digest"] == "每日汇总"
            and datetime.fromisoformat(event["createdAt"]) < start_today
        )
        event["read"] = (
            event["id"] in prefs["read"]
            or not matches
            or not due
            or (event.get("minor") and not prefs["minor"])
        )
    jobs = store.records("job", limit=100)
    jobs = list({j["id"]: j for j in jobs + store.active_jobs()}.values())
    public_jobs = [
        {
            **{k: v for k, v in j.items() if k != "actorSubject"},
            "folderId": j.get("displayFolderId") or j.get("folderId") or ARCHIVE,
        }
        for j in jobs
        if j["kind"] == "import"
    ]
    runs = [
        {
            "id": j["id"],
            "sourceId": j["sourceId"],
            "kind": j["kind"],
            "status": j["status"],
            "startedAt": j["createdAt"],
            "finishedAt": j.get("finishedAt"),
            "error": j.get("error"),
            "details": {"jobId": j["id"], "scopeStatus": j.get("scopeStatus")},
        }
        for j in jobs
    ]
    return {
        "user": {
            "id": actor["subject"],
            "username": actor["username"],
            "displayName": actor["name"],
        },
        "canManage": actor["manage"],
        "sources": [
            {k: v for k, v in source.items() if k != "managerSubject"}
            for source in store.records("source")
        ],
        "documents": docs,
        "events": list(reversed(events)),
        "jobs": public_jobs,
        "runs": runs,
        "folders": targets,
        "follows": prefs["follows"],
        "later": prefs["later"],
        "note": prefs["note"],
        "digest": prefs["digest"],
        "minor": prefs["minor"],
        "integration": integration,
        "cost": {
            "modelCalls": 0,
            "message": "目录检查、下载和本地 PDF 提取不调用大模型；知识库嵌入与问答用量在知识库查看。",
        },
        "workerEnabled": settings.INFORMATION_WORKER_ENABLED,
    }


@router.post("/sources", status_code=201)
def create_source(
    body: SourceCreate,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[dict, Depends(manager)],
):
    store = Store(db, actor["tenant"])
    parsed = urlsplit(body.url)
    if (
        parsed.scheme not in ("http", "https")
        or not parsed.hostname
        or parsed.username
        or parsed.password
    ):
        raise HTTPException(400, "来源网址必须是有效的 HTTP(S) 地址")
    if parsed.hostname in {"www.ich.org", "ich.org", "admin.ich.org", "database.ich.org"}:
        if any(s["adapter"] == "ich" for s in store.records("source")):
            raise HTTPException(409, "ICH 来源已存在，请在现有来源中设置四类范围")
        source = store.ensure_source()
        source["name"] = body.name.strip()
    else:
        if body.enabled:
            raise HTTPException(400, "此来源尚未适配，不能开启真实监控")
        if len(store.records("source")) >= 20:
            raise HTTPException(400, "信息源数量达到上限")
        source = {
            **body.model_dump(by_alias=True),
            "id": store.key("source", body.url),
            "adapter": "unsupported",
            "status": "unsupported",
            "scopeStatus": {},
            "baselineScopes": [],
        }
    store.put("source", source)
    db.commit()
    return {"id": source["id"]}


@router.patch("/sources/{ident}")
def change_source(
    ident: str,
    body: SourceChange,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[dict, Depends(manager)],
):
    store = Store(db, actor["tenant"])
    source = store.source(ident)
    changes = body.model_dump(by_alias=True, exclude_unset=True)
    if any(value is None for key, value in changes.items() if key != "folderId"):
        raise HTTPException(400, "来源设置不能为空")
    source.update(changes)
    if source.get("enabled"):
        if not settings.INFORMATION_WORKER_ENABLED:
            raise HTTPException(503, "采集后台尚未启用，请联系管理员")
        if source["adapter"] != "ich":
            raise HTTPException(400, "来源尚未适配，不能开启监控")
        if not source.get("folderId"):
            source["folderId"] = ARCHIVE
        source["managerSubject"] = actor["subject"]
        source["nextCheckAt"] = time.time()
    store.put("source", source)
    store.audit(actor["subject"], "source_updated", ident)
    db.commit()
    return {"saved": True}


@router.post("/sources/{ident}/check", status_code=202)
def check_source(
    ident: str, db: Annotated[Session, Depends(get_db)], actor: Annotated[dict, Depends(manager)]
):
    store = Store(db, actor["tenant"])
    source = store.source(ident)
    if source["adapter"] != "ich":
        raise HTTPException(400, "此来源尚未适配")
    if not settings.INFORMATION_WORKER_ENABLED:
        raise HTTPException(503, "采集后台未启用，请联系管理员启动任务服务")
    job = store.create_job(ident, actor["subject"])
    db.commit()
    return {"id": job["id"]}


@router.post("/jobs", status_code=202)
def create_job(
    body: JobCreate,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[dict, Depends(manager)],
):
    store = Store(db, actor["tenant"])
    source = store.source(body.source_id)
    if not settings.INFORMATION_WORKER_ENABLED:
        raise HTTPException(503, "采集后台未启用，请联系管理员")
    if source["adapter"] != "ich":
        raise HTTPException(400, "此来源尚未适配")
    ids = list(dict.fromkeys(body.document_ids))
    for ident in ids:
        doc = store.get("document", ident)
        if doc["sourceId"] != source["id"]:
            raise HTTPException(400, "清单包含不属于该来源的资料")
    folder = body.folder_id
    if folder == "new-folder":
        if not body.new_folder:
            raise HTTPException(400, "请填写文件夹名称")
        try:
            folder = bridge.call("createFolder", actor["subject"], name=body.new_folder)["id"]
        except ValueError as exc:
            raise HTTPException(503, str(exc)) from exc
    elif folder != ARCHIVE:
        try:
            targets = bridge.call("catalogue", actor["subject"])["folders"]
            if folder not in [v["id"] for v in targets]:
                raise HTTPException(409, "目标知识库文件夹已不存在，请刷新重选")
        except ValueError as exc:
            raise HTTPException(503, str(exc)) from exc
    job = store.create_job(
        source["id"],
        actor["subject"],
        kind="import",
        document_ids=ids,
        folder_id=None if folder == ARCHIVE else folder,
        parse=body.parse,
    )
    # Store the display folder independently of the connector target.
    job["displayFolderId"] = folder
    store.put("job", job)
    source["folderId"] = folder
    source["parse"] = body.parse
    source["managerSubject"] = actor["subject"]
    store.put("source", source)
    db.commit()
    return {"id": job["id"]}


@router.post("/jobs/{ident}/control")
def control_job(
    ident: str,
    body: Action,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[dict, Depends(manager)],
):
    store = Store(db, actor["tenant"])
    job = store.control_job(ident, body.action)
    if body.action in ("resume", "retry"):
        job["actorSubject"] = actor["subject"]
        store.put("job", job)
    db.commit()
    return {"saved": True}


@router.post("/documents/{ident}/retry", status_code=202)
def retry_document(
    ident: str, db: Annotated[Session, Depends(get_db)], actor: Annotated[dict, Depends(manager)]
):
    if not settings.INFORMATION_WORKER_ENABLED:
        raise HTTPException(503, "后台采集服务尚未开启")
    store = Store(db, actor["tenant"])
    doc = store.document(ident)
    source = store.source(doc["sourceId"])
    target = next((f for f in doc.get("folderIds", []) if f != ARCHIVE), source.get("folderId"))
    job = store.create_job(
        source["id"],
        actor["subject"],
        kind="import",
        document_ids=[ident],
        folder_id=None if target == ARCHIVE else target,
        parse=True,
    )
    db.commit()
    return {"id": job["id"]}


@router.get("/documents/{document_id}/versions/{version_id}")
def read_version(
    document_id: str,
    version_id: str,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[dict, Depends(principal)],
):
    store = Store(db, actor["tenant"])
    store.get("document", document_id)
    version = store.get("version", version_id)
    if version["documentId"] != document_id:
        raise HTTPException(404, "资料版本不存在")
    return {**store.public_version(version), "text": version.get("text", "")[:2000000]}


@router.get("/documents/{document_id}/versions/{version_id}/original")
def original(
    document_id: str,
    version_id: str,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[dict, Depends(principal)],
):
    store = Store(db, actor["tenant"])
    store.get("document", document_id)
    version = store.get("version", version_id)
    if version["documentId"] != document_id:
        raise HTTPException(404, "资料版本不存在")
    path = store.archive_path(version)
    if not path.is_file():
        raise HTTPException(410, "归档文件暂不可读，请联系管理员恢复备份")
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


@router.post("/preferences")
def preferences(
    body: Preferences,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[dict, Depends(writer)],
):
    changes = body.model_dump(exclude_unset=True)
    if any(v is None for v in changes.values()):
        raise HTTPException(400, "偏好设置不能为空")
    store = Store(db, actor["tenant"])
    store.save_preferences(actor["subject"], changes)
    db.commit()
    return {"saved": True}


@router.put("/follows/{target}")
def follow(
    target: str,
    body: Switch,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[dict, Depends(writer)],
):
    store = Store(db, actor["tenant"])
    prefix, _, ident = target.partition(":")
    if prefix == "scope" and ident in ("Q", "S", "E", "M"):
        pass
    elif prefix in ("source", "document"):
        store.get(prefix, ident)
    else:
        raise HTTPException(400, "关注目标无效")
    prefs = store.preferences(actor["subject"])
    follows = set(prefs["follows"])
    follows.add(target) if body.enabled else follows.discard(target)
    store.save_preferences(actor["subject"], {"follows": sorted(follows)})
    db.commit()
    return {"saved": True}


@router.post("/events/{ident}/read")
def mark_read(
    ident: str,
    body: Read,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[dict, Depends(writer)],
):
    store = Store(db, actor["tenant"])
    store.get("event", ident)
    values = set(store.preferences(actor["subject"])["read"])
    values.add(ident) if body.read else values.discard(ident)
    store.save_preferences(actor["subject"], {"read": sorted(values)})
    db.commit()
    return {"saved": True}


@router.post("/later/{ident}")
def save_later(
    ident: str, db: Annotated[Session, Depends(get_db)], actor: Annotated[dict, Depends(writer)]
):
    store = Store(db, actor["tenant"])
    store.get("event", ident)
    values = set(store.preferences(actor["subject"])["later"])
    values.remove(ident) if ident in values else values.add(ident)
    store.save_preferences(actor["subject"], {"later": sorted(values)})
    db.commit()
    return {"saved": True}


@router.get("/documents/{document_id}/diff")
def version_diff(
    document_id: str,
    before: str,
    after: str,
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[dict, Depends(principal)],
):
    import difflib

    store = Store(db, actor["tenant"])
    store.get("document", document_id)
    old, new = store.get("version", before), store.get("version", after)
    if old["documentId"] != document_id or new["documentId"] != document_id:
        raise HTTPException(404, "资料版本不存在")
    if not old.get("text") or not new.get("text"):
        raise HTTPException(409, "这两个版本尚未完成正文解析，暂不能比较正文")
    a, b = old["text"][:200000], new["text"][:200000]
    text = "\n".join(
        difflib.unified_diff(
            a.splitlines(), b.splitlines(), fromfile=old["createdAt"], tofile=new["createdAt"]
        )
    )
    return {
        "text": text[:40000],
        "identical": old["text"] == new["text"],
        "truncated": len(old["text"]) > 200000 or len(new["text"]) > 200000 or len(text) > 40000,
    }


@router.get("/search")
def search(
    q: Annotated[str, Query(min_length=1, max_length=100)],
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[dict, Depends(principal)],
):
    from app.models.information import InformationText

    escaped = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    pattern = "%" + escaped + "%"
    rows = (
        db.query(InformationText.document_id)
        .filter(
            InformationText.tenant == actor["tenant"],
            InformationText.content.ilike(pattern, escape="\\"),
        )
        .limit(1000)
        .all()
    )
    return {
        "documentIds": sorted({row.document_id for row in rows}),
        "includesHistoricalVersions": True,
    }
