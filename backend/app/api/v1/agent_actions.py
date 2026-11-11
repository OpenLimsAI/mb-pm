"""Delegated proposals and the signed-in person's review and confirmation."""

from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select

from app.api.deps import get_current_user
from app.api.v1.agent_projects import (
    DB,
    AgentUser,
    IDPath,
    PageNumber,
    PageSize,
    delegated_audience,
)
from app.api.v1.project_ai_work import cancel_job, enqueue_job, job_view, report_access
from app.core.security import SESSION_COOKIE
from app.models import AgentProposal, User
from app.models.project_ai_work import ProjectAIJob
from app.schemas import agent_actions as schema
from app.schemas.ai import AnalysisInput
from app.services import agent_actions as actions
from app.services import agent_projects, project_ai_jobs
from app.services.iam_admin import IAMError
from app.services.project_ai_actions import digest

router = APIRouter(prefix="/agent", tags=["agent"])
browser_router = APIRouter(prefix="/project-ai/projects", tags=["project-ai"])


class Change(BaseModel):
    title: str
    before: dict
    after: dict


class Proposal(BaseModel):
    id: str
    project_id: str
    kind: str
    reason: str
    state: Literal["pending_confirmation", "applied", "cancelled", "expired", "stale"]
    created_at: datetime
    expires_at: datetime
    finished_at: datetime | None
    changes: list[Change]
    review_url: str | None
    result: dict | None
    error: str | None
    retried_from: str | None


class ProposalReview(Proposal):
    review_key: str | None
    replayed: bool


class ProposalPage(BaseModel):
    items: list[Proposal]
    meta: dict


class ScheduleResult(BaseModel):
    fingerprint: str
    changes: list[dict]
    conflicts: list[dict]
    previous_finish: str
    new_finish: str


class AnalysisJob(BaseModel):
    id: str
    project_id: str
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    state: Literal["queued", "running", "succeeded", "failed", "cancelled"]
    focus: str
    analysis_id: str | None
    error: str | None


class AnalysisPage(BaseModel):
    items: list[AnalysisJob]
    meta: dict


class AnalysisResult(BaseModel):
    report_id: str
    created_at: datetime
    provider: str
    model: str
    focus: str
    content: str
    url: str


def browser_user(request: Request, db: DB) -> User:
    if request.headers.get("authorization") or not request.cookies.get(SESSION_COOKIE):
        raise HTTPException(401, "请从项目管理页面登录并确认")
    delegated_audience()
    # Cookie-authenticated writes also require the configured PM origin.
    return get_current_user(request, db)


BrowserUser = Annotated[User, Depends(browser_user)]


@router.post("/projects/{project_id}/schedule-preview", response_model=ScheduleResult)
def schedule_preview(project_id: IDPath, payload: schema.SchedulePreview, db: DB, user: AgentUser):
    project = actions.project_for(db, user, project_id)
    result, _ = actions.schedule_preview(db, user, project, payload)
    return result


@router.get("/projects/{project_id}/proposals", response_model=ProposalPage)
def proposals(
    project_id: IDPath, db: DB, user: AgentUser, page: PageNumber = 1, page_size: PageSize = 20
):
    project = actions.project_for(db, user, project_id)
    query = actions.allowed_proposals(db, user, project).order_by(
        AgentProposal.created_at.desc(), AgentProposal.id.desc()
    )
    rows, meta = agent_projects.page_of(db, query, page, page_size)
    return {"items": [actions.view(row) for (row,) in rows], "meta": meta}


@router.post("/projects/{project_id}/proposals", response_model=Proposal, status_code=201)
def propose(project_id: IDPath, payload: schema.Propose, db: DB, user: AgentUser):
    project = actions.project_for(db, user, project_id, lock=True)
    return actions.propose(db, user, project, payload)


@router.get("/proposals/{proposal_id}", response_model=Proposal)
def proposal(proposal_id: IDPath, db: DB, user: AgentUser):
    _, row = actions.get(db, user, proposal_id)
    return actions.view(row)


@router.post("/proposals/{proposal_id}/cancel", response_model=Proposal)
def cancel(proposal_id: IDPath, db: DB, user: AgentUser):
    _, row = actions.get(db, user, proposal_id, lock=True)
    return actions.cancel(db, row)


@router.post("/proposals/{proposal_id}/retry", response_model=Proposal, status_code=201)
def retry(proposal_id: IDPath, payload: schema.RetryProposal, db: DB, user: AgentUser):
    project, row = actions.get(db, user, proposal_id, lock=True)
    return actions.retry(db, user, project, row, payload.request_id)


@browser_router.get("/{project_id}/agent-proposals/{proposal_id}", response_model=ProposalReview)
def review(project_id: IDPath, proposal_id: IDPath, db: DB, user: BrowserUser):
    _, row = actions.get(db, user, proposal_id, project_id)
    return actions.view(row, review=True)


