"""Restartable one-file-at-a-time worker with a DB lease shared by both PM instances."""

import base64
import copy
import logging
import threading
import time
from uuid import uuid4

import httpx
from fastapi import HTTPException

from app.core.config import settings
from app.db.session import SessionLocal
from app.models.information import InformationEntry
from app.services import iam_admin, password_policy
from app.services.information import bridge
from app.services.information.extract import extract_pdf
from app.services.information.ich import SCOPE_SLUGS, OfficialClient
from app.services.information.store import Store, iso

logger = logging.getLogger("cmc-pms.information")
MANAGERS = {"admin", "kb_manager"}


def active_account(subject):
    account = iam_admin.get_user_by_sub(subject)
    if account.get("isForbidden") or account.get("isDeleted"):
        raise HTTPException(403, "IAM 账号已停用，任务已停止")
    return account


def can_manage(account):
    return any(
        isinstance(r, dict)
        and r.get("owner") == settings.CASDOOR_ORG
        and r.get("name") in MANAGERS
        and r.get("isEnabled", True) is True
        for r in account.get("roles", [])
    )


def authority(db, subject):
    if not can_manage(active_account(subject)) or password_policy.change_required(db, subject):
        raise HTTPException(403, "任务负责人的权限已失效或须修改密码，请由负责人重新操作")


def safe_error(exc):
    if isinstance(exc, HTTPException):
        return str(exc.detail)[:500]
    if isinstance(exc, httpx.HTTPStatusError):
        return f"官方服务 HTTP {exc.response.status_code}，请稍后重试"
    if isinstance(exc, httpx.TimeoutException):
        return "官方网站连接超时，不能判断没有更新"
    if isinstance(exc, httpx.HTTPError):
        return "无法连接官方网站，请检查网络后重试"
    if isinstance(exc, ValueError):
        return str(exc)[:500]
    return "后台处理失败，原文和已完成结果保留，请联系管理员查看运行记录"


