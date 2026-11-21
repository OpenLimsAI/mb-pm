# ruff: noqa: B008
"""Folder import manager and narrowly scoped outbound-connector endpoints."""

from pathlib import Path
from typing import Literal

from fastapi import (
    APIRouter,
    Depends,
    Header,
    HTTPException,
    Query,
    Request,
)
from fastapi.responses import FileResponse
from pydantic import Field, StrictBool
from sqlalchemy.orm import Session
from starlette.datastructures import UploadFile as StarletteUploadFile

from app.api.multipart import upload_form
from app.api.v1.knowledge_sources import Input, connected, manager, principal
from app.core.config import settings
from app.db.session import get_db
from app.services import folder_imports as service
from app.services.information.store import Store, iso

router = APIRouter(prefix="/knowledge-sources/v3/folder-imports", tags=["folder-imports"])


class Schedule(Input):
    frequency: Literal["daily", "weekly", "manual"] = "daily"
    time: str = Field("08:00", max_length=5)
    timezone: str = Field("Asia/Shanghai", max_length=100)
    weekday: int = Field(0, ge=0, le=6)


class TaskInput(Input):
    name: str = Field(min_length=1, max_length=100)
    kind: Literal["local", "server"]
    server_root_id: str | None = Field(None, alias="serverRootId", max_length=100)
    path: str = Field("", max_length=1500)
    local_folder_name: str | None = Field(None, alias="localFolderName", max_length=255)
    folder_id: str | None = Field(None, alias="folderId", max_length=100)
    include_subfolders: StrictBool = Field(True, alias="includeSubfolders")
    preserve_hierarchy: StrictBool = Field(False, alias="preserveHierarchy")
    max_file_mb: int = Field(100, alias="maxFileMb", ge=1, le=100)
    max_files_per_scan: int = Field(1000, alias="maxFilesPerScan", ge=1, le=10000)
    daily_file_limit: int = Field(1000, alias="dailyFileLimit", ge=1, le=50000, strict=True)
    schedule: Schedule = Field(default_factory=Schedule)
    authorize_knowledge_base_incremental: StrictBool = Field(
        False, alias="authorizeKnowledgeBaseIncremental"
    )


class PairInput(Input):
    code: str = Field(min_length=15, max_length=100)
    path: str = Field(min_length=1, max_length=1500)
    device_name: str = Field("本机连接程序", alias="deviceName", max_length=100)


class ManifestFile(Input):
    relative_path: str = Field(alias="relativePath", min_length=1, max_length=1500)
    size: int = Field(ge=1, le=100 * 1024 * 1024)
    mtime: float = Field(ge=0, allow_inf_nan=False)
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")


class FileError(Input):
    relative_path: str = Field(alias="relativePath", min_length=1, max_length=1500)
    error: str = Field(min_length=1, max_length=500)


class ManifestInput(Input):
    files: list[ManifestFile] = Field(default_factory=list, max_length=10000)
    errors: list[FileError] = Field(default_factory=list, max_length=10000)
    truncated: StrictBool = False


class FinishInput(Input):
    errors: list[FileError] = Field(default_factory=list, max_length=10000)
    truncated: StrictBool = False


class RetryInput(Input):
    item_ids: list[str] | None = Field(None, alias="itemIds", min_length=1, max_length=10000)


def _store(db, actor):
    return Store(db, actor["tenant"])


def _enabled():
    if not settings.KNOWLEDGE_SOURCE_WORKER_ENABLED:
        raise HTTPException(503, "自动导入后台尚未启动，请联系管理员")


@router.get("/bootstrap")
def bootstrap(db: Session = Depends(get_db), actor=Depends(principal)):
    summary = connected("librarySummary", actor["subject"])
    can_write = bool(summary.get("canWrite") and actor.get("manage"))
    store = _store(db, actor)
    tasks = (
        [
            service.public_task(store, t)
            for t in store.records(service.TASK)
            if not t.get("deletedAt")
        ]
        if can_write
        else []
    )
    return {
        "tasks": tasks,
        "roots": service.roots() if can_write else [],
        "canWrite": can_write,
        "workerEnabled": settings.KNOWLEDGE_SOURCE_WORKER_ENABLED,
        "maxFileMb": settings.KNOWLEDGE_FOLDER_IMPORT_MAX_FILE_MB,
        "connectorOnlineSeconds": service.ONLINE_SECONDS,
    }


