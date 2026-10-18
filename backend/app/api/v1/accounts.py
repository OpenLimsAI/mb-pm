"""门户「账号管理」：IAM 的简化版。系统管理员建账号、设身份、维护成员档案，修改直接写入 IAM；项目负责人只能查看。

路由（门户会话；写操作要求门户 Origin）：
    GET    /api/v1/portal/accounts                       账号列表 + 需要处理的问题
    POST   /api/v1/portal/accounts                       新建账号（首次登录须改密码）并分配权限
    PATCH  /api/v1/portal/accounts/{id}                  改资料 / 平台身份 / PM 业务角色 / KB 编辑授权 / 启用状态
    POST   /api/v1/portal/accounts/{id}/username         改用户名（项目管理成员同步）
    POST   /api/v1/portal/accounts/{id}/password         重置密码（首次登录须改密码）
    POST   /api/v1/portal/accounts/{id}/repair           修复密码标记及 PM 成员，不授予知识库权限
    DELETE /api/v1/portal/accounts/{id}                  删除 IAM 账号（项目管理成员只停用）

{id} 为 IAM 用户 ID（sub）。每次请求都向 IAM 实时核对调用者的身份，规则见 services/accounts.py。
"""

from fastapi import APIRouter, Depends, Path, Request, status
from sqlalchemy.orm import Session

from app.api.deps import require_same_origin
from app.api.v1.portal import session_claims
from app.core.config import settings
from app.db.session import get_db
from app.schemas.accounts import (
    AccountCreate,
    AccountsOut,
    AccountUpdate,
    PasswordReset,
    UsernameUpdate,
)
from app.services import accounts
from app.services.accounts import Actor

router = APIRouter(prefix="/portal/accounts", tags=["accounts"])
AccountId = Path(min_length=1, max_length=255)


def reader(request: Request, db: Session = Depends(get_db)) -> Actor:
    return accounts.require_manager(session_claims(request, db), db)


def writer(request: Request, db: Session = Depends(get_db)) -> Actor:
    require_same_origin(request, origin=settings.portal_origin)
    return accounts.require_manager(session_claims(request, db), db)


@router.get("", response_model=AccountsOut)
def list_accounts(db: Session = Depends(get_db), actor: Actor = Depends(reader)):
    return accounts.snapshot(db, actor)


@router.post("", status_code=status.HTTP_204_NO_CONTENT)
def create_account(
    payload: AccountCreate, db: Session = Depends(get_db), actor: Actor = Depends(writer)
):
    accounts.create(db, actor, payload)


@router.patch("/{account_id}", status_code=status.HTTP_204_NO_CONTENT)
def update_account(
    payload: AccountUpdate,
    account_id: str = AccountId,
    db: Session = Depends(get_db),
    actor: Actor = Depends(writer),
):
    accounts.update(db, actor, account_id, payload)


@router.post("/{account_id}/username", status_code=status.HTTP_204_NO_CONTENT)
def rename_account(
    payload: UsernameUpdate,
    account_id: str = AccountId,
    db: Session = Depends(get_db),
    actor: Actor = Depends(writer),
):
    accounts.rename(db, actor, account_id, payload.username)


@router.post("/{account_id}/password", status_code=status.HTTP_204_NO_CONTENT)
def reset_password(
    payload: PasswordReset,
    account_id: str = AccountId,
    db: Session = Depends(get_db),
    actor: Actor = Depends(writer),
):
    accounts.reset_password(db, actor, account_id, payload.password)


@router.post("/{account_id}/repair", status_code=status.HTTP_204_NO_CONTENT)
def repair_account(
    account_id: str = AccountId, db: Session = Depends(get_db), actor: Actor = Depends(writer)
):
    accounts.repair(db, actor, account_id)


@router.delete("/{account_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_account(
    account_id: str = AccountId, db: Session = Depends(get_db), actor: Actor = Depends(writer)
):
    accounts.delete(db, actor, account_id)
