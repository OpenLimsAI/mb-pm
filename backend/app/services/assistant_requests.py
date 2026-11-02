"""Owned durable assistant requests, cross-instance dispatch and fenced completion."""

import hashlib
import json
import logging
import re
from contextlib import nullcontext
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from threading import Event, Thread
from time import monotonic
from uuid import uuid4

from fastapi import HTTPException
from fastapi.encoders import jsonable_encoder
from sqlalchemy import func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker

from app.core.config import settings
from app.db.session import SessionLocal
from app.models.assistant import AssistantMessage, AssistantRequest, AssistantTask
from app.schemas.assistant import TaskQuestion
from app.services import assistant_diagnostics as diagnostics

LOGGER = logging.getLogger("cmc-pms.assistant-worker")
CURRENT = ContextVar("assistant_request_execution", default=None)
BUSY = "任务已有问题正在处理，请等待当前回答完成。"
INTERRUPTED = "本次生成已中断，问题已保存，请重新发送。"
TERMINAL = {"completed", "failed"}


@dataclass
class Execution:
    job_id: str
    token: str
    factory: object
    stop: object = None
    last_write: float = 0
    lease_seconds: int = 45
    last_stage: str = ""


def now():
    return datetime.now(UTC)


def active_id():
    current = CURRENT.get()
    return current.job_id if current else None


def fingerprint(payload):
    value = payload.model_dump(mode="json", exclude={"revision"})
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, ensure_ascii=False).encode()
    ).hexdigest()


def _scope_access(db, claims, task, job):
    from app.services import assistant, assistant_projects, solution_knowledge

    assistant.check_history_access(
        db,
        claims,
        db.scalars(select(AssistantMessage).where(AssistantMessage.task_id == task.id)).all(),
    )
    scope = job.application_scope or {}
    used = scope.get("used_sources", [])
    if "projects" in used:
        assistant_projects.check_saved(db, claims, [scope])
    if "knowledge" in used:
        solution_knowledge.check_access(claims)


def view(db, claims, task, job):
    _scope_access(db, claims, task, job)
    payload = job.payload
    return jsonable_encoder(
        {
            "request_id": job.request_id,
            "task_id": job.task_id,
            "status": job.status,
            "stage": job.stage,
            "partial_content": job.partial_content if job.status == "running" else "",
            "error": job.error,
            "diagnostic_id": job.diagnostic_id,
            "question": payload["question"],
            "context": payload.get("context", ""),
            "requested_mode": payload.get("answer_mode"),
            "data_sources": payload.get("data_sources", []),
            "model_profile_id": payload.get("model_profile_id"),
            "created_at": job.created_at,
            "updated_at": job.updated_at,
        }
    )


def recover_expired(db, task_id=None):
    point = now()
    condition = or_(
        (AssistantRequest.status == "running") & (AssistantRequest.lease_until < point),
        (AssistantRequest.status == "queued")
        & (AssistantRequest.created_at < point - timedelta(minutes=10)),
    )
    if task_id:
        condition &= AssistantRequest.task_id == task_id
    rows = db.scalars(select(AssistantRequest).where(condition)).all()
    for job in rows:
        changed = db.execute(
            update(AssistantRequest)
            .execution_options(synchronize_session=False)
            .where(
                AssistantRequest.id == job.id,
                AssistantRequest.status == job.status,
                AssistantRequest.worker_token == job.worker_token,
                condition,
            )
            .values(
                status="failed",
                stage="failed",
                error=INTERRUPTED,
                error_code="request_interrupted",
                partial_content="",
                lease_until=None,
                finished_at=point,
                updated_at=point,
            )
        )
        if changed.rowcount:
            db.execute(
                update(AssistantTask)
                .where(
                    AssistantTask.id == job.task_id,
                    AssistantTask.active_request_id == job.id,
                )
                .values(active_request_id=None)
            )
    db.commit()


