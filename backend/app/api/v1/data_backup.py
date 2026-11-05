"""System-admin-only backup inventory and explicitly selected deletion."""

import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from sqlalchemy.orm import Session

from app.api.deps import require_same_origin
from app.api.v1 import portal
from app.core.config import settings
from app.db.session import get_db
from app.schemas.data_backup import DeletePreviewInput, DeletionInput
from app.services import accounts, data_backup, password_policy
from app.services.iam_admin import IAMError

logger = logging.getLogger("cmc-pms.data-backup")


class NoCacheRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def protected(request):
            try:
                response = await handler(request)
            except HTTPException as exc:
                response = JSONResponse(
                    {"detail": exc.detail}, status_code=exc.status_code, headers=exc.headers
                )
            except RequestValidationError as exc:
                # Do not echo input values, which may contain a mistakenly pasted credential.
                response = JSONResponse(
                    {
                        "detail": [
                            {key: error[key] for key in ("loc", "msg", "type")}
                            for error in exc.errors()
                        ]
                    },
                    status_code=422,
                )
            except Exception as exc:
                logger.error("Backup request failed (%s)", type(exc).__name__)
                response = JSONResponse(
                    {"detail": "数据备份请求失败，请刷新状态后重试"}, status_code=500
                )
            response.headers["Cache-Control"] = "no-store"
            response.headers["Pragma"] = "no-cache"
            return response

        return protected


router = APIRouter(prefix="/data-backup", tags=["data-backup"], route_class=NoCacheRoute)


def administrator(request: Request, db: Annotated[Session, Depends(get_db)]):
    claims = portal.session_claims(request, db)
    password_policy.enforce(db, claims["sub"], request.url.path)
    if request.headers.get("X-Backup-Expected-Identity") != claims["sub"]:
        raise HTTPException(
            409,
            {"code": "backup_identity_changed", "message": "登录账号已变化，请刷新页面后再操作"},
        )
    if request.method not in {"GET", "HEAD", "OPTIONS"}:
        require_same_origin(request, origin=settings.portal_origin)
    try:
        roles = accounts.live_roles(claims["sub"])
    except IAMError:
        raise HTTPException(503, "暂时无法确认系统管理员权限，请稍后重试") from None
    if "admin" not in roles:
        raise HTTPException(403, "数据备份仅限系统管理员使用")
    return claims


Admin = Annotated[dict, Depends(administrator)]


@router.get("/snapshot")
def snapshot(_claims: Admin):
    return data_backup.snapshot()


@router.post("/delete-preview")
def delete_preview(body: DeletePreviewInput, claims: Admin):
    return data_backup.delete_preview(body, claims["sub"])


@router.post("/deletions")
def delete_archives(body: DeletionInput, claims: Admin):
    return data_backup.delete_archives(body, claims["sub"])
