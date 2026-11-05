from datetime import UTC, datetime
from typing import Annotated
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_db, require_role
from app.core.config import settings
from app.models import FinanceAIAnalysis, IAMIdentity, Project, ProjectAIAnalysis, User
from app.schemas.ai import AISettingsInput, AnalysisInput, ConnectionInput
from app.services import accounts, ai, solution_ai
from app.services.scope import visible_project_ids_for

router = APIRouter(tags=["ai"])
manager = require_role("admin", "cmc_lead")
analyst = require_role("admin", "cmc_lead", "project_lead")
Manager = Annotated[User, Depends(manager)]
Analyst = Annotated[User, Depends(analyst)]
Database = Annotated[Session, Depends(get_db)]


def configuration_manager(user: Analyst, db: Database) -> User:
    # 从门户移回 PM 后仍实时核对 IAM：旧令牌里的管理角色不能继续修改模型服务地址和密钥。
    identity = (
        db.query(IAMIdentity)
        .filter_by(issuer=settings.casdoor_issuer, user_id=user.id)
        .one_or_none()
    )
    if identity is None or not accounts.live_roles(identity.subject) & {
        "admin",
        "cmc_lead",
        "project_lead",
    }:
        raise HTTPException(403, "仅系统管理员和项目负责人可使用 AI 功能")
    return user


ConfigurationManager = Annotated[User, Depends(configuration_manager)]


def finance_manager(user: Manager, db: Database) -> User:
    identity = (
        db.query(IAMIdentity)
        .filter_by(issuer=settings.casdoor_issuer, user_id=user.id)
        .one_or_none()
    )
    if identity is None or not accounts.live_roles(identity.subject) & {"admin", "cmc_lead"}:
        raise HTTPException(403, "仅系统管理员和管理全部项目的项目负责人可使用组合财务 AI")
    return user


FinanceManager = Annotated[User, Depends(finance_manager)]


def accessible_project(project_id: str, user: User, db: Session) -> Project:
    if project_id not in visible_project_ids_for(user, db):
        raise HTTPException(404, "项目不存在或无权访问")
    return db.get(Project, project_id)


# 项目管理「AI设置」经 PM 会话 / Bearer 调用；旧门户接口暂留兼容，共用同一份配置。
def settings_view(db=None, claims=None) -> dict:
    return ai.public_settings(ai.load_settings(db, claims))


def save_settings(body: AISettingsInput, db=None, claims=None) -> dict:
    try:
        return ai.save_settings(body, db, claims)
    except ai.AIError as e:
        raise HTTPException(400, str(e)) from None


def list_models(body: ConnectionInput, db=None, claims=None) -> dict:
    try:
        cfg = ai.resolve_config(body.provider, body.config, ai.load_settings(db, claims))
        return {"models": ai.list_models(body.provider, cfg)}
    except ai.AIError as e:
        raise HTTPException(502, str(e)) from None


def test_connection(body: ConnectionInput, db=None, claims=None) -> dict:
    try:
        cfg = ai.resolve_config(body.provider, body.config, ai.load_settings(db, claims))
        return ai.test_connection(body.provider, cfg)
    except ai.AIError as e:
        raise HTTPException(502, str(e)) from None


@router.get("/ai/settings")
def get_settings(user: ConfigurationManager, db: Database):
    return settings_view(db)


@router.put("/ai/settings")
def put_settings(body: AISettingsInput, user: ConfigurationManager, db: Database):
    return save_settings(body, db)


@router.get("/ai/status")
def get_status(user: ConfigurationManager, db: Database):
    cfg = ai.load_settings(db)
    selected = cfg["providers"][cfg["provider"]]
    return {
        "provider": cfg["provider"],
        "model": selected["model"],
        "ready": solution_ai.is_configured({**selected, "provider": cfg["provider"]}),
        "offline_fallback": cfg["offline_fallback"],
        # 分析面板预填的默认提示词（项目负责人也需要看到，故不走仅管理员可读的设置接口）
        "analysis_prompt": cfg["analysis_prompt"],
        "finance_analysis_prompt": cfg["finance_analysis_prompt"],
    }