def run_step(store, official, *, extract=extract_pdf, connector=bridge.call, job_id=None, app=None):
    """The caller holds the global lease. Commit after every scope/file; closing UI has no effect."""
    db = store.db
    jobs = [
        j
        for j in store.active_jobs()
        if j["status"] in ("queued", "running") and j.get("app") == app
    ]
    if not jobs:
        return False
    job = next((j for j in jobs if j["id"] == job_id), None) if job_id else jobs[0]
    if job is None:
        return False
    jobid = job["id"]
    try:
        authority(db, job["actorSubject"])
    except Exception as exc:
        job["status"] = "paused"
        job["error"] = safe_error(exc)
        store.put("job", job)
        db.commit()
        return True
    pending = next(
        (
            i
            for i in job["items"]
            if i["status"] == "pending" and i.get("nextAttemptAt", 0) <= time.time()
        ),
        None,
    )
    if pending is None:
        if any(i["status"] == "pending" for i in job["items"]):
            return False
        complete_job(store, job)
        db.commit()
        return True
    job["status"] = "running"
    job["updatedAt"] = iso()
    store.put("job", job)
    db.commit()
    item = copy.deepcopy(pending)
    try:
        if job["kind"] in ("check", "monitor"):
            scope = item["scope"]
            documents = official.catalogue(scope)
            store.apply_catalogue(job["sourceId"], scope, documents)
            item.update(status="saved", count=len(documents), error=None)
        else:
            doc = store.get("document", item["documentId"])
            if item.get("phase") == "index" and item.get("versionId"):
                version = store.get("version", item["versionId"])
                content = b""
            else:
                content = official.pdf(doc["url"])
                version = store.archive(doc["id"], content)
                db.commit()
            item["versionId"] = version["id"]
            text = version.get("text", "")
            try:
                if not text:
                    text = extract(store.archive_path(version))
                    version.update(text=text, parseStatus="ready", error=None)
                    store.put("version", version)
                    store.describe_version_change(version)
                    db.commit()
                if job.get("folderId"):
                    if (
                        item.get("phase") == "index"
                        and version.get("kbTaskId")
                        and version.get("indexStatus") != "failed"
                    ):
                        reply = connector(
                            "status",
                            job["actorSubject"],
                            documentId=doc["id"],
                            sha256=version["sha256"],
                            taskId=version["kbTaskId"],
                        )
                    else:
                        reply = connector(
                            "import",
                            job["actorSubject"],
                            folderId=job["folderId"],
                            title=doc["title"],
                            documentId=doc["id"],
                            versionId=version["id"],
                            sha256=version["sha256"],
                            sourceUrl=doc["url"],
                            originalBase64=base64.b64encode(
                                content or store.archive_path(version).read_bytes()
                            ).decode("ascii"),
                            text=text,
                            parse=job["parse"],
                            scopes=doc["scopes"],
                            officialStatus=doc.get("officialStatus", ""),
                        )
                    version.update(
                        indexStatus=reply.get("indexStatus", "pending"),
                        kbPath=reply.get("path", version.get("kbPath")),
                        kbTaskId=reply.get("taskId", version.get("kbTaskId")),
                        kbUrl=reply.get("url", version.get("kbUrl")),
                    )
                    if reply.get("error") or version["indexStatus"] == "failed":
                        raise ValueError(reply.get("error") or "Knowledge indexing failed")
                    if job["parse"] and version["indexStatus"] == "pending":
                        item.update(
                            status="pending",
                            phase="index",
                            nextAttemptAt=time.time() + 5,
                            error=None,
                        )
                    else:
                        item.update(status="saved", error=None)
                else:
                    version["indexStatus"] = "not_requested"
                    item.update(status="saved", error=None)
                version["error"] = None
            except Exception as exc:
                if not text:
                    version["parseStatus"] = "failed"
                elif job.get("folderId"):
                    version["indexStatus"] = "failed"
                version["error"] = safe_error(exc)
                item.update(status="failed", error=version["error"])
            store.put("version", version)
            doc = store.get("document", doc["id"])
            doc["folderIds"] = sorted(
                set(doc.get("folderIds", []) + [job.get("folderId") or "information-archive"])
            )
            doc["status"] = "ready" if version["indexStatus"] == "ready" else "archived"
            doc["error"] = version.get("error")
            store.put("document", doc)
        db.commit()
    except Exception as exc:
        db.rollback()
        item.update(status="failed", error=safe_error(exc))
        transient = isinstance(exc, httpx.TimeoutException | httpx.NetworkError) or (
            isinstance(exc, httpx.HTTPStatusError)
            and exc.response.status_code in (429, 500, 502, 503, 504)
        )
        attempts = item.get("attempts", 0) + 1
        item["attempts"] = attempts
        if transient and attempts < 3:
            item.update(status="pending", nextAttemptAt=time.time() + 15 * (2 ** (attempts - 1)))
    # Re-read control state so a pause/cancel made during network I/O is never overwritten.
    current = store.lock("job", jobid)
    index = next(
        i
        for i, v in enumerate(current["items"])
        if v.get("documentId", v.get("scope")) == item.get("documentId", item.get("scope"))
    )
    current["items"][index] = item
    current["processed"] = sum(
        i["status"] in ("saved", "failed", "skipped") for i in current["items"]
    )
    current["saved"] = sum(
        bool(i.get("versionId")) or i["status"] == "saved" for i in current["items"]
    )
    current["failed"] = sum(i["status"] == "failed" for i in current["items"])
    current["pending"] = sum(i["status"] == "pending" for i in current["items"])
    current["updatedAt"] = iso()
    if current["pending"] == 0 and current["status"] not in ("paused", "cancelled"):
        complete_job(store, current)
    else:
        store.put("job", current)
    db.commit()
    return True


