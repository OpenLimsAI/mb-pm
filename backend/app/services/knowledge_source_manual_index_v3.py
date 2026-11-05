"""Explicit manual-upload indexing. Core task polling never downloads or reimports a PDF."""

import copy
import time

from fastapi import HTTPException
from sqlalchemy import and_, or_

from app.core.config import settings
from app.models.information import InformationEntry
from app.services import password_policy
from app.services.information import bridge
from app.services.information.store import iso
from app.services.information.worker import active_account, safe_error

APP = "knowledge-sources"
KIND = "manual-index"


def manager_authority(db, subject):
    account = active_account(subject)
    roles = account.get("roles", [])
    if not any(
        isinstance(role, dict)
        and role.get("owner") == settings.CASDOOR_ORG
        and role.get("name") == "kb_manager"
        and role.get("isEnabled", True) is True
        for role in roles
    ) or password_policy.change_required(db, subject):
        raise HTTPException(403, "手动原件索引需要当前有效的知识库负责人权限")


def resolve_manual(store, subject, paper_id, connector=bridge.call):
    if paper_id.startswith("archive:"):
        version = store.get("version", paper_id[8:])
    else:
        candidates = [v for v in store.records("version") if v.get("kbPath") == paper_id]
        if not candidates:
            raise HTTPException(404, "手动上传原件不存在或无权访问")
        version = candidates[-1]
    document = store.get("document", version["documentId"])
    source = store.get("source", document["sourceId"])
    if (
        source.get("adapter") != "manual"
        or not version.get("kbDocumentId")
        or not version.get("kbPath")
    ):
        raise HTTPException(400, "此操作仅适用于知识源手动上传的原件")
    catalogue = connector(
        "library",
        subject,
        imports=[{"documentId": version["kbDocumentId"], "sha256": version["sha256"]}],
    )
    active = any(p.get("path") == version["kbPath"] for p in catalogue.get("papers", []))
    pending = any(
        p.get("path") == version["kbPath"]
        and p.get("documentId") == version["kbDocumentId"]
        and p.get("sha256") == version["sha256"]
        and p.get("indexStatus") in {"not_requested", "pending", "failed"}
        for p in catalogue.get("pendingArchives", [])
    )
    if not active and not pending:
        raise HTTPException(404, "原件已删除、正在删除或无权访问，不会自动恢复")
    return document, source, version, active


def _status_snapshot(store, version_id):
    # The authenticated KB check can overlap the worker's completion commit.
    # Read both records in one statement rather than combining the earlier
    # version dict with a later job query (completed + pending stops UI polling).
    rows = (
        store.db.query(InformationEntry)
        .filter(
            InformationEntry.tenant == store.tenant,
            or_(
                and_(InformationEntry.kind == "version", InformationEntry.id == version_id),
                InformationEntry.kind == "job",
            ),
        )
        .populate_existing()
        .order_by(InformationEntry.updated_at, InformationEntry.id)
        .all()
    )
    version, jobs = None, []
    for row in rows:
        value = copy.deepcopy(row.data)
        if row.kind == "version":
            version = value
        elif (
            value.get("app") == APP
            and value.get("kind") == KIND
            and any(item.get("versionId") == version_id for item in value.get("items", []))
        ):
            jobs.append(value)
    if version is None:
        raise HTTPException(404, "信息获取版本不存在")
    return version, jobs[-1] if jobs else None


def public_status(store, version):
    version, job = _status_snapshot(store, version["id"])
    return {
        "jobId": job["id"] if job else None,
        "status": job.get("status") if job else "not_started",
        "indexStatus": version.get("indexStatus", "unknown"),
        "error": job.get("error") if job else None,
        "updatedAt": job.get("updatedAt") if job else None,
        "originalSaved": True,
        "globalIncremental": True,
        "canCancelCoreTask": False,
    }


def create_job(store, actor, paper_id, *, connector=bridge.call):
    manager_authority(store.db, actor["subject"])
    document, source, version, _ = resolve_manual(store, actor["subject"], paper_id, connector)
    source = store.lock("source", source["id"])
    # The source row lock serializes concurrent confirmations across both PM instances.
    for old in store.active_jobs():
        if old.get("app") != APP or old["sourceId"] != source["id"]:
            continue
        same = old.get("kind") == KIND and any(
            i.get("versionId") == version["id"] for i in old["items"]
        )
        if not same:
            raise HTTPException(409, "手动收录已有未完成任务，请等待完成后再建立索引")
        if old["status"] == "paused":
            current = store.lock("job", old["id"])
            current.update(
                status="queued", actorSubject=actor["subject"], error=None, updatedAt=iso()
            )
            for item in current["items"]:
                if item["status"] == "pending":
                    item["nextAttemptAt"] = 0
            store.put("job", current)
            store.audit(actor["subject"], "manual_index_resume_confirmed", current["id"])
            store.db.commit()
        return public_status(store, version)
    if version.get("indexStatus") == "ready":
        # Recheck the durable, manager-only KB receipt rather than trusting a local UI flag.
        task_id = version.get("kbManualTaskId")
        if task_id:
            proof = connector(
                "statusUploadedPaper",
                actor["subject"],
                documentId=version["kbDocumentId"],
                sha256=version["sha256"],
                taskId=task_id,
            )
            if proof.get("indexStatus") == "ready" and proof.get("registered") is True:
                return public_status(store, version)
    job = store.create_job(
        source["id"],
        actor["subject"],
        app=APP,
        kind=KIND,
        document_ids=[document["id"]],
        parse=True,
    )
    job.update(
        globalIncremental=True,
        confirmedAt=iso(),
        originalSaved=True,
        displayFolderId=(document.get("folderIds") or [None])[0],
    )
    job["items"][0].update(
        versionId=version["id"], phase="index", result="reused", originalSaved=True
    )
    store.put("job", job)
    store.audit(actor["subject"], "manual_index_confirmed_global_incremental", job["id"])
    store.db.commit()
    return public_status(store, version)