@router.get("/directories")
def directories(
    root_id: str = Query(min_length=1, max_length=100),
    path: str = Query("", max_length=1500),
    q: str = Query("", max_length=255),
    db: Session = Depends(get_db),
    actor=Depends(manager),
):
    service.require_authority(_store(db, actor), actor["subject"], connected, actor_verified=True)
    return service.list_directories(root_id, path, q)


@router.get("/directories/search")
def search_directories(
    q: str = Query(min_length=1, max_length=255),
    db: Session = Depends(get_db),
    actor=Depends(manager),
):
    service.require_authority(_store(db, actor), actor["subject"], connected, actor_verified=True)
    return service.search_directories(q)


@router.post("/probe")
def probe(body: TaskInput, db: Session = Depends(get_db), actor=Depends(manager)):
    service.require_authority(_store(db, actor), actor["subject"], connected, actor_verified=True)
    return service.probe(body.model_dump(by_alias=True))


@router.post("/tasks", status_code=201)
def create_task(body: TaskInput, db: Session = Depends(get_db), actor=Depends(manager)):
    _enabled()
    return {
        "task": service.create_task(
            _store(db, actor), actor, body.model_dump(by_alias=True), connected
        )
    }


@router.patch("/tasks/{ident}")
def update_task(ident: str, body: TaskInput, db: Session = Depends(get_db), actor=Depends(manager)):
    return {
        "task": service.update_task(
            _store(db, actor), ident, actor, body.model_dump(by_alias=True), connected
        )
    }


@router.post("/tasks/{ident}/scan", status_code=202)
def scan(ident: str, db: Session = Depends(get_db), actor=Depends(manager)):
    _enabled()
    run, reused = service.queue_scan(
        _store(db, actor), ident, actor["subject"], connector=connected
    )
    return {"run": run, "reused": reused}


@router.post("/tasks/{ident}/pause")
def pause(ident: str, db: Session = Depends(get_db), actor=Depends(manager)):
    return {"task": service.control_task(_store(db, actor), ident, actor, "pause", connected)}


@router.post("/tasks/{ident}/resume")
def resume(ident: str, db: Session = Depends(get_db), actor=Depends(manager)):
    _enabled()
    return {"task": service.control_task(_store(db, actor), ident, actor, "resume", connected)}


@router.post("/tasks/{ident}/retry")
def retry(ident: str, db: Session = Depends(get_db), actor=Depends(manager)):
    _enabled()
    return {"task": service.control_task(_store(db, actor), ident, actor, "retry", connected)}


@router.delete("/tasks/{ident}")
def delete(ident: str, db: Session = Depends(get_db), actor=Depends(manager)):
    return {"task": service.control_task(_store(db, actor), ident, actor, "delete", connected)}


@router.post("/tasks/{ident}/pairing", status_code=201)
def pairing(ident: str, db: Session = Depends(get_db), actor=Depends(manager)):
    return service.pair_code(_store(db, actor), ident, actor, connected)


@router.get("/tasks/{ident}/runs")
def runs(ident: str, db: Session = Depends(get_db), actor=Depends(manager)):
    store = _store(db, actor)
    service.require_authority(store, actor["subject"], connected, actor_verified=True)
    service._task(store, ident)
    return {"runs": [service.public_run(r) for r in service.runs_for(store, ident)[:100]]}


@router.get("/tasks/{ident}/usage")
def usage(ident: str, db: Session = Depends(get_db), actor=Depends(manager)):
    store = _store(db, actor)
    service.require_authority(store, actor["subject"], connected, actor_verified=True)
    task = service._task(store, ident)
    days = sorted(
        (v for v in store.records(service.USAGE) if v["taskId"] == ident),
        key=lambda value: (value["date"], value["timezone"]),
        reverse=True,
    )
    return {"usage": service.usage_snapshot(store, task), "days": days[:31]}


@router.get("/runs/{ident}")
def run_detail(ident: str, db: Session = Depends(get_db), actor=Depends(manager)):
    store = _store(db, actor)
    service.require_authority(store, actor["subject"], connected, actor_verified=True)
    run = store.get(service.RUN, ident)
    service._task(store, run["taskId"])
    return {
        "run": service.public_run(run),
        "items": [service.public_item(i, run) for i in service.items_for(store, ident)],
    }


