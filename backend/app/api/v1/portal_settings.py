"""工作台「我的设置」：本人改用户名。旧门户 AI 设置接口保留兼容；新界面使用 PM /ai/*。
门户会话；写操作要求门户 Origin。

路由：
    POST /api/v1/portal/username            校验当前密码后改 IAM 用户名，同步已绑定的项目管理成员
    GET  /api/v1/portal/settings/ai         AI 设置（密钥只返回是否已设置）
    PUT  /api/v1/portal/settings/ai         保存 AI 设置
    POST /api/v1/portal/settings/ai/models  按填写的连接信息列出可用模型
    POST /api/v1/portal/settings/ai/test    测试连接

AI 设置仅系统管理员 / 项目负责人（cmc_lead）可用，与项目管理 ai.config 一致，每次请求实时核对 IAM 账号与角色；
项目管理的 AI 分析读取同一份设置。
改密码见 portal.py 的 POST /portal/password。管理员设置了临时密码时，改密码前这里的接口一律 403。
"""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.api.deps import require_same_origin
from app.api.v1 import ai as ai_api
from app.api.v1.portal import (
    AI_MANAGERS,
    PORTAL_SESSION_COOKIE,
    session_claims,
    session_data,
    validate_identity,
)
from app.core.config import settings
from app.core.security import digest, seal
from app.db.session import get_db
from app.models import PortalSession
from app.schemas.account import UsernameChange
from app.schemas.ai import AISettingsInput, ConnectionInput
from app.schemas.portal import PortalUserOut
from app.services import accounts, own_account, password_policy

router = APIRouter(prefix="/portal", tags=["portal-settings"])


def _claims(request: Request, db: Session, *, write: bool) -> dict:
    if write:
        require_same_origin(request, origin=settings.portal_origin)
    claims = session_claims(request, db)
    password_policy.enforce(db, claims["sub"], request.url.path)
    return claims


def _require_ai_manager(claims: dict) -> dict:
    # 实时核对 IAM（停用 / 撤销角色立即生效）：AI 设置是全组织共用的，改服务地址会影响所有人的分析数据去向
    if not accounts.live_roles(claims["sub"]) & set(AI_MANAGERS):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "仅系统管理员和项目负责人可修改 AI 设置")
    return claims


def ai_reader(request: Request, db: Session = Depends(get_db)) -> dict:
    return _require_ai_manager(_claims(request, db, write=False))


def ai_writer(request: Request, db: Session = Depends(get_db)) -> dict:
    return _require_ai_manager(_claims(request, db, write=True))


@router.post("/username", response_model=PortalUserOut)
def change_username(payload: UsernameChange, request: Request, db: Session = Depends(get_db)):
    claims = _claims(request, db, write=True)
    own_account.change_own_username(
        db, claims["sub"], payload.new_username, payload.current_password
    )
    # 登录令牌里的用户名要到下次登录才更新：记在本会话里，门户显示新用户名（未绑定项目管理成员时用到）
    from sqlalchemy import select

    session = db.scalar(
        select(PortalSession)
        .where(PortalSession.id == digest(request.cookies.get(PORTAL_SESSION_COOKIE, "")))
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if session is not None:
        session.tokens = seal({**session_data(request, db), "username": payload.new_username})
        db.commit()
    return validate_identity(claims).model_copy(update={"username": payload.new_username})


SharedAIReader = Annotated[dict, Depends(ai_reader)]
SharedAIWriter = Annotated[dict, Depends(ai_writer)]
SharedAIDatabase = Annotated[Session, Depends(get_db)]


@router.get("/settings/ai")
def get_ai_settings(claims: SharedAIReader, db: SharedAIDatabase):
    return ai_api.settings_view(db, claims)


@router.put("/settings/ai")
def put_ai_settings(body: AISettingsInput, claims: SharedAIWriter, db: SharedAIDatabase):
    return ai_api.save_settings(body, db, claims)


@router.post("/settings/ai/models")
def ai_models(body: ConnectionInput, claims: SharedAIWriter, db: SharedAIDatabase):
    return ai_api.list_models(body, db, claims)


@router.post("/settings/ai/test")
def ai_test(body: ConnectionInput, claims: SharedAIWriter, db: SharedAIDatabase):
    return ai_api.test_connection(body, db, claims)
