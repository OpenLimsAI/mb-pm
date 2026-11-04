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
from app.services.reference_download import ReferenceClient

APP = "knowledge-sources"
logger = logging.getLogger("cmc-pms.knowledge-sources")


def _filing_context(store, subject, connector):
    """Current readable library and metadata, never the first displayed page."""
    from app.api.v1.knowledge_sources import paper_snapshot

    proofs = [
        {"documentId": value["documentId"], "sha256": value["sha256"]}
        for value in store.records("version")
        if value.get("kbPath") and value.get("indexStatus") != "ready"
    ]
    pending = []
    for offset in range(0, max(1, len(proofs)), 5000):
        catalogue = connector("library", subject, imports=proofs[offset : offset + 5000])
        if not catalogue.get("canWrite"):
            raise ValueError("自动归档需要当前知识库写入权限，原件和已完成下载保留")
        pending.extend(catalogue.get("pendingArchives", []))
    catalogue = {**catalogue, "pendingArchives": pending}
    papers = paper_snapshot(store, {"subject": subject}, catalogue)
    metadata, offset = {}, 0
    while True:
        result = connector(
            "queryLibrary", subject, query="", offset=offset, limit=100, sort="recent"
        )
        metadata.update({item["path"]: item for item in result.get("papers", [])})
        following = result.get("nextOffset")
        if following is None:
            break
        if not isinstance(following, int) or following <= offset:
            raise ValueError("知识库元数据分页异常，未执行自动归档")
        offset = following
    return catalogue, [
        {
            **paper,
            **{
                key: value
                for key, value in metadata.get(paper["id"], {}).items()
                if key in {"metadata", "tags", "hash"}
            },
        }
        for paper in papers
    ]


def automatic_filing(store, job, connector=bridge.call):
    """After a committed import batch, apply only its owner's explicit rules.

    Filing has a separate outcome: failure never changes the completed import,
    removes an original, retries a download or restores an old database.
    """
    from app.services.knowledge_source_workspace_v3 import apply_enabled_rules, workspace

    job = store.get("job", job["id"])
    if (
        job.get("kind") != "import"
        or job.get("status") not in {"completed", "partial"}
        or not job.get("filingV3StartedAt")
        or job.get("filingV3Done")
    ):
        return
    subject = job["actorSubject"]
    enabled = [rule for rule in workspace(store, subject)["rules"] if rule.get("enabled")]
    versions = [
        store.get("version", item["versionId"])
        for item in job["items"]
        if item.get("versionId") and item.get("status") == "saved"
    ]
    receipt = {"status": "skipped", "ruleApplications": 0, "undoTokens": [], "results": []}
    if enabled and versions:
        try:
            authority(store.db, subject)
            catalogue, papers = _filing_context(store, subject, connector)
            results = apply_enabled_rules(
                store,
                {"subject": subject, "tenant": store.tenant},
                catalogue=catalogue,
                papers=papers,
                connect=connector,
                paper_ids=["archive:" + value["id"] for value in versions],
            )
            applications = sum(item.get("count", 0) for item in results)
            receipt = {
                "status": "completed"
                if all(item["saved"] for item in results)
                else "partial"
                if applications
                else "failed",
                "ruleApplications": applications,
                "undoTokens": [token for item in results for token in item.get("undoTokens", [])],
                "results": results,
            }
        except Exception as exc:
            store.db.rollback()
            receipt = {**receipt, "status": "failed", "error": "自动归档未完成：" + safe_error(exc)}
    current = store.lock("job", job["id"])
    current.update(filingV3Done=True, ruleFiling={**receipt, "completedAt": iso()})
    store.put("job", current)
    store.db.commit()


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


def tick(
    session_factory=SessionLocal, official_factory=OfficialClient, reference_factory=ReferenceClient
):
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
            if row.data.get("filingV3StartedAt") and not row.data.get("filingV3Done"):
                automatic_filing(Store(db, row.tenant), row.data, bridge.call)
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
            current = store.lock("job", target.id)
            if current.get("kind") == "import" and not current.get("filingV3StartedAt"):
                current["filingV3StartedAt"] = iso()
                store.put("job", current)
            db.commit()
            if current.get("kind") == "manual-index":
                from app.services.knowledge_source_manual_index_v3 import (
                    run_step as manual_index_step,
                )

                progress = manual_index_step(store, target.id, connector=bridge.call)
                if progress:
                    finished = store.get("job", target.id)
                    if finished["status"] == "completed":
                        synchronize_classification(store, finished, bridge.call)
                return
            source = store.source(target.data["sourceId"])
            official = (
                reference_factory() if source["adapter"] == "reference" else official_factory()
            )
            try:
                progress = run_step(
                    store, official, job_id=target.id, connector=bridge.call, app=APP
                )
                if progress:
                    finished = store.get("job", target.id)
                    automatic_filing(store, finished, bridge.call)
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