@router.post("/runs/{ident}/retry", status_code=202)
def retry_run(ident: str, body: RetryInput, db: Session = Depends(get_db), actor=Depends(manager)):
    _enabled()
    return {
        "run": service.retry_run(_store(db, actor), ident, actor, connected, item_ids=body.item_ids)
    }


@router.post("/runs/{ident}/read")
def read_run(ident: str, db: Session = Depends(get_db), actor=Depends(manager)):
    store = _store(db, actor)
    service.require_authority(store, actor["subject"], connected, actor_verified=True)
    run = store.lock(service.RUN, ident)
    service._task(store, run["taskId"])
    run["readAt"] = iso()
    store.put(service.RUN, run)
    db.commit()
    return {"saved": True}


@router.get("/connector/script")
def connector_script(actor=Depends(manager)):
    module = Path(__file__).resolve()
    script = module.parents[3] / "scripts" / "knowledge-folder-connector.py"
    if not script.is_file():
        script = module.parents[4] / "scripts" / "knowledge-folder-connector.py"
    if not script.is_file():
        raise HTTPException(503, "连接程序暂不可用，请联系管理员")
    return FileResponse(
        script,
        media_type="text/x-python",
        filename="knowledge-folder-connector.py",
        headers={"Cache-Control": "private, no-store"},
    )


@router.post("/connector/pair")
def connector_pair(body: PairInput, db: Session = Depends(get_db)):
    if not settings.KNOWLEDGE_SOURCE_APP_ENABLED:
        raise HTTPException(410, "知识源暂未启用")
    return service.pair_connector(db, body.code, body.path, body.device_name, connected)


def _connector(request: Request, db: Session):
    if not settings.KNOWLEDGE_SOURCE_APP_ENABLED:
        raise HTTPException(410, "知识源暂未启用")
    authorization = request.headers.get("Authorization", "")
    if not authorization.startswith("Bearer "):
        raise HTTPException(401, "连接程序必须提供独立授权，请重新配对")
    return service.connector_actor(db, authorization[7:], connected)


@router.post("/connector/poll")
def connector_poll(request: Request, db: Session = Depends(get_db)):
    store, agent, task = _connector(request, db)
    return service.connector_poll(store, agent, task)


@router.post("/connector/runs/{ident}/manifest")
def connector_manifest(
    ident: str,
    body: ManifestInput,
    request: Request,
    lease: str = Header("", alias="X-Folder-Run-Lease"),
    db: Session = Depends(get_db),
):
    store, agent, task = _connector(request, db)
    run = service.connector_run(store, agent, task, ident, lease)
    return service.apply_manifest(
        store,
        task,
        run,
        [f.model_dump(by_alias=True) for f in body.files],
        [e.model_dump(by_alias=True) for e in body.errors],
        body.truncated,
    )


@router.post("/connector/runs/{ident}/files")
async def connector_file(
    ident: str,
    request: Request,
    lease: str = Header("", alias="X-Folder-Run-Lease"),
    db: Session = Depends(get_db),
):
    store, agent, task = _connector(request, db)
    run = service.connector_run(store, agent, task, ident, lease)
    async with upload_form(request, max_files=1, max_fields=8, max_part_size=64 * 1024) as form:
        relative_path = form.get("relativePath") or form.get("relative_path")
        sha256 = form.get("sha256")
        uploaded = form.get("file")
        if (
            not isinstance(relative_path, str)
            or not isinstance(sha256, str)
            or not isinstance(uploaded, StarletteUploadFile)
        ):
            raise HTTPException(422, "缺少文件上传必要参数")
        content = await uploaded.read(task["maxFileMb"] * 1024 * 1024 + 1)
    return service.save_original(store, task, run, relative_path, sha256, content)


@router.post("/connector/runs/{ident}/finish", status_code=202)
def connector_finish(
    ident: str,
    body: FinishInput,
    request: Request,
    lease: str = Header("", alias="X-Folder-Run-Lease"),
    db: Session = Depends(get_db),
):
    store, agent, task = _connector(request, db)
    run = service.connector_run(store, agent, task, ident, lease)
    return service.finish_transfer(
        store, task, run, [e.model_dump(by_alias=True) for e in body.errors], body.truncated
    )
