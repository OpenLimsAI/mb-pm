"""Folder import background worker, per-item PDF parse/upload/index pipeline, and lease."""

from __future__ import annotations

import base64
import hashlib
import logging
import threading
import time
from datetime import datetime
from pathlib import PurePosixPath
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import update
from sqlalchemy.exc import IntegrityError

from app.core.config import settings
from app.db.session import SessionLocal
from app.models.information import InformationEntry, InformationLease
from app.services.information import bridge
from app.services.information.extract import extract_pdf
from app.services.information.store import Store, iso
from app.services.information.worker import safe_error
from app.services.knowledge_source_folder_connector import apply_manifest, save_original
from app.services.knowledge_source_folder_quota import (
    destination_folder,
    file_entry_id,
    get_active_task,
    items_for,
    meter_usage,
    require_authority,
    usage_snapshot,
    wait_for_quota,
)
from app.services.knowledge_source_folder_roots import (
    ACTIVE,
    FILE,
    ITEM,
    LOCAL_RUN_STALE_SECONDS,
    MAX_INDEX_POLL_ATTEMPTS,
    MAX_INDEX_POLL_SECONDS,
    RUN,
    SHA,
    TASK,
    LeaseLostError,
    is_auth_revocation,
    safe_read,
    server_directory,
)
from app.services.knowledge_source_folder_tasks import queue_scan, refresh_run

logger = logging.getLogger("cmc-pms.folder-imports")


def _item_destination(store, task, run, item, subject, connector):
    folder_id = run["folderId"]
    summary = connector("librarySummary", subject)
    if not summary.get("canWrite") or not any(
        f["id"] == folder_id for f in summary.get("folders", [])
    ):
        raise HTTPException(409, "目标文件夹已不存在或权限失效，请重新配置后继续")
    if not run.get("preserveHierarchy"):
        return folder_id
    for segment in PurePosixPath(item["relativePath"]).parts[:-1]:
        known = next(
            (
                f
                for f in summary["folders"]
                if f.get("parentId") == folder_id and f["name"] == segment
            ),
            None,
        )
        if known:
            folder_id = known["id"]
            continue
        summary = connector(
            "folderMutation",
            subject,
            mutation={
                "operation": "create",
                "revision": summary["revision"],
                "name": segment,
                "parentId": folder_id,
            },
        )
        found = next(
            (
                f
                for f in summary["folders"]
                if f.get("parentId") == folder_id and f["name"] == segment
            ),
            None,
        )
        if not found:
            raise ValueError("子文件夹尚未创建成功，请稍后重试")
        folder_id = found["id"]
    return folder_id


