"""Only explicitly created knowledge-source jobs run; retired monitors never resume."""

import logging
import threading
import time
from datetime import datetime
from uuid import uuid4

from app.core.config import settings
from app.db.session import SessionLocal
from app.models.information import InformationEntry
from app.services.information import bridge
from app.services.information.ich import OfficialClient
from app.services.information.store import Store, iso
from app.services.information.worker import authority, run_step, safe_error
from app.services.knowledge_source_status import version_state

APP = "knowledge-sources"
logger = logging.getLogger("cmc-pms.knowledge-sources")


def synchronize_classification(store, job, connector=bridge.call):
    """Carry folders assigned while parsing onto the same eventual Core paper."""
    for item in job["items"]:
        if not item.get("versionId"):
            continue
        version = store.get("version", item["versionId"])
        if not version.get("kbPath"):
            continue
        ident = store.key("ks_classification", version["documentId"])
        classification = store.get("ks_classification", ident, required=False)
        if not classification or version["id"] in classification.get("syncedVersions", []):
            continue
        try:
            authority(store.db, job["actorSubject"])
            catalogue = connector(
                "library",
                job["actorSubject"],
                imports=[{"documentId": version["documentId"], "sha256": version["sha256"]}],
            )
            if not catalogue.get("canWrite"):
                raise ValueError("原件已保存，文件夹同步需要知识库负责人权限")
            path = version["kbPath"]
            if not any(p.get("path") == path for p in catalogue.get("papers", [])):
                pending = version.get("indexStatus") != "ready" and any(
                    p.get("documentId") == version["documentId"]
                    and p.get("sha256") == version["sha256"]
                    and p.get("path") == path
                    and p.get("indexStatus") in ("not_requested", "pending", "failed")
                    for p in catalogue.get("pendingArchives", [])
                )
                if pending:
                    continue
                raise ValueError("知识库论文不可访问，不会恢复已删除资料")
            existing = set(catalogue.get("memberships", {}).get(path, []))
            known = {f["id"] for f in catalogue.get("folders", [])}
            additions = sorted((set(classification["folderIds"]) & known) - existing)
            if additions:
                catalogue = connector(
                    "folderMutation",
                    job["actorSubject"],
                    mutation={
                        "operation": "add",
                        "revision": catalogue["revision"],
                        "paths": [path],
                        "folderIds": additions,
                    },
                )
            removals = sorted(set(classification.get("removedFolderIds", [])) & existing & known)
            if removals:
                connector(
                    "folderMutation",
                    job["actorSubject"],
                    mutation={
                        "operation": "remove",
                        "revision": catalogue["revision"],
                        "paths": [path],
                        "folderIds": removals,
                    },
                )
            classification["syncedVersions"] = classification.get("syncedVersions", []) + [
                version["id"]
            ]
            classification.pop("error", None)
        except Exception as exc:
            classification["error"] = "文件夹分类待同步：" + safe_error(exc)
        store.put("ks_classification", classification)
    store.db.commit()


def schedule_due(db):
    """Only separately opted-in knowledge-source schedules; legacy enabled is ignored."""
    for row in db.query(InformationEntry).filter_by(kind="source").all():
        source = row.data
        schedule = source.get("schedule", {})
        if (
            schedule.get("frequency") not in ("daily", "weekly")
            or not source.get("scheduleSubject")
            or source.get("adapter") != "ich"
        ):
            continue
        due = schedule.get("nextCheckAt")
        if not due or datetime.fromisoformat(due).timestamp() > time.time():
            continue
        store = Store(db, row.tenant)
        if any(j.get("app") == APP and j["sourceId"] == source["id"] for j in store.active_jobs()):
            continue
        try:
            authority(db, source["scheduleSubject"])
        except Exception as exc:
            source["scheduleError"] = safe_error(exc)
            source["schedule"] = {**schedule, "frequency": "off", "nextCheckAt": None}
            store.put("source", source)
            db.commit()
            continue
        job = store.create_job(source["id"], source["scheduleSubject"], app=APP, kind="check")
        job["scheduled"] = True
        store.put("job", job)
        source = store.source(source["id"])
        interval = 86400 if schedule["frequency"] == "daily" else 604800
        source["schedule"] = {**schedule, "nextCheckAt": iso(time.time() + interval)}
        source.pop("scheduleError", None)
        store.put("source", source)
        db.commit()


