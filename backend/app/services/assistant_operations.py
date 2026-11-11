"""Content-free operations controls and configuration-only readiness checks."""

from datetime import UTC, datetime, timedelta
from typing import Literal

from fastapi import HTTPException
from fastapi.encoders import jsonable_encoder
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import Text, cast, func, or_, select, text, update

from app.core.config import settings
from app.models.assistant import AssistantMessage, AssistantOperationsConfig, AssistantRequest
from app.services import accounts, ai, answer_modes, solution_ai, solution_knowledge, web_search
from app.services import assistant_diagnostics as diagnostics
from app.services.iam_admin import IAMError


class Limits(BaseModel):
    model_config = ConfigDict(extra="forbid")
    per_user_pending: int = Field(default=3, ge=1, le=20)
    global_queued: int = Field(default=100, ge=1, le=1000)
    per_user_running: int = Field(default=1, ge=1, le=4)
    retention_days: int = Field(default=0, ge=0, le=365)

    @model_validator(mode="after")
    def bounds(self):
        if self.retention_days and self.retention_days < 7:
            raise ValueError("保留期至少为 7 天，0 表示关闭清理")
        if self.per_user_running > self.per_user_pending:
            raise ValueError("同时生成数量不能超过待处理数量")
        return self


class Preflight(BaseModel):
    model_config = ConfigDict(extra="forbid", protected_namespaces=())
    model_profile_id: str | None = Field(default=None, max_length=100)
    answer_mode: Literal["auto", "general", "knowledge", "web"] = "auto"
    data_sources: list[Literal["projects", "knowledge"]] = Field(default_factory=list, max_length=2)
    question: str = Field(default="", max_length=12000)
    task_id: str | None = Field(default=None, max_length=64)
    reference_material_available: bool = False
    base_artifact_id: str | None = Field(default=None, min_length=1, max_length=64)


def queue_lock(db):
    # Both replicas serialize count+claim and admission; transaction scoped, so
    # crashes release the lock. SQLite is only used by isolated unit fixtures.
    if db.get_bind().dialect.name == "postgresql":
        db.execute(text("SELECT pg_advisory_xact_lock(68477904017)"))


def limits(db):
    row = db.get(AssistantOperationsConfig, "default")
    defaults = {
        "per_user_pending": settings.ASSISTANT_PER_USER_PENDING,
        "global_queued": settings.ASSISTANT_GLOBAL_QUEUED,
        "per_user_running": settings.ASSISTANT_PER_USER_RUNNING,
        "retention_days": 0,
    }
    return Limits.model_validate(row.limits if row else defaults).model_dump()


def require_admin(claims):
    # Fresh directory roles; login-time role claims are never sufficient for
    # diagnostics across identities or a global queue policy change.
    try:
        roles = accounts.live_roles(claims["sub"])
    except IAMError:
        raise HTTPException(503, "暂时无法确认管理员权限，请稍后重试") from None
    if "admin" not in roles:
        raise HTTPException(403, "仅管理员可查看助手运行诊断")


def utc(value):
    return value.replace(tzinfo=UTC) if value and not value.tzinfo else value


def elapsed(start, end):
    return round(max(0, (utc(end) - utc(start)).total_seconds()), 1) if start and end else None


def overview(db, claims, diagnostic_id=""):
    require_admin(claims)
    point = datetime.now(UTC)
    cutoff = point - timedelta(hours=24)
    totals = {key: 0 for key in ("queued", "running", "completed", "failed", "cancelled")}
    for status, count in db.execute(
        select(AssistantRequest.status, func.count())
        .where(
            (AssistantRequest.created_at >= cutoff)
            | AssistantRequest.status.in_(["queued", "running"])
        )
        .group_by(AssistantRequest.status)
    ):
        totals[status] = count
    failures = dict(
        db.execute(
            select(AssistantRequest.error_code, func.count())
            .where(AssistantRequest.created_at >= cutoff, AssistantRequest.status == "failed")
            .group_by(AssistantRequest.error_code)
        ).all()
    )
    query = select(AssistantRequest)
    if diagnostic_id:
        query = query.where(AssistantRequest.diagnostic_id == diagnostic_id)
    else:
        query = query.where(AssistantRequest.created_at >= cutoff)
    rows = db.scalars(query.order_by(AssistantRequest.created_at.desc()).limit(50)).all()
    recent = [
        {
            "request_id": row.request_id,
            "diagnostic_id": row.diagnostic_id,
            "status": row.status,
            "stage": row.stage,
            "error_code": row.error_code,
            "created_at": row.created_at,
            "started_at": row.started_at,
            "finished_at": row.finished_at,
            "elapsed_seconds": elapsed(row.created_at, row.finished_at or point),
            "first_content_seconds": elapsed(row.started_at, row.first_content_at),
        }
        for row in rows
    ]
    result = {
        "can_manage": True,
        "limits": limits(db),
        "totals": totals,
        "window_hours": 24,
        "failure_counts": failures,
        "recent": recent,
        "worker_enabled": settings.ASSISTANT_REQUEST_WORKER_ENABLED,
    }
    db.rollback()
    return jsonable_encoder(result)


