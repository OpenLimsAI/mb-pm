"""Read-only Agent API, plus an explicit browser-only report save."""

import json
from datetime import UTC, date, datetime
from typing import Annotated, Generic, Literal, TypeVar
from urllib.parse import urlencode
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.api.v1.project_ai_work import current_analyst, project_access
from app.core.config import settings
from app.core.security import SESSION_COOKIE, decode_access_token, resolve_identity
from app.db.session import get_db
from app.models import AuditLog, ProjectAIAnalysis, User
from app.models.enums import TaskStatus
from app.schemas.task import TaskDependencyOut
from app.services import agent_projects, ai, oidc_logout, oidc_status, password_policy
from app.services.iam_admin import IAMError

router = APIRouter(prefix="/agent", tags=["agent"])
review_router = APIRouter(prefix="/project-ai/projects", tags=["project-ai"])
DB = Annotated[Session, Depends(get_db)]
IDPath = Annotated[str, Path(min_length=1, max_length=64)]
IDQuery = Annotated[str | None, Query(min_length=1, max_length=64)]
PageNumber = Annotated[int, Query(ge=1, le=10000)]
PageSize = Annotated[int, Query(ge=1, le=50)]
AgentToken = Annotated[
    HTTPAuthorizationCredentials | None,
    Security(HTTPBearer(scheme_name="AgentDelegation", auto_error=False)),
]


class ProjectEvidence(BaseModel):
    id: str
    code: str
    name: str
    url: str


class TaskEvidence(BaseModel):
    id: str
    code: str
    name: str
    project: ProjectEvidence
    planned_start: date
    planned_end: date
    actual_end: date | None
    status: str
    progress: int
    is_milestone: bool
    overdue: bool
    overdue_days: int
    revision: int
    url: str


class TaskSummary(TaskEvidence):
    owner_id: str
    sub_project_id: str
    priority: str


class TaskDetail(TaskSummary):
    sub_project_name: str
    owner_name: str
    actual_start: date | None
    is_critical_path: bool
    notes: str | None
    notes_truncated: bool


class PageMeta(BaseModel):
    page: int
    page_size: int
    total: int
    has_more: bool


Evidence = TypeVar("Evidence")


class EvidencePage(BaseModel, Generic[Evidence]):
    items: list[Evidence]
    meta: PageMeta


