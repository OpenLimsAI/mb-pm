"""Dedicated delegated-user audience; ordinary PM routes do not accept it."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.config import settings
from app.core.security import decode_access_token, resolve_identity
from app.db.session import get_db
from app.models import User
from app.schemas.mdm_integration import PRODUCT_TYPES, STAGES, MDMProjectCreate
from app.services import password_policy
from app.services.mdm_integration import create_project, get_receipt

router = APIRouter(prefix="/integration/mdm", tags=["mdm-integration"])


def delegated_user(request: Request, db: Annotated[Session, Depends(get_db)]) -> User:
    audience = settings.MDM_DELEGATION_CLIENT_ID
    if not audience or audience in {settings.CASDOOR_CLIENT_ID, settings.portal_client_id}:
        raise HTTPException(503, "独立MDM项目委托受众尚未配置")
    authorization = request.headers.get("authorization", "")
    if not authorization.startswith("Bearer "):
        raise HTTPException(401, "需要本用户的独立PM委托令牌")
    claims = decode_access_token(authorization[7:].strip(), audience=audience)
    from app.services.oidc_logout import ensure_not_revoked

    ensure_not_revoked(db, claims, audience)
    from app.services.oidc_status import ensure_active_token

    ensure_active_token(authorization[7:].strip(), claims, expected_audience=audience)
    user = resolve_identity(claims, db, bind=False)
    password_policy.enforce(db, claims["sub"], request.url.path)
    return user


def creator(user: Annotated[User, Depends(delegated_user)]) -> User:
    if user.role not in {"admin", "cmc_lead"}:
        raise HTTPException(403, "当前PM角色无权从MDM创建执行项目")
    return user


def reference_user(request: Request, db: Annotated[Session, Depends(get_db)]) -> User:
    authorization = request.headers.get("authorization", "")
    if authorization:
        try:
            return get_current_user(request, db)
        except HTTPException as exc:
            if exc.status_code != 401 or not settings.MDM_DELEGATION_CLIENT_ID:
                raise
        return delegated_user(request, db)
    return get_current_user(request, db)


@router.get("/owners")
def owners(user: Annotated[User, Depends(creator)], db: Annotated[Session, Depends(get_db)]):
    rows = db.scalars(
        select(User).where(User.is_active.is_(True)).order_by(User.display_name, User.id)
    ).all()
    return {
        "items": [{"id": x.id, "display_name": x.display_name} for x in rows],
        "current_user_id": user.id,
        "options": {"product_types": PRODUCT_TYPES, "stages": STAGES},
    }


@router.post("/projects")
def create(
    body: MDMProjectCreate,
    response: Response,
    user: Annotated[User, Depends(creator)],
    db: Annotated[Session, Depends(get_db)],
):
    receipt, created = create_project(db, body, user)
    response.status_code = 201 if created else 200
    response.headers["Cache-Control"] = "no-store"
    return receipt


@router.get("/projects/{request_id}")
def receipt(
    request_id: UUID,
    response: Response,
    user: Annotated[User, Depends(creator)],
    db: Annotated[Session, Depends(get_db)],
):
    response.headers["Cache-Control"] = "no-store"
    return get_receipt(db, str(request_id), user)