def save_limits(db, claims, payload):
    require_admin(claims)
    queue_lock(db)
    row = db.get(AssistantOperationsConfig, "default")
    if row is None:
        row = AssistantOperationsConfig(id="default", limits=payload.model_dump())
        db.add(row)
    else:
        row.limits = payload.model_dump()
        row.updated_at = datetime.now(UTC)
    db.commit()
    return {"limits": payload.model_dump()}


def prune(db, claims):
    require_admin(claims)
    queue_lock(db)
    days = limits(db)["retention_days"]
    if not days:
        raise HTTPException(422, "清理已关闭，请先设置至少 7 天的保留期")
    rows = db.scalars(
        select(AssistantRequest)
        .where(
            AssistantRequest.status.in_(["completed", "failed", "cancelled"]),
            AssistantRequest.finished_at < datetime.now(UTC) - timedelta(days=days),
            or_(
                func.length(cast(AssistantRequest.payload, Text)) > 2,
                AssistantRequest.partial_content != "",
            ),
        )
        .order_by(AssistantRequest.finished_at)
        .limit(1000)
    ).all()
    count = 0
    for row in rows:
        if not row.payload and not row.partial_content:
            continue
        # Keep the request identity/fingerprint as an idempotency tombstone;
        # completed task messages and source authorization metadata are untouched.
        db.execute(
            update(AssistantRequest)
            .where(AssistantRequest.id == row.id)
            .values(
                payload={},
                partial_content="",
                error="请求明细已按保留期清理；已保存的对话保持不变。",
            )
        )
        count += 1
    db.commit()
    return {"pruned": count}


def preflight(db, claims, payload):
    checks = []

    def check(key, action):
        try:
            message = action()
            checks.append({"key": key, "status": "ready", "message": message})
        except HTTPException as exc:
            result = {"key": key, "status": "blocked", "message": str(exc.detail)}
            if (
                key == "projects"
                and (exc.headers or {}).get(diagnostics.ERROR_HEADER) == "project_login_required"
            ):
                result["action"] = "project-login"
            checks.append(result)

    def model():
        selected = solution_ai.select_model(
            db,
            claims,
            "system" if payload.model_profile_id == "enterprise" else payload.model_profile_id,
        )
        if selected["kind"] == "retrieval":
            raise HTTPException(422, "请选择可生成回答的模型")
        if selected["kind"] == "system":
            config = ai.load_settings(db, claims)
            provider = config["provider"]
            cfg = config["providers"][provider]
            if not cfg.get("model") or (provider != "ollama" and not cfg.get("api_key")):
                raise HTTPException(422, "模型尚未配置，请先完善 AI 模型设置")
        return "模型配置完整；实际可用性以发送后的服务响应为准"

    check("model", model)
    try:
        previous = None
        base_artifact = None
        if payload.base_artifact_id and not payload.task_id:
            raise HTTPException(422, "请选择当前任务中的基稿")
        if payload.task_id:
            from app.services import assistant, assistant_artifacts

            task = assistant.get_task(db, payload.task_id, claims)
            history = db.scalars(
                select(AssistantMessage).where(AssistantMessage.task_id == task.id)
            ).all()
            assistant.check_history_access(db, claims, history)
            base_artifact = assistant_artifacts.selected(db, claims, task, payload)
            previous = db.scalar(
                select(AssistantMessage)
                .where(AssistantMessage.task_id == task.id, AssistantMessage.role == "assistant")
                .order_by(AssistantMessage.position.desc())
                .limit(1)
            )
        plan = answer_modes.decide_personal(
            payload.question,
            payload.answer_mode,
            data_sources=payload.data_sources,
            previous_mode=previous.answer_mode if previous else "",
            previous_sources=(previous.application_scope or {}).get("used_sources", [])
            if previous
            else [],
            reference_material_available=payload.reference_material_available,
        )
        if base_artifact:
            plan = assistant_artifacts.inherit_plan(plan, base_artifact, payload.question)
    except HTTPException as exc:
        checks.append({"key": "scope", "status": "blocked", "message": str(exc.detail)})
        plan = None
    if plan and "knowledge" in plan.sources:

        def knowledge():
            solution_knowledge.check_access(claims)
            return "知识库连接配置和当前账号权限已检查；尚未检索资料"

        check("knowledge", knowledge)
    if plan and "projects" in plan.sources:
        from app.services import assistant_projects

        def projects():
            assistant_projects.access(db, claims)
            return "项目管理权限已检查；尚未读取项目资料"

        check("projects", projects)
    if plan and plan.mode == "web":
        capability = web_search.capabilities_for_model(db, claims, payload.model_profile_id)[
            "web_search"
        ]
        checks.append(
            {
                "key": "web",
                "status": "ready" if capability["configured"] else "blocked",
                "message": capability["message"],
            }
        )
    ready = all(row["status"] != "blocked" for row in checks)
    db.rollback()
    return {
        "ready": ready,
        "checks": checks,
        "message": "配置检查通过，尚未调用模型或搜索服务" if ready else "请先处理以上设置问题",
    }