class SubProjectEvidence(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    name: str
    stage: str
    module: str


class MemberEvidence(BaseModel):
    id: str
    display_name: str
    is_project_owner: bool


class ProjectCapabilities(BaseModel):
    proposal_actions: list[str]
    task_capabilities_at_detail: bool
    can_assign_members: bool
    review_risk_report: bool


class ProjectContext(BaseModel):
    as_of: datetime
    business_date: date
    timezone: str
    project: ProjectEvidence
    sub_projects: EvidencePage[SubProjectEvidence]
    members: EvidencePage[MemberEvidence]
    capabilities: ProjectCapabilities
    task_statuses: dict[str, str]


class ProjectPage(BaseModel):
    as_of: datetime
    items: list[ProjectEvidence]
    meta: PageMeta


class TaskPage(BaseModel):
    as_of: datetime
    as_of_date: date
    items: list[TaskSummary]
    meta: PageMeta


class TaskResult(BaseModel):
    as_of: datetime
    as_of_date: date
    task: TaskEvidence


class ActivityEvidence(BaseModel):
    id: str
    actor_id: str
    kind: str
    body: str
    changes: dict[str, dict[str, str | int | bool | None]]
    created_at: datetime


class DeliverableEvidence(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    author_id: str
    title: str
    version: int
    filename: str | None
    link: str | None
    notes: str
    created_at: datetime


class AcceptanceEvidence(BaseModel):
    reviewer_id: str
    required_count: int
    state: str
    comment: str
    updated_at: datetime
    submitted_deliverable_ids: list[str]


class TaskDetailResult(TaskResult):
    task: TaskDetail
    dependencies: EvidencePage[TaskDependencyOut]
    activities: EvidencePage[ActivityEvidence]
    deliverables: EvidencePage[DeliverableEvidence]
    acceptance: AcceptanceEvidence | None
    proposal_actions: list[str]


class RegisterEvidence(BaseModel):
    id: str
    project_id: str
    kind: str
    title: str
    owner_id: str
    due_date: date
    severity: str
    status: str
    mitigation: str
    closure: str
    revision: int
    updated_at: datetime


class RegisterResult(EvidencePage[RegisterEvidence]):
    as_of: datetime
    project: ProjectEvidence


class BaselineSource(BaseModel):
    id: str
    label: str
    created_at: datetime


class BaselineVariance(BaseModel):
    planned_start: date
    planned_end: date
    start_delta_days: int
    end_delta_days: int


class BaselineResult(TaskResult):
    status: Literal["no_baseline", "task_not_in_baseline", "compared"]
    baseline: BaselineSource | None
    variance: BaselineVariance | None


class RiskReport(BaseModel):
    as_of: datetime
    as_of_date: date
    project: ProjectEvidence
    overdue_count: int
    truncated: bool
    items: list[TaskEvidence]
    content: str


class RiskReportResult(RiskReport):
    review_url: str | None


class RiskReportReview(RiskReport):
    review_key: str


class ConfirmRiskReport(BaseModel):
    model_config = ConfigDict(extra="forbid")
    review_key: str = Field(pattern=r"^[0-9a-f]{64}$")


class SavedReport(BaseModel):
    report_id: str
    replayed: bool


def delegated_audience() -> str:
    audience = settings.AGENT_DELEGATION_CLIENT_ID
    if not audience or audience in {
        settings.CASDOOR_CLIENT_ID,
        settings.portal_client_id,
        settings.MDM_DELEGATION_CLIENT_ID,
        settings.KNOWLEDGE_AI_CLIENT_ID,
    }:
        raise HTTPException(503, "独立 Agent 用户委托尚未配置")
    if not settings.OIDC_GLOBAL_LOGOUT_ENABLED or not settings.CASDOOR_ACCOUNT_STATUS_VISIBLE:
        raise HTTPException(503, "Agent 接口需要实时 IAM 状态校验")

    return audience


def agent_user(request: Request, db: DB, credential: AgentToken) -> User:
    audience = delegated_audience()
    if not credential:
        raise HTTPException(
            401, "需要当前用户的 Agent 委托令牌", headers={"WWW-Authenticate": "Bearer"}
        )
    token = credential.credentials.strip()
    claims = decode_access_token(token, audience=audience)
    if claims.get("aud") not in (audience, [audience]) or claims.get("azp", audience) != audience:
        raise HTTPException(401, "Agent 委托令牌受众不匹配")
    oidc_logout.ensure_not_revoked(db, claims, audience)
    oidc_status.ensure_active_token(token, claims, expected_audience=audience)
    user = resolve_identity(claims, db, bind=False)
    if password_policy.observe_identity(db, claims):
        db.commit()
    password_policy.enforce(db, claims["sub"], request.url.path)
    request.state.agent_subject = claims["sub"]
    return user


AgentUser = Annotated[User, Depends(agent_user)]


@router.get("/projects", response_model=ProjectPage)
def projects(db: DB, user: AgentUser, page: PageNumber = 1, page_size: PageSize = 20):
    return {"as_of": datetime.now(UTC), **agent_projects.project_page(db, user, page, page_size)}


@router.get("/projects/{project_id}/context", response_model=ProjectContext)
def project_context(
    project_id: IDPath, db: DB, user: AgentUser, page: PageNumber = 1, page_size: PageSize = 20
):
    project = agent_projects.permitted_project(db, user, project_id)
    now = datetime.now().astimezone()
    return {
        "as_of": now,
        "business_date": now.date(),
        "timezone": str(now.tzinfo),
        **agent_projects.project_context(db, user, project, page, page_size),
    }


@router.get("/projects/{project_id}/register", response_model=RegisterResult)
def register(
    project_id: IDPath,
    db: DB,
    user: AgentUser,
    kind: Literal["risk", "issue", "decision"] | None = None,
    status: Literal["open", "closed"] | None = None,
    page: PageNumber = 1,
    page_size: PageSize = 20,
):
    project = agent_projects.permitted_project(db, user, project_id)
    return {
        "as_of": datetime.now(UTC),
        **agent_projects.register_page(db, project, kind, status, page, page_size),
    }


@router.get("/tasks", response_model=TaskPage)
def tasks(
    db: DB,
    user: AgentUser,
    project_id: IDQuery = None,
    sub_project_id: IDQuery = None,
    owner_id: IDQuery = None,
    status: TaskStatus | None = None,
    due_from: date | None = None,
    due_to: date | None = None,
    overdue: bool | None = None,
    page: PageNumber = 1,
    page_size: PageSize = 20,
):
    if due_from is not None and due_to is not None and due_from > due_to:
        raise HTTPException(422, "计划完成日期范围起点不能晚于终点")
    today = date.today()
    return {
        "as_of": datetime.now(UTC),
        "as_of_date": today,
        **agent_projects.task_page(
            db,
            user,
            project_id,
            overdue,
            page,
            page_size,
            today,
            sub_project_id=sub_project_id,
            owner_id=owner_id,
            status=status,
            due_from=due_from,
            due_to=due_to,
        ),
    }


@router.get("/tasks/{task_id}", response_model=TaskDetailResult)
def task_detail(
    task_id: IDPath, db: DB, user: AgentUser, page: PageNumber = 1, page_size: PageSize = 20
):
    task, project = agent_projects.find_task(db, user, task_id)
    today = date.today()
    return {
        "as_of": datetime.now(UTC),
        "as_of_date": today,
        **agent_projects.task_context(db, user, task, project, today, page, page_size),
    }


@router.get("/tasks/{task_id}/baseline", response_model=BaselineResult)
def baseline(task_id: IDPath, db: DB, user: AgentUser, baseline_id: IDQuery = None):
    task, project = agent_projects.find_task(db, user, task_id)
    today = date.today()
    return {
        "as_of": datetime.now(UTC),
        "as_of_date": today,
        "task": agent_projects.task_evidence(task, project, today),
        **agent_projects.compare_baseline(db, task, project, baseline_id),
    }


@router.get("/projects/{project_id}/risk-report", response_model=RiskReportResult)
def risk_report(project_id: IDPath, db: DB, user: AgentUser):
    project = agent_projects.permitted_project(db, user, project_id)
    report = agent_projects.risk_report(db, user, project)
    key = report.pop("review_key", None)
    review_url = None
    if key:
        review_url = settings.pms_origin + agent_projects.project_link(project.id)
        review_url += "?" + urlencode({"tab": "ai", "agent_report": key})
    return {**report, "review_url": review_url}


def browser_analyst(request: Request, db: DB) -> User:
    # Browser session only: the Agent cannot publish a report with its bearer token.
    if request.headers.get("authorization") or not request.cookies.get(SESSION_COOKIE):
        raise HTTPException(401, "请从项目管理页面登录并确认")
    delegated_audience()
    user = get_current_user(request, db)  # Same-origin check on cookie-authenticated writes.
    try:
        return current_analyst(db, user)
    except IAMError:
        raise HTTPException(503, "暂时无法确认项目分析权限，请稍后重试") from None


BrowserAnalyst = Annotated[User, Depends(browser_analyst)]


@review_router.get("/{project_id}/agent-risk-report", response_model=RiskReportReview)
def review_report(project_id: IDPath, db: DB, user: BrowserAnalyst):
    project = project_access(db, user, project_id, write=True, lock=False)
    return agent_projects.risk_report(db, user, project)


@review_router.post("/{project_id}/agent-risk-report", response_model=SavedReport)
def confirm_report(project_id: IDPath, payload: ConfirmRiskReport, db: DB, user: BrowserAnalyst):
    # Serializes duplicate confirmations for the same project.
    project = project_access(db, user, project_id, write=True)
    report_id = "agent-" + payload.review_key[:34]
    previous = db.get(ProjectAIAnalysis, report_id)
    if previous is not None:
        if (
            previous.project_id != project.id
            or previous.created_by != user.id
            or previous.source.get("review_key") != payload.review_key
        ):
            raise HTTPException(409, "报告确认信息不匹配，请重新预览")
        return {"report_id": previous.id, "replayed": True}

    report = agent_projects.risk_report(db, user, project)
    if report["review_key"] != payload.review_key:
        raise HTTPException(409, "任务数据已变化，请核对最新报告后再保存")
    _, source = ai.project_context(db, project)
    now = datetime.now(UTC)
    db.add(
        ProjectAIAnalysis(
            id=report_id,
            project_id=project.id,
            created_by=user.id,
            created_at=now,
            provider="rules",
            model="overdue-report-v1",
            focus="逾期任务报告",
            prompt="",
            content=report["content"],
            source={
                **source,
                "overdue_count": report["overdue_count"],
                "review_key": payload.review_key,
                "task_ids": [row["id"] for row in report["items"]],
                "truncated": report["truncated"],
            },
            usage={"fallback": False},
        )
    )
    db.add(
        AuditLog(
            id=f"al-{uuid4().hex[:24]}",
            actor_id=user.id,
            action="agent_risk_report_saved",
            target="项目分析",
            target_id=report_id,
            detail=json.dumps({"project_id": project.id, "review_key": payload.review_key}),
            created_at=now,
        )
    )
    db.commit()
    return {"report_id": report_id, "replayed": False}