def process_item(
    store, task, run, item, connector=bridge.call, extract=extract_pdf, heartbeat=None
):
    subject = run["actorSubject"]
    require_authority(store, subject, connector)
    destination = _item_destination(store, task, run, item, subject, connector)
    latest_task = store.get(TASK, task["id"])
    latest_run = store.get(RUN, run["id"])
    if (
        latest_task.get("paused")
        or latest_task.get("deletedAt")
        or latest_run["status"] not in ACTIVE
    ):
        return False
    try:
        if not item.get("originalSaved"):
            if task["kind"] != "server":
                return False
            with server_directory(task) as root_fd:
                content, attrs = safe_read(
                    root_fd,
                    item["relativePath"],
                    task["maxFileMb"] * 1024 * 1024,
                    heartbeat=heartbeat,
                )
            actual_sha = hashlib.sha256(content).hexdigest()
            if item.get("allowChangedFingerprint") or not SHA.fullmatch(item["sha256"]):
                item.update(
                    sha256=actual_sha,
                    size=len(content),
                    mtime=attrs.st_mtime,
                    allowChangedFingerprint=False,
                )
                store.put(ITEM, item)
                store.db.commit()
            elif actual_sha != item["sha256"] or len(content) != item["size"]:
                raise ValueError("文件在扫描后发生变化，请重试该文件以重新核对")
            save_original(store, task, run, item["relativePath"], item["sha256"], content)
            return True
        version = store.get("version", item["versionId"])
        source_key = hashlib.sha256((task["id"] + ":" + item["relativePath"]).encode()).hexdigest()

        def upload_to_kb(text_value: str):
            if heartbeat:
                heartbeat()
            reply = connector(
                "folderImportPaper",
                subject,
                taskId=task["id"],
                sourceKey=source_key,
                name=PurePosixPath(item["relativePath"]).name,
                originalBase64=base64.b64encode(store.archive_path(version).read_bytes()).decode(
                    "ascii"
                ),
                sha256=item["sha256"],
                text=text_value,
                folderId=destination,
            )
            if not reply.get("documentId") or not reply.get("path"):
                raise ValueError("知识库未返回可确认的原件记录")
            item.update(
                kbDocumentId=reply["documentId"],
                paperId=reply["path"],
                indexStatus=reply.get("indexStatus", "not_requested"),
                kbTextReady=version.get("parseStatus") == "ready",
            )
            version.update(
                kbDocumentId=reply["documentId"],
                kbPath=reply["path"],
                kbUrl=reply.get("url"),
                kbPending=not reply.get("registered", False),
                indexStatus=item["indexStatus"],
            )
            store.put("version", version)

        if version.get("parseStatus") != "ready":
            item["phase"] = "parse"
            store.put(ITEM, item)
            store.db.commit()
            if heartbeat:
                heartbeat()
            try:
                extracted = (
                    extract(store.archive_path(version), with_metadata=True)
                    if extract is extract_pdf
                    else extract(store.archive_path(version))
                )
            except Exception:
                if not item.get("kbDocumentId"):
                    try:
                        upload_to_kb("")
                        store.put(ITEM, item)
                        store.db.commit()
                    except Exception:
                        store.db.rollback()
                        logger.warning(
                            "folder_import fallback original archive failed for item=%s",
                            item["id"],
                            exc_info=True,
                        )
                raise
            text = extracted["text"] if isinstance(extracted, dict) else extracted
            pages = extracted.get("pages") if isinstance(extracted, dict) else None
            known_pages = (
                isinstance(pages, int) and not isinstance(pages, bool) and 0 <= pages <= 1000
            )
            meter_usage(
                store,
                task,
                "parse:" + version["id"],
                parsedCharacters=len(text),
                parsedPages=pages if known_pages else 0,
                unknownParsedPages=0 if known_pages else 1,
            )
            version.update(
                text=text,
                parseStatus="ready",
                error=None,
                parsedPages=pages if known_pages else None,
            )
            store.put("version", version)
            item["phase"] = "archive"
            store.put(ITEM, item)
            store.db.commit()
            upload_to_kb(text)
            item.update(phase="index", error=None)
        elif not item.get("kbDocumentId") or not item.get("kbTextReady"):
            item["phase"] = "archive"
            store.put(ITEM, item)
            store.db.commit()
            upload_to_kb(version.get("text", ""))
            item.update(phase="index", error=None)
        else:
            item["phase"] = "index"
            store.put(ITEM, item)
            store.db.commit()
            if heartbeat:
                heartbeat()
            operation = "statusFolderPaper" if item.get("kbTaskId") else "indexFolderPaper"
            values = {
                "importTaskId": task["id"],
                "sourceKey": source_key,
                "documentId": item["kbDocumentId"],
                "sha256": item["sha256"],
            }
            if item.get("kbTaskId"):
                values["taskId"] = item["kbTaskId"]
            reply = connector(operation, subject, **values)
            state = reply.get("indexStatus")
            if state not in {"pending", "ready", "failed"}:
                raise ValueError("知识库未返回可确认的索引状态")
            if state == "pending" and (
                not isinstance(reply.get("taskId"), str)
                or not reply["taskId"]
                or len(reply["taskId"]) > 255
            ):
                raise ValueError("知识库未返回可确认的索引任务编号")
            item["kbTaskId"] = reply.get("taskId", item.get("kbTaskId"))
            item["indexStatus"] = state
            version.update(indexStatus=state, kbPending=not reply.get("registered", False))
            if state == "failed":
                item.pop("kbTaskId", None)
                raise ValueError(str(reply.get("error") or "问答索引未完成，请查看索引配置后重试"))
            if state == "ready" and reply.get("registered") is True:
                item.update(status="completed", phase="done", error=None, finishedAt=iso())
                meter_usage(
                    store,
                    task,
                    "complete:" + item["id"],
                    completedFiles=1,
                    indexedFiles=1,
                    reusedFiles=1 if item.get("reused") else 0,
                )
                file_id = file_entry_id(store, task["id"], item["relativePath"])
                old = store.get(FILE, file_id, required=False) or {
                    "id": file_id,
                    "taskId": task["id"],
                    "relativePath": item["relativePath"],
                    "versions": [],
                }
                history = old.get("versions", [])
                if not any(v["sha256"] == item["sha256"] for v in history):
                    history.append(
                        {
                            "sha256": item["sha256"],
                            "versionId": item["versionId"],
                            "paperId": item["paperId"],
                            "completedAt": iso(),
                        }
                    )
                old.update(
                    sha256=item["sha256"],
                    versionId=item["versionId"],
                    documentId=item["documentId"],
                    paperId=item["paperId"],
                    status="completed",
                    versions=history,
                    sourceMissing=False,
                    lastSeenAt=iso(),
                )
                store.put(FILE, old)
                document = store.get("document", item["documentId"])
                document.update(
                    status="ready",
                    folderIds=sorted(set(document.get("folderIds", [])) | {destination}),
                )
                store.put("document", document)
            else:
                item.setdefault("indexStartedAt", time.time())
                item["pollAttempts"] = item.get("pollAttempts", 0) + 1
                if (
                    item["pollAttempts"] >= MAX_INDEX_POLL_ATTEMPTS
                    or (time.time() - item["indexStartedAt"]) >= MAX_INDEX_POLL_SECONDS
                ):
                    item.pop("kbTaskId", None)
                    raise ValueError("问答索引跟踪超时，原件已保留，可稍后重试")
                item["nextAttemptAt"] = time.time() + 5
            store.put("version", version)
        item["attempts"] = 0
    except LeaseLostError:
        raise
    except Exception as exc:
        store.db.rollback()
        error = safe_error(exc)
        item["error"] = error
        item["attempts"] = item.get("attempts", 0) + 1
        deleted = isinstance(exc, bridge.BridgeError) and (
            getattr(exc, "code", None) == "folder_source_deleted"
            or (exc.status == 409 and any(v in str(exc) for v in ("已删除", "正在删除")))
        )
        if deleted:
            item.update(status="ignored", phase="done", suppressed=True)
            file_id = file_entry_id(store, task["id"], item["relativePath"])
            old = store.get(FILE, file_id, required=False) or {
                "id": file_id,
                "taskId": task["id"],
                "relativePath": item["relativePath"],
            }
            old.update(sha256=item["sha256"], suppressed=True, status="ignored")
            store.put(FILE, old)
        elif (isinstance(exc, HTTPException) and exc.status_code in (403, 409)) or (
            isinstance(exc, bridge.BridgeError)
            and (exc.status == 403 or exc.code == "folder_target_missing")
        ):
            current = get_active_task(store, task["id"])
            current.update(paused=True, lastError=error, nextScanAt=None)
            store.put(TASK, current)
            logger.warning(
                "Paused folder-import task=%s item=%s on permission/target error: %s",
                task["id"],
                item["id"],
                error,
            )
        elif item["attempts"] >= 3 or (isinstance(exc, ValueError) and item["phase"] == "parse"):
            item["status"] = "failed"
            logger.warning(
                "Folder-import item=%s path=%s failed permanently (phase=%s): %s",
                item["id"],
                item["relativePath"],
                item.get("phase"),
                error,
            )
        else:
            item["nextAttemptAt"] = time.time() + 10 * (2 ** (item["attempts"] - 1))
    store.put(ITEM, item)
    refresh_run(store, run["id"])
    store.db.commit()
    return True


