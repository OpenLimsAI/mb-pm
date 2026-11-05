"""Project-only background analysis, searchable history and explicit action confirmation."""

from datetime import UTC, datetime
from typing import Annotated
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import or_, text
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models import Project, ProjectAIAnalysis, User
from app.models.project_ai_work import ProjectAIAction, ProjectAIJob
from app.schemas.ai import AnalysisInput
from app.services import ai
from app.services.project_ai_actions import ActionInput, apply_action, preview_action, proposals
from app.services.project_ai_jobs import effective_user
from app.services.scope import visible_project_ids_for

router = APIRouter(prefix="/project-ai/projects", tags=["project-ai"])
DB = Annotated[Session, Depends(get_db)]


def current_analyst(db: DB, user: Annotated[User, Depends(get_current_user)]):
    return effective_user(db, user.id)


Analyst = Annotated[User, Depends(current_analyst)]


def project_access(db, user, project_id, write=False):
    query = db.query(Project).filter_by(id=project_id)
    project = (query.with_for_update() if write else query).first()
    if not project or project_id not in visible_project_ids_for(user, db):
        raise HTTPException(404, "项目不存在或无权访问")
    if write and user.role == "project_lead" and project.owner_id != user.id:
        raise HTTPException(403, "仅项目负责人可确认执行建议")
    return project


def job_view(job):
    return {
        key: getattr(job, key)
        for key in (
            "id",
            "project_id",
            "created_by",
            "created_at",
            "started_at",
            "finished_at",
            "state",
            "focus",
            "analysis_id",
            "error",
        )
    }


@router.get("/{project_id}/jobs")
def jobs(project_id: str, db: DB, user: Analyst):
    project_access(db, user, project_id)
    return [
        job_view(row)
        for row in db.query(ProjectAIJob)
        .filter_by(project_id=project_id, created_by=user.id)
        .order_by(ProjectAIJob.created_at.desc())
        .limit(30)
    ]


@router.post("/{project_id}/jobs", status_code=202)
def create_job(project_id: str, payload: AnalysisInput, db: DB, user: Analyst):
    # Serialize queue admission across both production instances.
    if db.bind.dialect.name == "postgresql":
        db.execute(text("SELECT pg_advisory_xact_lock(7211202604)"))
    project = project_access(db, user, project_id, write=True)
    cfg = ai.load_settings(db)
    prompt = (payload.prompt or "").strip() or cfg["analysis_prompt"]
    existing = (
        db.query(ProjectAIJob)
        .filter(ProjectAIJob.created_by == user.id, ProjectAIJob.state.in_(["queued", "running"]))
        .first()
    )
    if existing:
        if (
            existing.project_id == project_id
            and existing.focus == payload.focus.strip()
            and existing.prompt == prompt
        ):
            return job_view(existing)
        raise HTTPException(409, "已有后台项目分析在排队或生成，请先等待或取消")
    if db.query(ProjectAIJob).filter(ProjectAIJob.state.in_(["queued", "running"])).count() >= 16:
        raise HTTPException(429, "后台项目分析队列已满，请稍后重试")
    context, source = ai.project_context(db, project)
    if len(str(context)) > 120000:
        raise HTTPException(422, "分析数据超过单次容量，请精简任务备注后重试")
    job = ProjectAIJob(
        id=uuid4().hex,
        project_id=project_id,
        created_by=user.id,
        created_at=datetime.now(UTC),
        state="queued",
        focus=payload.focus.strip(),
        prompt=prompt,
        context=context,
        source=source,
        error="",
    )
    db.add(job)
    db.commit()
    return job_view(job)


@router.post("/{project_id}/jobs/{job_id}/cancel")
def cancel_job(project_id: str, job_id: str, db: DB, user: Analyst):
    project_access(db, user, project_id)
    job = (
        db.query(ProjectAIJob)
        .filter_by(id=job_id, project_id=project_id, created_by=user.id)
        .with_for_update()
        .first()
    )
    if not job:
        raise HTTPException(404, "后台分析不存在")
    if job.state in {"queued", "running"}:
        job.state, job.finished_at, job.claim = "cancelled", datetime.now(UTC), None
        db.commit()
    return job_view(job)


@router.get("/{project_id}/history")
def history(
    project_id: str,
    db: DB,
    user: Analyst,
    keyword: str = Query("", max_length=200),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=50),
):
    project = project_access(db, user, project_id)
    query = db.query(ProjectAIAnalysis).filter_by(project_id=project_id)
    if keyword.strip():
        like = (
            "%"
            + keyword.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            + "%"
        )
        query = query.filter(
            or_(
                ProjectAIAnalysis.focus.ilike(like, escape="\\"),
                ProjectAIAnalysis.content.ilike(like, escape="\\"),
            )
        )
    total = query.count()
    _, source = ai.project_context(db, project)
    rows = (
        query.order_by(ProjectAIAnalysis.created_at.desc(), ProjectAIAnalysis.id)
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    return {
        "total": total,
        "page": page,
        "items": [
            {**ai.row_data(row), "stale": row.source.get("fingerprint") != source["fingerprint"]}
            for row in rows
        ],
    }


def report_access(db, project_id, report_id):
    report = db.query(ProjectAIAnalysis).filter_by(id=report_id, project_id=project_id).first()
    if not report:
        raise HTTPException(404, "分析报告不存在")
    return report


@router.get("/{project_id}/reports/{report_id}")
def report_detail(project_id: str, report_id: str, db: DB, user: Analyst):
    project = project_access(db, user, project_id)
    report = report_access(db, project_id, report_id)
    _, source = ai.project_context(db, project)
    return {
        **ai.row_data(report),
        "stale": report.source.get("fingerprint") != source["fingerprint"],
    }


@router.get("/{project_id}/reports/{report_id}/actions")
def actions(project_id: str, report_id: str, db: DB, user: Analyst):
    project_access(db, user, project_id)
    report = report_access(db, project_id, report_id)
    applied = (
        db.query(ProjectAIAction)
        .filter_by(analysis_id=report_id)
        .order_by(ProjectAIAction.created_at)
        .all()
    )
    return {
        "proposals": proposals(report.content),
        "applied": [
            {
                "action_key": row.action_key,
                "created_at": row.created_at,
                "draft": row.draft,
                "result": row.result,
            }
            for row in applied
        ],
    }


@router.post("/{project_id}/reports/{report_id}/actions/preview")
def preview(project_id: str, report_id: str, payload: ActionInput, db: DB, user: Analyst):
    project = project_access(db, user, project_id, write=True)
    return preview_action(
        db, project, user, report_access(db, project_id, report_id), payload.draft
    )


@router.post("/{project_id}/reports/{report_id}/actions/apply")
def apply(project_id: str, report_id: str, payload: ActionInput, db: DB, user: Analyst):
    project = project_access(db, user, project_id, write=True)
    return apply_action(db, project, user, report_access(db, project_id, report_id), payload)
