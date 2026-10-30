"""Canonical private notes + durable, opt-in Wisdom projection.

A single PostgreSQL advisory lock serializes workers across app/app-direct. Remote
operations are recorded before submission, resumed by task ID/digest after restart,
and never blindly resubmitted after an ambiguous timeout. Each revision has its own
path. The previous path is deleted from Core's index before publishing a new one.
"""

import hashlib
import json
import logging
import threading
import time
from urllib.parse import urlsplit
from uuid import uuid4

import httpx
from fastapi import HTTPException
from sqlalchemy import select, text, update
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.session import engine
from app.models.note import NoteWisdomSync, PersonalNote
from app.services import accounts

log = logging.getLogger(__name__)
LOCK = 718035129


def configured():
    url = urlsplit(settings.NOTES_WISDOM_CORE_URL)
    return bool(
        url.scheme in {"http", "https"}
        and url.hostname
        and not url.username
        and not url.password
        and not url.query
        and not url.fragment
        and url.path in {"", "/"}
        and settings.NOTES_WISDOM_TOKEN
    )


def require_editor(subject):
    if not accounts.live_roles(subject) & {"kb_editor", "kb_manager"}:
        raise HTTPException(403, "只有知识库编辑者可以共享到知识库检索")


def summary(row):
    if not row:
        return {"enabled": False, "status": "private", "error": ""}
    return {"enabled": row.enabled, "status": row.status, "error": row.error}


def enqueue(db, note_id, revision):
    # Same transaction as the canonical content/revision change. No network here.
    db.execute(
        update(NoteWisdomSync)
        .where(NoteWisdomSync.note_id == note_id)
        .values(desired_revision=revision, status="pending", next_attempt_at=0, error="")
    )


class TaskFailedError(RuntimeError):
    pass


class Core:
    def request(self, method, path, **kwargs):
        if not configured():
            raise RuntimeError("connection not configured")
        with httpx.Client(timeout=15, follow_redirects=False, trust_env=False) as client:
            response = client.request(
                method,
                settings.NOTES_WISDOM_CORE_URL.rstrip("/") + path,
                headers={"Authorization": "Bearer " + settings.NOTES_WISDOM_TOKEN},
                **kwargs,
            )
            response.raise_for_status()
            return response.json()

    def find(self, operation):
        # Full cursor traversal; never assume the first 100 tasks are complete.
        cursor = None
        for _ in range(1000):
            page = self.request(
                "GET",
                "/v1/tasks",
                params={
                    "op": operation["op"],
                    "limit": 1000,
                    **({"cursor": cursor} if cursor else {}),
                },
            )
            for task in page["tasks"]:
                if task["params_digest"] == operation["digest"]:
                    return task["task_id"]
            if not page["has_more"]:
                return None
            next_cursor = page["next_cursor"]
            if not next_cursor or next_cursor == cursor:
                raise RuntimeError("invalid task cursor")
            cursor = next_cursor
        raise RuntimeError("task catalogue too large")

    def exists(self, path):
        try:
            page = self.request("GET", "/v1/base/pages/" + path)
            if page.get("path") != path:
                raise RuntimeError("page identity mismatch")
            return True
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 404:
                return False
            raise

    def submit(self, operation):
        path = "/v1/base/wisdom" if operation["action"] == "publish" else "/v1/base/delete"
        result = self.request("POST", path, json=operation["payload"])
        if result.get("op") != operation["op"] or not isinstance(result.get("task_id"), str):
            raise RuntimeError("invalid task handle")
        return result["task_id"]

    def poll(self, operation):
        task_id = operation["task_id"]
        if (
            not isinstance(task_id, str)
            or not task_id
            or any(
                c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"
                for c in task_id
            )
        ):
            raise RuntimeError("invalid task id")
        task = self.request("GET", f"/v1/tasks/{task_id}")
        if task.get("task_id") != task_id or task.get("op") != operation["op"]:
            raise RuntimeError("task identity mismatch")
        if task.get("status") in {"pending", "running"}:
            return False
        task = self.request("GET", f"/v1/tasks/{task_id}/result")
        result = task.get("result") or {}
        if task.get("status") != "succeeded" or result.get("path") != operation["path"]:
            raise TaskFailedError("remote task failed")
        if operation["action"] == "publish" and result.get("chunks_pending_embedding", 0):
            raise TaskFailedError("embedding incomplete")
        return True