def process_run(store, run_id, connector=bridge.call, extract=extract_pdf, heartbeat=None):
    from app.services import folder_imports

    run = store.get(RUN, run_id)
    task = get_active_task(store, run["taskId"])
    if task.get("paused") or run["status"] not in ACTIVE:
        return False
    if run.get("nextAttemptAt", 0) > time.time():
        return False
    if run["status"] == "waiting_quota" and usage_snapshot(store, task)["remainingFiles"] == 0:
        return False
    if task["kind"] == "local" and not run.get("manifestComplete"):
        updated = run.get("updatedAt") or run.get("createdAt")
        if (
            updated
            and (time.time() - datetime.fromisoformat(updated).timestamp())
            >= LOCAL_RUN_STALE_SECONDS
        ):
            locked_run = store.lock(RUN, run_id)
            if locked_run["status"] in ACTIVE and not locked_run.get("manifestComplete"):
                locked_run.update(
                    status="failed",
                    phase="done",
                    error="本机连接程序长时间未响应，本次扫描已超时结束，请重新连接后重试",
                    finishedAt=iso(),
                    updatedAt=iso(),
                )
                store.put(RUN, locked_run)
                store.db.commit()
                logger.warning(
                    "Expired stale local folder-import run=%s task=%s", run_id, task["id"]
                )
                return True
        return False
    if task["kind"] == "server" and not run.get("manifestReceived"):
        summary = require_authority(store, run["actorSubject"], connector)
        destination_folder(task, summary, run["actorSubject"], connector)
        files, errors, truncated, cursor = folder_imports.scan_server(task, heartbeat)
        task = store.get(TASK, task["id"])
        run = store.get(RUN, run_id)
        if task.get("paused") or task.get("deletedAt") or run["status"] not in ACTIVE:
            store.db.rollback()
            return False
        apply_manifest(store, task, run, files, errors, truncated)
        task = store.lock(TASK, task["id"])
        if task.get("deletedAt"):
            store.db.rollback()
            return False
        task["scanCursor"] = cursor
        store.put(TASK, task)
        run = store.get(RUN, run_id)
        run.update(manifestComplete=True, status="processing", phase="process")
        task["hasScanned"] = True
        store.put(TASK, task)
        store.put(RUN, run)
        refresh_run(store, run_id)
        store.db.commit()
        return True
    if not run.get("manifestComplete"):
        return False
    items = items_for(store, run_id)
    now = time.time()
    pending = next(
        (i for i in items if i["status"] == "pending" and i.get("nextAttemptAt", 0) <= now),
        None,
    )
    if pending:
        if wait_for_quota(store, task, run):
            return False
        summary = require_authority(store, run["actorSubject"], connector)
        destination_folder(task, summary, run["actorSubject"], connector)
        run = store.get(RUN, run_id)
        return process_item(store, task, run, pending, connector, extract, heartbeat)
    if any(i["status"] == "pending" for i in items):
        return False
    refresh_run(store, run_id)
    store.db.commit()
    return False


