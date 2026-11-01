"""Only explicitly created knowledge-source jobs run; retired monitors never resume."""

import logging
import threading
import time
from uuid import uuid4

from app.core.config import settings
from app.db.session import SessionLocal
from app.models.information import InformationEntry
from app.services.information import bridge
from app.services.information.ich import OfficialClient
from app.services.information.store import Store
from app.services.information.worker import authority, run_step, safe_error

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
            catalogue = connector("library", job["actorSubject"])
            if not catalogue.get("canWrite"):
                raise ValueError("原件已保存，文件夹同步需要知识库负责人权限")
            path = version["kbPath"]
            if not any(p.get("path") == path for p in catalogue.get("papers", [])):
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
                    synchronize_classification(store, store.get("job", target.id), bridge.call)
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
    logger.info("knowledge-source collector started; manual jobs only")
    return stop, thread