def get(db, claims, task_id, request_id):
    from app.services import assistant

    task = assistant.get_task(db, task_id, claims)
    recover_expired(db, task_id)
    db.refresh(task)
    job = db.scalar(
        select(AssistantRequest).where(
            AssistantRequest.task_id == task.id,
            AssistantRequest.request_id == request_id,
        )
    )
    if job is None:
        raise HTTPException(404, "本次请求不存在")
    result = view(db, claims, task, job)
    db.rollback()
    return result


def get_active(db, claims, task_id):
    from app.services import assistant

    task = assistant.get_task(db, task_id, claims)
    recover_expired(db, task_id)
    db.refresh(task)
    job = db.scalar(
        select(AssistantRequest)
        .where(
            AssistantRequest.task_id == task.id,
            AssistantRequest.status.in_(["queued", "running"]),
        )
        .order_by(AssistantRequest.created_at.desc())
    )
    result = {"request": view(db, claims, task, job) if job else None}
    db.rollback()
    return result


def submit(db, claims, task, payload, *, inline=False):
    from app.services import assistant

    task_id = task.id
    recover_expired(db, task_id)
    task = assistant.get_task(db, task_id, claims)
    old = db.scalar(
        select(AssistantRequest).where(
            AssistantRequest.task_id == task_id,
            AssistantRequest.request_id == str(payload.request_id),
        )
    )
    digest = fingerprint(payload)
    if old:
        if old.fingerprint != digest:
            raise HTTPException(409, "该请求已使用不同内容，请保留输入后重新发送")
        result = view(db, claims, task, old)
        db.rollback()
        return old.id, None, result
    assistant.active(task)
    assistant.check_history_access(
        db,
        claims,
        db.scalars(select(AssistantMessage).where(AssistantMessage.task_id == task_id)).all(),
    )
    replay = assistant.completed_request(db, task, payload, claims)
    if not replay and task.revision != payload.revision:
        raise HTTPException(409, assistant.CONFLICT)
    if not replay and task.active_request_id is not None:
        raise HTTPException(409, BUSY)
    count = db.scalar(
        select(func.count())
        .select_from(AssistantRequest)
        .join(AssistantTask)
        .where(
            AssistantTask.issuer == claims["iss"],
            AssistantTask.owner_id == claims["sub"],
            AssistantRequest.status.in_(["queued", "running"]),
        )
    )
    if not replay and count >= 3:
        raise HTTPException(429, "已有多项问题正在处理，请稍后再提交")
    queued = db.scalar(
        select(func.count())
        .select_from(AssistantRequest)
        .where(AssistantRequest.status == "queued")
    )
    if not replay and queued >= 100:
        raise HTTPException(429, "当前等待的问题较多，请稍后再提交")
    point, job_id = now(), uuid4().hex
    token = uuid4().hex if inline and not replay else ""
    job = AssistantRequest(
        id=job_id,
        task_id=task_id,
        request_id=str(payload.request_id),
        payload=payload.model_dump(mode="json"),
        fingerprint=digest,
        status="completed" if replay else "running" if inline else "queued",
        stage="completed" if replay else "waiting_model" if inline else "queued",
        worker_token=token,
        started_at=point if token else None,
        lease_until=point + timedelta(seconds=settings.ASSISTANT_REQUEST_TOTAL_SECONDS + 30)
        if token
        else None,
        finished_at=point if replay else None,
    )
    if not replay:
        changed = db.execute(
            update(AssistantTask)
            .where(
                AssistantTask.id == task_id,
                assistant.owned(claims),
                AssistantTask.revision == payload.revision,
                AssistantTask.deleted_at.is_(None),
                AssistantTask.active_request_id.is_(None),
            )
            .values(active_request_id=job_id)
        )
        if changed.rowcount != 1:
            db.rollback()
            raise HTTPException(409, BUSY)
    db.add(job)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        return submit(db, claims, assistant.get_task(db, task_id, claims), payload, inline=inline)
    result = view(db, claims, task, job)
    db.rollback()
    return job_id, token or None, result