def schedule_due(db, now=None, connector=bridge.call):
    timestamp = time.time() if now is None else now
    for row in db.query(InformationEntry).filter_by(kind=TASK).all():
        task = row.data
        if task.get("deletedAt") or task.get("paused") or not task.get("nextScanAt"):
            continue
        if datetime.fromisoformat(task["nextScanAt"]).timestamp() > timestamp:
            continue
        store = Store(db, row.tenant)
        try:
            queue_scan(store, task["id"], task["actorSubject"], connector=connector, scheduled=True)
        except Exception as exc:
            db.rollback()
            current = get_active_task(store, task["id"])
            if is_auth_revocation(exc) or (
                isinstance(exc, HTTPException) and exc.status_code == 409
            ):
                current.update(lastError=safe_error(exc), paused=True, nextScanAt=None)
                logger.warning(
                    "Paused folder-import task=%s due to auth/config error: %s",
                    task["id"],
                    safe_error(exc),
                )
            else:
                current.update(lastError=safe_error(exc), nextScanAt=iso(timestamp + 300))
                logger.warning(
                    "Backed off folder-import task=%s due to transient error: %s",
                    task["id"],
                    safe_error(exc),
                )
            store.put(TASK, current)
            db.commit()


def tick(session_factory=SessionLocal, connector=bridge.call):
    if not settings.KNOWLEDGE_SOURCE_APP_ENABLED or not settings.KNOWLEDGE_SOURCE_WORKER_ENABLED:
        return
    db = session_factory()
    owner = str(uuid4())
    lease_id = "folder-import-worker"
    acquired = False
    try:
        if db.get(InformationLease, lease_id) is None:
            try:
                with db.begin_nested():
                    db.add(InformationLease(id=lease_id, owner="", expires_at=0))
                    db.flush()
            except IntegrityError:
                pass
        acquired = (
            db.execute(
                update(InformationLease)
                .where(InformationLease.id == lease_id, InformationLease.expires_at <= time.time())
                .values(owner=owner, expires_at=time.time() + 300)
            ).rowcount
            == 1
        )
        db.commit()
        if not acquired:
            return
        last_heartbeat = time.monotonic()

        def heartbeat():
            nonlocal last_heartbeat
            if time.monotonic() - last_heartbeat < 10:
                return
            hb_db = session_factory()
            try:
                changed = hb_db.execute(
                    update(InformationLease)
                    .where(InformationLease.id == lease_id, InformationLease.owner == owner)
                    .values(expires_at=time.time() + 300)
                ).rowcount
                hb_db.commit()
            finally:
                hb_db.close()
            if changed != 1:
                raise LeaseLostError()
            last_heartbeat = time.monotonic()

        schedule_due(db, connector=connector)
        from app.services.knowledge_source_retention import maybe_prune_expired_entries

        maybe_prune_expired_entries(db)
        for row in (
            db.query(InformationEntry)
            .filter(
                InformationEntry.kind == RUN,
                InformationEntry.data["status"].as_string().in_(list(ACTIVE)),
            )
            .order_by(InformationEntry.updated_at)
            .all()
        ):
            store = Store(db, row.tenant)
            try:
                if process_run(store, row.id, connector, heartbeat=heartbeat):
                    break
            except LeaseLostError:
                db.rollback()
                return
            except Exception as exc:
                db.rollback()
                run = store.get(RUN, row.id)
                task = store.get(TASK, run["taskId"])
                if task.get("deletedAt"):
                    continue
                if is_auth_revocation(exc) or (
                    isinstance(exc, HTTPException) and exc.status_code == 409
                ):
                    task.update(lastError=safe_error(exc), paused=True, nextScanAt=None)
                    run["error"] = safe_error(exc)
                    logger.warning(
                        "Paused folder-import task=%s run=%s: %s",
                        task["id"],
                        run["id"],
                        safe_error(exc),
                    )
                else:
                    task["lastError"] = safe_error(exc)
                    run["error"] = safe_error(exc)
                    run["nextAttemptAt"] = time.time() + 30
                    logger.warning(
                        "Transient error on folder-import task=%s run=%s, backing off 30s: %s",
                        task["id"],
                        run["id"],
                        safe_error(exc),
                    )
                store.put(TASK, task)
                store.put(RUN, run)
                db.commit()
    except Exception:
        db.rollback()
        logger.exception("Folder import worker step failed")
    finally:
        if acquired:
            try:
                db.execute(
                    update(InformationLease)
                    .where(InformationLease.id == lease_id, InformationLease.owner == owner)
                    .values(owner="", expires_at=0)
                )
                db.commit()
            except Exception:
                db.rollback()
        db.close()


def start_worker():
    stop = threading.Event()

    def loop():
        while not stop.wait(2):
            try:
                tick()
            except Exception:
                logger.exception("Folder import worker loop uncaught error")

    thread = threading.Thread(target=loop, name="knowledge-folder-imports", daemon=True)
    thread.start()
    logger.info("folder-import worker started")
    return stop, thread