@router.post("/ai/models")
def models(body: ConnectionInput, user: ConfigurationManager, db: Database):
    return list_models(body, db)


@router.post("/ai/test")
def test(body: ConnectionInput, user: ConfigurationManager, db: Database):
    return test_connection(body, db)


@router.get("/projects/{project_id}/ai-analyses")
def history(project_id: str, user: ConfigurationManager, db: Database):
    project = accessible_project(project_id, user, db)
    _, source = ai.project_context(db, project)
    rows = db.scalars(
        select(ProjectAIAnalysis)
        .where(ProjectAIAnalysis.project_id == project_id)
        .order_by(ProjectAIAnalysis.created_at.desc())
        .limit(20)
    ).all()
    return [
        {**ai.row_data(row), "stale": row.source.get("fingerprint") != source["fingerprint"]}
        for row in rows
    ]


@router.post("/projects/{project_id}/ai-analyses", status_code=201)
def generate(project_id: str, body: AnalysisInput, user: ConfigurationManager, db: Database):
    project = accessible_project(project_id, user, db)
    context, source = ai.project_context(db, project)
    user_id = user.id
    db.rollback()  # Release the read transaction while waiting for the model.
    cfg = ai.load_settings(db)
    # 本次临时修改的提示词优先，否则用 AI 设置中的默认提示词；实际使用的提示词随报告保存
    prompt = (body.prompt or "").strip() or cfg["analysis_prompt"]
    try:
        content, provider, model, usage = ai.analyze(cfg, context, body.focus.strip(), prompt)
    except ai.AIError as e:
        raise HTTPException(502, str(e)) from None
    # Recheck scope/existence in case the project changed during inference.
    project = accessible_project(project_id, user, db)
    _, current = ai.project_context(db, project)
    record = ProjectAIAnalysis(
        id=uuid4().hex,
        project_id=project_id,
        created_by=user_id,
        created_at=datetime.now(UTC),
        provider=provider,
        model=model,
        focus=body.focus.strip(),
        prompt=prompt,
        content=content,
        source=source,
        usage=usage,
    )
    db.add(record)
    db.commit()
    db.refresh(record)
    return {**ai.row_data(record), "stale": current["fingerprint"] != source["fingerprint"]}


# —— 财务 AI 分析：覆盖全部项目的组合财务，仅 admin / cmc_lead（与预算维护同权限）—— #


@router.get("/finances/ai-analyses")
def finance_history(user: FinanceManager, db: Database):
    _, source = ai.finance_context(db)
    rows = db.scalars(
        select(FinanceAIAnalysis).order_by(FinanceAIAnalysis.created_at.desc()).limit(20)
    ).all()
    return [
        {**ai.row_data(row), "stale": row.source.get("fingerprint") != source["fingerprint"]}
        for row in rows
    ]


@router.post("/finances/ai-analyses", status_code=201)
def finance_generate(body: AnalysisInput, user: FinanceManager, db: Database):
    context, source = ai.finance_context(db)
    user_id = user.id
    db.rollback()  # Release the read transaction while waiting for the model.
    cfg = ai.load_settings(db)
    prompt = (body.prompt or "").strip() or cfg["finance_analysis_prompt"]
    try:
        content, provider, model, usage = ai.analyze(
            cfg, context, body.focus.strip(), prompt, kind="finance"
        )
    except ai.AIError as e:
        raise HTTPException(502, str(e)) from None
    _, current = ai.finance_context(db)
    record = FinanceAIAnalysis(
        id=uuid4().hex,
        created_by=user_id,
        created_at=datetime.now(UTC),
        provider=provider,
        model=model,
        focus=body.focus.strip(),
        prompt=prompt,
        content=content,
        source=source,
        usage=usage,
    )
    db.add(record)
    db.commit()
    db.refresh(record)
    return {**ai.row_data(record), "stale": current["fingerprint"] != source["fingerprint"]}