def claim(db, job_id=None):
    point = now()
    query = select(AssistantRequest.id).where(AssistantRequest.status == "queued")
    if job_id:
        query = query.where(AssistantRequest.id == job_id)
    selected = db.scalar(query.order_by(AssistantRequest.created_at).limit(1))
    if selected is None:
        db.rollback()
        return None
    token = uuid4().hex
    changed = db.execute(
        update(AssistantRequest)
        .execution_options(synchronize_session=False)
        .where(
            AssistantRequest.id == selected,
            AssistantRequest.status == "queued",
        )
        .values(
            status="running",
            stage="waiting_model",
            worker_token=token,
            started_at=point,
            lease_until=point + timedelta(seconds=settings.ASSISTANT_REQUEST_LEASE_SECONDS),
            updated_at=point,
        )
    )
    db.commit()
    return (selected, token) if changed.rowcount == 1 else None


def progress(**fields):
    execution = CURRENT.get()
    if not execution:
        return
    if execution.stop and execution.stop.is_set():
        raise HTTPException(409, INTERRUPTED)
    force = bool(fields.get("application_scope")) or bool(
        fields.get("stage") and fields["stage"] != execution.last_stage
    )
    if not force and monotonic() - execution.last_write < 1:
        return
    values = {
        "updated_at": now(),
        "lease_until": now() + timedelta(seconds=execution.lease_seconds),
    }
    if fields.get("stage") in {"waiting_model", "generating", "saving"}:
        values["stage"] = fields["stage"]
    if "partial_content" in fields:
        text = fields["partial_content"]
        if not isinstance(text, str) or len(text) > 80000:
            raise HTTPException(422, "本次回答过长，请缩小分析范围")
        values["partial_content"] = text
    if "application_scope" in fields:
        values["application_scope"] = fields["application_scope"]
    with execution.factory() as db:
        changed = db.execute(
            update(AssistantRequest)
            .execution_options(synchronize_session=False)
            .where(
                AssistantRequest.id == execution.job_id,
                AssistantRequest.status == "running",
                AssistantRequest.worker_token == execution.token,
                AssistantRequest.lease_until > now(),
            )
            .values(**values)
        )
        if changed.rowcount != 1:
            db.rollback()
            raise HTTPException(409, INTERRUPTED)
        db.commit()
    execution.last_write = monotonic()
    if "stage" in fields:
        execution.last_stage = fields["stage"]


def complete(db):
    execution = CURRENT.get()
    if not execution:
        return
    changed = db.execute(
        update(AssistantRequest)
        .execution_options(synchronize_session=False)
        .where(
            AssistantRequest.id == execution.job_id,
            AssistantRequest.status == "running",
            AssistantRequest.worker_token == execution.token,
            AssistantRequest.lease_until > now(),
        )
        .values(
            status="completed",
            stage="completed",
            partial_content="",
            lease_until=None,
            updated_at=now(),
            finished_at=now(),
        )
    )
    if changed.rowcount != 1:
        raise HTTPException(409, INTERRUPTED)


def fail(db, job_id, token, error, status=503, code="request_failed", diagnostic_id=""):
    job = db.get(AssistantRequest, job_id)
    if not job:
        return
    changed = db.execute(
        update(AssistantRequest)
        .execution_options(synchronize_session=False)
        .where(
            AssistantRequest.id == job_id,
            AssistantRequest.status == "running",
            AssistantRequest.worker_token == token,
        )
        .values(
            status="failed",
            stage="failed",
            partial_content="",
            error=error[:1000],
            error_status=status,
            error_code=code,
            diagnostic_id=diagnostic_id,
            lease_until=None,
            finished_at=now(),
            updated_at=now(),
        )
    )
    if changed.rowcount:
        db.execute(
            update(AssistantTask)
            .where(
                AssistantTask.id == job.task_id,
                AssistantTask.active_request_id == job_id,
            )
            .values(active_request_id=None)
        )
    db.commit()