def make_operation(row, note, action):
    slug = f"mberp-note-{note.id}-r{note.revision}-{uuid4()}"
    path = row.published_path if action == "delete" else f"wisdom/{slug}.md"
    if not path.startswith(f"wisdom/mberp-note-{note.id}-r") or not path.endswith(".md"):
        raise RuntimeError("invalid projection path")
    params = (
        {"slug": slug, "author": None, "no_embed": False} if action == "publish" else {"path": path}
    )
    payload = {
        "slug": slug,
        "title": note.title,
        "body": note.content,
        "status": "published",
        "extras": {"mberp_note": note.id, "revision": note.revision},
    }
    if action == "delete":
        payload = {"path": path, "reason": "统一笔记已修改、撤销共享或移至回收站"}
    return {
        "action": action,
        "op": "wisdom.write" if action == "publish" else "delete",
        "revision": note.revision,
        "path": path,
        "payload": payload,
        "digest": hashlib.sha256(
            json.dumps(params, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()[:16],
    }


def run_step(db, core=None):
    """Caller holds the worker lock across commits. Each step does one remote request."""
    core = core or Core()
    row = db.scalar(
        select(NoteWisdomSync)
        .where(
            NoteWisdomSync.status.in_(["pending", "error"]),
            NoteWisdomSync.next_attempt_at <= time.time(),
        )
        .order_by(NoteWisdomSync.next_attempt_at)
        .limit(1)
    )
    if not row:
        return False
    try:
        note = db.get(PersonalNote, row.note_id)
        if not note:
            raise RuntimeError("canonical note missing")
        operation = json.loads(row.operation) if row.operation else None
        if not operation:
            if row.published_path and (
                note.deleted_at or not row.enabled or row.synced_revision != note.revision
            ):
                operation = make_operation(row, note, "delete")
            elif not row.published_path and row.enabled and not note.deleted_at:
                require_editor(note.owner_id)
                operation = make_operation(row, note, "publish")
            else:
                db.execute(
                    update(NoteWisdomSync)
                    .where(
                        NoteWisdomSync.note_id == row.note_id,
                        NoteWisdomSync.desired_revision == note.revision,
                    )
                    .values(
                        synced_revision=note.revision,
                        status="synced" if row.published_path else "private",
                        error="",
                        attempts=0,
                    )
                )
                db.commit()
                return True
            # Durable intent precedes the remote side effect. On a crash/timeout
            # the next step searches Core's persistent task log instead of retrying POST.
            row.operation = json.dumps(operation)
            db.commit()
            operation["task_id"] = core.submit(operation)
            row.operation = json.dumps(operation)
        elif not operation.get("task_id"):
            task_id = core.find(operation)
            if not task_id:
                raise RuntimeError("submission not confirmed; no automatic duplicate")
            operation["task_id"] = task_id
            row.operation = json.dumps(operation)
        elif core.poll(operation):
            row.published_path = operation["path"] if operation["action"] == "publish" else ""
            if operation["action"] == "publish":
                row.synced_revision = operation["revision"]
            row.operation = ""
        row.status = "pending"
        row.error = ""
        row.next_attempt_at = time.time() + 2
        db.commit()
    except TaskFailedError:
        # A terminal task can be reconciled safely. A failed publish may have
        # indexed part of its content; remove that exact attempt before retrying.
        if core.exists(operation["path"]):
            row.published_path = operation["path"]
            row.synced_revision = 0
        else:
            row.published_path = ""
        row.operation = ""
        row.status = "error"
        row.error = "索引任务未完成，后台将重建检索副本；笔记正文已保存。"
        row.next_attempt_at = time.time() + 30
        db.commit()
    except Exception:
        # Generic safe text: no remote payload, token, subject or note body in logs/UI.
        db.rollback()
        row = db.get(NoteWisdomSync, row.note_id)
        row.attempts += 1
        row.status = "error"
        row.error = "检索同步尚未完成，后台会继续核对；笔记正文已保存。"
        row.next_attempt_at = time.time() + min(300, 2 ** min(row.attempts, 8))
        db.commit()
        log.warning("Note projection pending reconciliation")
    return True


def start_worker():
    stop = threading.Event()

    def loop():
        while not stop.is_set():
            try:
                with engine.connect() as connection:
                    postgres = connection.dialect.name == "postgresql"
                    locked = (
                        not postgres
                        or connection.execute(
                            text("SELECT pg_try_advisory_lock(:key)"), {"key": LOCK}
                        ).scalar()
                    )
                    connection.commit()
                    if locked:
                        try:
                            with Session(bind=connection) as db:
                                run_step(db)
                        finally:
                            if postgres:
                                connection.execute(
                                    text("SELECT pg_advisory_unlock(:key)"), {"key": LOCK}
                                )
                                connection.commit()
            except Exception:
                log.warning("Note projection worker unavailable; retrying")
            stop.wait(2)

    worker = threading.Thread(target=loop, name="note-wisdom-sync", daemon=True)
    worker.start()
    return stop, worker
