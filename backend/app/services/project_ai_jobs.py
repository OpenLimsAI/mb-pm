"""Database-claimed jobs survive navigation; workers never store model credentials."""

import logging
import os
import threading
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import update
from sqlalchemy.orm.attributes import set_committed_value

from app.core.config import settings
from app.core.security import ROLE_PRIORITY
from app.db.session import SessionLocal
from app.models import IAMIdentity, Project, ProjectAIAnalysis, User
from app.models.project_ai_work import ProjectAIJob
from app.services import accounts, ai
from app.services.scope import visible_project_ids_for

logger = logging.getLogger(__name__)
ACTION_PROMPT = """
请在报告最后增加一个 ```pm-actions 代码块，内容为 JSON 数组（最多 12 条建议）。
每条建议包含 kind（task/risk/schedule）、title、reason、owner_id、due_date（YYYY-MM-DD）。
task 可包含 sub_project_id、planned_start、planned_end；schedule 必须包含 task_id、planned_start、planned_end。
所有 ID 必须来自快照；缺少依据的字段留空。日期与负责人均为建议，用户将核对、编辑并明确确认才会执行。
代码块之外保留正常 Markdown 分析；绝不声称建议已经执行。
"""


def effective_user(db, user_id):
    user = db.get(User, user_id)
    if not user or not user.is_active:
        raise HTTPException(403, "账号已停用或不再具有项目分析权限")
    identities = (
        db.query(IAMIdentity).filter_by(issuer=settings.casdoor_issuer, user_id=user_id).all()
    )
    if len(identities) != 1:
        raise HTTPException(403, "项目分析身份映射不唯一，请联系管理员核对")
    held = accounts.live_roles(identities[0].subject)
    role = next((role for role in ROLE_PRIORITY if role in held), None)
    if role not in {"admin", "cmc_lead", "project_lead"}:
        raise HTTPException(403, "项目分析权限已变化")
    set_committed_value(user, "role", role)
    return user


def authorized(db, user_id, project_id):
    user = effective_user(db, user_id)
    if project_id not in visible_project_ids_for(user, db):
        raise HTTPException(404, "项目不存在或无权访问")
    project = db.get(Project, project_id)
    if user.role == "project_lead" and project.owner_id != user.id:
        raise HTTPException(403, "项目负责人已变化，请由当前负责人重新发起分析")
    return user


def process_one() -> bool:
    now = datetime.now(UTC)
    claim = uuid4().hex
    with SessionLocal() as db:
        # An interrupted model call is never retried automatically (it may already be billed).
        db.execute(
            update(ProjectAIJob)
            .where(
                ProjectAIJob.state == "running",
                ProjectAIJob.started_at < now - timedelta(minutes=20),
            )
            .values(
                state="failed",
                finished_at=now,
                error="分析进程已中断，请核对后重新生成",
                claim=None,
            )
        )
        row = (
            db.query(ProjectAIJob)
            .filter_by(state="queued")
            .order_by(ProjectAIJob.created_at, ProjectAIJob.id)
            .with_for_update(skip_locked=True)
            .first()
        )
        if not row:
            db.commit()
            return False
        job_id = row.id
        changed = db.execute(
            update(ProjectAIJob)
            .where(ProjectAIJob.id == job_id, ProjectAIJob.state == "queued")
            .values(state="running", started_at=now, claim=claim)
        )
        if changed.rowcount != 1:
            db.rollback()
            return False
        db.commit()
    try:
        with SessionLocal() as db:
            job = db.get(ProjectAIJob, job_id)
            if not job or job.state != "running" or job.claim != claim:
                return True
            authorized(db, job.created_by, job.project_id)
            context, focus, prompt = job.context, job.focus, job.prompt
            cfg = ai.load_settings(db)
        content, provider, model, usage = ai.analyze(cfg, context, focus, prompt + ACTION_PROMPT)
        with SessionLocal() as db:
            job = db.query(ProjectAIJob).filter_by(id=job_id).with_for_update().first()
            if not job or job.state != "running" or job.claim != claim:
                return True
            authorized(db, job.created_by, job.project_id)
            record = ProjectAIAnalysis(
                id=uuid4().hex,
                project_id=job.project_id,
                created_by=job.created_by,
                created_at=datetime.now(UTC),
                provider=provider,
                model=model,
                focus=focus,
                prompt=prompt,
                content=content,
                source=job.source,
                usage=usage,
            )
            db.add(record)
            db.flush()
            changed = db.execute(
                update(ProjectAIJob)
                .where(
                    ProjectAIJob.id == job_id,
                    ProjectAIJob.state == "running",
                    ProjectAIJob.claim == claim,
                )
                .values(
                    analysis_id=record.id,
                    state="succeeded",
                    finished_at=datetime.now(UTC),
                    claim=None,
                )
            )
            if changed.rowcount != 1:
                db.rollback()
                return True
            db.commit()
    except Exception as exc:
        error = (
            str(exc)
            if isinstance(exc, ai.AIError)
            else (
                str(exc.detail)
                if isinstance(exc, HTTPException)
                else "后台分析失败，请重试或联系管理员"
            )
        )
        with SessionLocal() as db:
            db.execute(
                update(ProjectAIJob)
                .where(
                    ProjectAIJob.id == job_id,
                    ProjectAIJob.state == "running",
                    ProjectAIJob.claim == claim,
                )
                .values(
                    state="failed", finished_at=datetime.now(UTC), error=error[:1000], claim=None
                )
            )
            db.commit()
        logger.warning("Project analysis job failed: %s (%s)", job_id, type(exc).__name__)
    return True


def start_worker():
    if os.environ.get("PROJECT_AI_WORKER_ENABLED", "true").lower() != "true":
        return None
    stop = threading.Event()

    def run():
        while not stop.is_set():
            try:
                if process_one():
                    continue
            except Exception:
                logger.exception("Project analysis queue polling failed")
            stop.wait(2)

    thread = threading.Thread(target=run, daemon=True, name="project-ai-jobs")
    thread.start()
    return stop, thread