def scheduled_followup(store, job):
    """Continue an opted-in schedule once; check-only never retrieves PDFs."""
    if (
        not job.get("scheduled")
        or job.get("followupDone")
        or job["status"] not in ("completed", "partial")
    ):
        return
    source = store.source(job["sourceId"])
    schedule = source.get("schedule", {})
    if schedule.get("frequency") not in ("daily", "weekly") or not schedule.get("downloadUpdates"):
        job["followupDone"] = True
        store.put("job", job)
        store.db.commit()
        return
    if any(j.get("app") == APP and j["sourceId"] == source["id"] for j in store.active_jobs()):
        return
    try:
        authority(store.db, job["actorSubject"])
    except Exception as exc:
        source["scheduleError"] = safe_error(exc)
        source["schedule"] = {**schedule, "frequency": "off", "nextCheckAt": None}
        store.put("source", source)
        job["followupDone"] = True
        store.put("job", job)
        store.db.commit()
        return
    docs = [
        d
        for d in store.documents()
        if d["sourceId"] == source["id"] and set(d["scopes"]) & set(source["scopes"])
    ]
    if job["kind"] == "check":
        good = {i["scope"] for i in job["items"] if i["status"] == "saved"}
        docs = [d for d in docs if set(d["scopes"]) & good]
    else:
        good = set(job.get("successfulScopes", source["scopes"]))
        docs = [d for d in docs if set(d["scopes"]) & good]
    versions = store.records("version")
    saved = {v["documentId"] for v in versions}
    verify_ids = [d["id"] for d in docs if d["id"] in saved] if job["kind"] == "check" else []
    verified_ids = (
        {i["documentId"] for i in job["items"] if i.get("documentId") and i["status"] == "saved"}
        if job["kind"] == "verify"
        else set()
    )
    import_ids = [
        d["id"]
        for d in docs
        if (set(d.get("newInScopes", [])) & good and d["id"] not in saved)
        or (
            d["id"] in verified_ids
            and version_state(d, [v for v in versions if v["documentId"] == d["id"]])
            == "update_available"
        )
    ]
    next_job = None
    if verify_ids:
        next_job = store.create_job(
            source["id"], job["actorSubject"], app=APP, kind="verify", document_ids=verify_ids
        )
        next_job.update(scheduled=True, successfulScopes=sorted(good))
    elif import_ids:
        # The source folder was explicitly validated when opting in. The bridge
        # validates it again during each import, and never silently changes it.
        if not source.get("folderId"):
            source["scheduleError"] = "自动下载需要有效的接收文件夹，请重新保存来源设置"
            store.put("source", source)
        else:
            next_job = store.create_job(
                source["id"],
                job["actorSubject"],
                app=APP,
                kind="import",
                document_ids=import_ids,
                folder_id=source["folderId"],
                parse=bool(schedule.get("indexUpdates")),
            )
    if next_job:
        store.put("job", next_job)
    job["followupDone"] = True
    store.put("job", job)
    store.db.commit()


def tick(session_factory=SessionLocal, official_factory=OfficialClient):
    if not settings.KNOWLEDGE_SOURCE_APP_ENABLED or not settings.KNOWLEDGE_SOURCE_WORKER_ENABLED:
        return
    db = session_factory()
    owner = str(uuid4())
    lease = Store(db, "knowledge-source-worker")
    acquired = False
    try:
        acquired = lease.claim_lease(owner)
        if not acquired:
            return
        # Recover a completed scheduled stage if a restart occurred between stage
        # completion and creating its follow-up. The same lease serializes both.
        for row in (
            db.query(InformationEntry)
            .filter(
                InformationEntry.kind == "job",
                InformationEntry.data["app"].as_string() == APP,
                InformationEntry.data["status"].as_string().in_(["completed", "partial"]),
            )
            .all()
        ):
            if row.data.get("scheduled") and not row.data.get("followupDone"):
                scheduled_followup(Store(db, row.tenant), row.data)
        schedule_due(db)
        jobs = (
            db.query(InformationEntry)
            .filter(
                InformationEntry.kind == "job",
                InformationEntry.data["app"].as_string() == APP,
                InformationEntry.data["status"].as_string().in_(["queued", "running"]),
            )
            .order_by(InformationEntry.updated_at)
            .all()
        )
        target = next(
            (
                row
                for row in jobs
                if not any(i["status"] == "pending" for i in row.data["items"])
                or any(
                    i["status"] == "pending" and i.get("nextAttemptAt", 0) <= time.time()
                    for i in row.data["items"]
                )
            ),
            None,
        )
        if target:
            store = Store(db, target.tenant)
            official = official_factory()
            try:
                progress = run_step(
                    store, official, job_id=target.id, connector=bridge.call, app=APP
                )
                if progress:
                    finished = store.get("job", target.id)
                    synchronize_classification(store, finished, bridge.call)
                    scheduled_followup(store, finished)
            finally:
                official.close()
    except Exception:
        db.rollback()
        logger.exception("knowledge-source worker step failed")
    finally:
        if acquired:
            try:
                lease.release_lease(owner)
            except Exception:
                db.rollback()
        db.close()


def start_worker():
    stop = threading.Event()

    def loop():
        while not stop.wait(2):
            tick()

    thread = threading.Thread(target=loop, name="knowledge-source-collector", daemon=True)
    thread.start()
    logger.info("knowledge-source collector started; manual jobs and explicitly opted-in schedules")
    return stop, thread