def execute(job_id, token, *, factory=SessionLocal, stop=None, streaming=True):
    from app.services import assistant, assistant_generation

    with factory() as db:
        job = db.get(AssistantRequest, job_id)
        if not job or job.status != "running" or job.worker_token != token:
            return
        task = db.get(AssistantTask, job.task_id)
        if task is None or task.active_request_id != job_id:
            fail(db, job_id, token, INTERRUPTED, 409)
            return
        payload = TaskQuestion.model_validate(job.payload)
        claims = {"iss": task.issuer, "sub": task.owner_id, "owner": settings.CASDOOR_ORG}
        db.rollback()
        execution = Execution(
            job_id,
            token,
            factory,
            stop,
            lease_seconds=settings.ASSISTANT_REQUEST_LEASE_SECONDS
            if streaming
            else settings.ASSISTANT_REQUEST_TOTAL_SECONDS + 30,
        )
        context_token = CURRENT.set(execution)
        existing = diagnostics.CURRENT.get()
        scope = nullcontext(existing) if existing else diagnostics.request_scope(payload.request_id)
        try:
            with scope as trace:
                db.execute(
                    update(AssistantRequest)
                    .execution_options(synchronize_session=False)
                    .where(AssistantRequest.id == job_id, AssistantRequest.worker_token == token)
                    .values(diagnostic_id=trace.id)
                )
                db.commit()
                context = (
                    assistant_generation.run_context(
                        lambda update: progress(**update),
                        budget_seconds=settings.ASSISTANT_REQUEST_TOTAL_SECONDS,
                    )
                    if streaming
                    else nullcontext()
                )
                with context:
                    assistant.question(db, claims, assistant.get_task(db, task.id, claims), payload)
        except HTTPException as exc:
            db.rollback()
            error = exc.detail if isinstance(exc.detail, str) else "本次回答未完成，问题已保存。"
            fail(
                db,
                job_id,
                token,
                error,
                exc.status_code,
                (exc.headers or {}).get(diagnostics.ERROR_HEADER, "request_failed"),
                trace.id,
            )
        except Exception:
            db.rollback()
            fail(
                db,
                job_id,
                token,
                "本次回答未完成，问题已保存。请稍后重试。",
                503,
                "unexpected_error",
                existing.id if existing else "",
            )
        finally:
            CURRENT.reset(context_token)


def run_inline(db, claims, task, payload):
    from app.services import assistant

    job_id, token, state = submit(db, claims, task, payload, inline=True)
    if token:
        factory = sessionmaker(bind=db.get_bind(), autoflush=False)
        # Keep legacy synchronous clients compatible; new browser clients use durable polling.
        execute(job_id, token, factory=factory, streaming=False)
    db.expire_all()
    job = db.get(AssistantRequest, job_id)
    if job.status == "completed":
        return assistant.detail(db, assistant.get_task(db, task.id, claims), claims)
    if job.status == "failed":
        raise HTTPException(
            job.error_status,
            re.sub(r"（诊断编号：[a-f0-9]{32}）", "", job.error),
            headers={diagnostics.ERROR_HEADER: job.error_code},
        )
    raise HTTPException(409, BUSY)


def start_worker():
    stop = Event()

    def work():
        while not stop.is_set():
            try:
                with SessionLocal() as db:
                    recover_expired(db)
                    chosen = claim(db)
                if chosen:
                    execute(*chosen, stop=stop)
                    continue
            except Exception:
                LOGGER.error("assistant worker dispatch failed; queued requests retained")
            stop.wait(1)

    thread = Thread(target=work, name="assistant-requests", daemon=True)
    thread.start()
    LOGGER.info("assistant request worker started")
    return stop, thread