def _persist(store, job_id, item, **job_values):
    current = store.lock("job", job_id)
    # UI cancellation/control cannot silently overwrite a concurrent worker update.
    if current["status"] not in {"queued", "running"}:
        store.db.rollback()
        return False
    current["items"] = [copy.deepcopy(item)]
    current.update(updatedAt=iso(), **job_values)
    store.put("job", current)
    store.db.commit()
    return True


def run_step(store, job_id, *, connector=bridge.call):
    job = store.get("job", job_id)
    if (
        job.get("app") != APP
        or job.get("kind") != KIND
        or job.get("status") not in {"queued", "running"}
    ):
        return False
    item = copy.deepcopy(job["items"][0])
    if item.get("nextAttemptAt", 0) > time.time():
        return False
    subject = job["actorSubject"]
    try:
        manager_authority(store.db, subject)
        _, _, version, _ = resolve_manual(store, subject, "archive:" + item["versionId"], connector)
        if not _persist(store, job_id, item, status="running", error=None):
            return False
        task_id = item.get("manualTaskId")
        if task_id:
            receipt = connector(
                "statusUploadedPaper",
                subject,
                documentId=version["kbDocumentId"],
                sha256=version["sha256"],
                taskId=task_id,
            )
        else:
            # The KB binds this call to its real manual-upload receipt and reuses a
            # pending task if a restart happened before PM persisted the response.
            receipt = connector(
                "indexUploadedPaper",
                subject,
                documentId=version["kbDocumentId"],
                sha256=version["sha256"],
            )
        returned_task = receipt.get("taskId")
        if not isinstance(returned_task, str) or not returned_task or len(returned_task) > 200:
            raise ValueError("知识库尚未返回可确认的索引任务编号，保留原件并稍后重试")
        if task_id and task_id != returned_task:
            raise HTTPException(409, "知识库索引任务编号发生变化，未将未知结果标记成功")
        item["manualTaskId"] = returned_task
        version["kbManualTaskId"] = returned_task
        state = receipt.get("indexStatus")
        if state == "ready" and receipt.get("registered") is True:
            # A fresh active-library proof prevents a completed task from reviving
            # a source removed during indexing or awaiting actual registration.
            _, _, _, active = resolve_manual(store, subject, "archive:" + version["id"], connector)
            if active:
                version.update(indexStatus="ready", kbPending=False)
                store.put("version", version)
                item.update(status="saved", phase="complete", error=None)
                return _persist(
                    store,
                    job_id,
                    item,
                    status="completed",
                    processed=1,
                    saved=1,
                    failed=0,
                    pending=0,
                    error=None,
                    finishedAt=iso(),
                )
        if state == "failed":
            error = str(receipt.get("error") or "知识库索引未完成，原件保留，可确认后重试")[:500]
            version["indexStatus"] = "failed"
            store.put("version", version)
            item.update(status="failed", phase="index", failurePhase="index", error=error)
            return _persist(
                store,
                job_id,
                item,
                status="failed",
                processed=1,
                saved=0,
                failed=1,
                pending=0,
                error=error,
                finishedAt=iso(),
            )
        version["indexStatus"] = "pending"
        store.put("version", version)
        item.update(status="pending", phase="index", nextAttemptAt=time.time() + 5, error=None)
        return _persist(
            store,
            job_id,
            item,
            status="running",
            processed=0,
            saved=0,
            failed=0,
            pending=1,
            error=None,
        )
    except Exception as exc:
        store.db.rollback()
        error = safe_error(exc)
        if (
            isinstance(exc, HTTPException)
            and exc.status_code in {400, 403, 404, 409, 422}
            or isinstance(exc, bridge.BridgeError)
            and exc.status in {400, 403, 404, 409, 422}
        ):
            if getattr(exc, "status_code", getattr(exc, "status", None)) == 403:
                return _persist(store, job_id, item, status="paused", error=error)
            item.update(status="failed", phase="index", failurePhase="index", error=error)
            return _persist(
                store,
                job_id,
                item,
                status="failed",
                processed=1,
                saved=0,
                failed=1,
                pending=0,
                error=error,
                finishedAt=iso(),
            )
        item.update(
            nextAttemptAt=time.time() + 30, phase="index", error="索引状态暂未确认：" + error
        )
        return _persist(store, job_id, item, status="running", error=item["error"])