def complete_job(store, job):
    job["status"] = (
        "partial" if job["failed"] and job["saved"] else "failed" if job["failed"] else "completed"
    )
    job["finishedAt"] = iso()
    job["error"] = f'{job["failed"]} 项未完成，请查看逐项原因后重试' if job["failed"] else None
    if job["kind"] in ("check", "monitor"):
        statuses = {
            i["scope"]: {
                "status": "ok" if i["status"] == "saved" else "error",
                "count": i.get("count", 0),
                "url": "https://www.ich.org/page/" + SCOPE_SLUGS[i["scope"]] + "-guidelines",
                "error": i.get("error"),
                "lastSuccessAt": iso()
                if i["status"] == "saved"
                else store.source(job["sourceId"])
                .get("scopeStatus", {})
                .get(i["scope"], {})
                .get("lastSuccessAt"),
            }
            for i in job["items"]
        }
        store.finish_check(job["sourceId"], statuses)
        job["scopeStatus"] = statuses
    else:
        # Stable event identity makes completion/retry of this batch idempotent.
        eventid = store.key("event", "batch:" + job["id"])
        store.put(
            "event",
            {
                "id": eventid,
                "kind": "收录汇总",
                "title": f'批量收录：已保存 {job["saved"]} / {job["total"]} 份',
                "sourceId": job["sourceId"],
                "createdAt": iso(),
                "summary": f'失败 {job["failed"]} 份；归档、解析及索引分别记录。',
                "read": False,
            },
        )
    store.put("job", job)
    if job["kind"] == "monitor":
        source = store.source(job["sourceId"])
        docs = [
            d["id"]
            for d in store.documents()
            if d["sourceId"] == source["id"] and set(d["scopes"]) & set(source["scopes"])
        ]
        if docs and source.get("enabled"):
            store.create_job(
                source["id"],
                job["actorSubject"],
                kind="import",
                document_ids=docs,
                folder_id=None
                if source.get("folderId") == "information-archive"
                else source.get("folderId"),
                parse=source.get("parse", False),
            )


def tick(session_factory=SessionLocal, official_factory=OfficialClient):
    if not settings.INFORMATION_APP_ENABLED:
        return
    db = session_factory()
    owner = str(uuid4())
    store = Store(db, "worker")
    acquired = False
    try:
        acquired = store.claim_lease(owner)
        if not acquired:
            return
        rows = db.query(InformationEntry).filter_by(kind="source").all()
        for row in rows:
            source = row.data
            if (
                source.get("enabled")
                and source.get("nextCheckAt", 0) <= time.time()
                and source.get("managerSubject")
            ):
                current = Store(db, row.tenant)
                if not any(
                    j["status"] in ("queued", "running", "paused") and j["sourceId"] == source["id"]
                    for j in current.records("job")
                ):
                    current.create_job(source["id"], source["managerSubject"], kind="monitor")
                    db.commit()
        jobs = (
            db.query(InformationEntry)
            .filter(
                InformationEntry.kind == "job",
                InformationEntry.data["status"].as_string().in_(["queued", "running"]),
            )
            .order_by(InformationEntry.updated_at)
            .all()
        )
        target = next(
            (
                j
                for j in jobs
                if j.data["status"] in ("queued", "running")
                and (
                    not any(i["status"] == "pending" for i in j.data["items"])
                    or any(
                        i["status"] == "pending" and i.get("nextAttemptAt", 0) <= time.time()
                        for i in j.data["items"]
                    )
                )
            ),
            None,
        )
        if target:
            official = official_factory()
            try:
                run_step(Store(db, target.tenant), official, job_id=target.id)
            finally:
                official.close()
    except Exception:
        db.rollback()
        logger.exception("information worker tick failed")
    finally:
        if acquired:
            try:
                store.release_lease(owner)
            except Exception:
                db.rollback()
        db.close()


def start_worker():
    stop = threading.Event()

    def loop():
        while not stop.wait(2):
            tick()

    thread = threading.Thread(target=loop, name="information-collector", daemon=True)
    thread.start()
    return stop, thread