@browser_router.post("/{project_id}/agent-proposals/{proposal_id}", response_model=ProposalReview)
def confirm(
    project_id: IDPath,
    proposal_id: IDPath,
    payload: schema.ConfirmProposal,
    db: DB,
    user: BrowserUser,
):
    project, row = actions.get(db, user, proposal_id, project_id, lock=True)
    return actions.confirm(db, user, project, row, payload.review_key)


def analysis_actor(db: DB, user: AgentUser, project_id: IDPath) -> User:
    try:
        return project_ai_jobs.authorized(db, user.id, project_id)
    except IAMError:
        raise HTTPException(503, "暂时无法确认项目分析权限，请稍后重试") from None


AnalysisActor = Annotated[User, Depends(analysis_actor)]


def analysis_query(user: User, project_id: str):
    return select(ProjectAIJob).where(
        ProjectAIJob.created_by == user.id,
        ProjectAIJob.project_id == project_id,
        ProjectAIJob.source["agent_request_digest"].as_string().is_not(None),
    )


def get_analysis(db: DB, user: User, project_id: str, job_id: str) -> ProjectAIJob:
    job = db.scalars(analysis_query(user, project_id).where(ProjectAIJob.id == job_id)).first()
    if not job:
        raise HTTPException(404, "后台分析不存在或无权访问")
    return job


def analysis_view(job: dict) -> dict:
    return {
        **job,
        "error": "后台分析未完成，可在项目页面核对后重试" if job["state"] == "failed" else None,
    }


def enqueue_agent_analysis(db, user, project_id, request_id, payload, *, retried_from=None):
    job_id = digest(["agent-analysis", user.id, project_id, request_id])[:32]
    fingerprint = digest([payload.model_dump(mode="json"), retried_from])
    return analysis_view(
        enqueue_job(project_id, payload, db, user, agent_request=(job_id, fingerprint))
    )


@router.get("/projects/{project_id}/analysis-jobs", response_model=AnalysisPage)
def analysis_jobs(
    project_id: IDPath, db: DB, user: AnalysisActor, page: PageNumber = 1, page_size: PageSize = 20
):
    query = analysis_query(user, project_id).order_by(
        ProjectAIJob.created_at.desc(), ProjectAIJob.id.desc()
    )
    rows, meta = agent_projects.page_of(db, query, page, page_size)
    return {"items": [analysis_view(job_view(row)) for (row,) in rows], "meta": meta}


@router.post("/projects/{project_id}/analysis-jobs", response_model=AnalysisJob, status_code=202)
def start_analysis(project_id: IDPath, payload: schema.StartAnalysis, db: DB, user: AnalysisActor):
    return enqueue_agent_analysis(
        db,
        user,
        project_id,
        payload.request_id,
        AnalysisInput(focus=payload.focus, prompt=payload.prompt),
    )


@router.get("/projects/{project_id}/analysis-jobs/{job_id}", response_model=AnalysisJob)
def analysis_status(project_id: IDPath, job_id: IDPath, db: DB, user: AnalysisActor):
    return analysis_view(job_view(get_analysis(db, user, project_id, job_id)))


@router.post("/projects/{project_id}/analysis-jobs/{job_id}/cancel", response_model=AnalysisJob)
def cancel_analysis(project_id: IDPath, job_id: IDPath, db: DB, user: AnalysisActor):
    get_analysis(db, user, project_id, job_id)
    return analysis_view(cancel_job(project_id, job_id, db, user))


@router.post(
    "/projects/{project_id}/analysis-jobs/{job_id}/retry",
    response_model=AnalysisJob,
    status_code=202,
)
def retry_analysis(
    project_id: IDPath, job_id: IDPath, payload: schema.RetryAnalysis, db: DB, user: AnalysisActor
):
    job = get_analysis(db, user, project_id, job_id)
    if job.state not in {"failed", "cancelled"}:
        raise HTTPException(409, "仅失败或取消的后台分析可以重新提交")
    return enqueue_agent_analysis(
        db,
        user,
        project_id,
        payload.request_id,
        AnalysisInput(focus=job.focus, prompt=job.prompt),
        retried_from=job_id,
    )


@router.get("/projects/{project_id}/analysis-jobs/{job_id}/result", response_model=AnalysisResult)
def analysis_result(project_id: IDPath, job_id: IDPath, db: DB, user: AnalysisActor):
    job = get_analysis(db, user, project_id, job_id)
    if job.state != "succeeded" or not job.analysis_id:
        raise HTTPException(409, "后台分析结果尚不可用")
    report = report_access(db, project_id, job.analysis_id)
    return {
        "report_id": report.id,
        "created_at": actions.utc(report.created_at),
        "provider": report.provider,
        "model": report.model,
        "focus": report.focus,
        "content": report.content,
        "url": agent_projects.project_link(project_id, tab="ai"),
    }
