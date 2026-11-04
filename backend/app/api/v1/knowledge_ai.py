"""KB-specific resource audience; neither portal cookies nor supplied actor IDs work here."""
# ruff: noqa: B008

from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from sqlalchemy.orm import Session

from app.core import security
from app.core.config import settings
from app.db.session import get_db
from app.schemas.knowledge_ai import Completion
from app.services import assistant_diagnostics as diagnostics
from app.services import knowledge_ai as service
from app.services import oidc_logout, oidc_status, password_policy


class SafeRoute(APIRoute):
    def get_route_handler(self):
        original = super().get_route_handler()

        async def handle(request):
            try:
                return await original(request)
            except RequestValidationError:
                # Do not echo model prompts, accidental keys or tool results in errors.
                raise HTTPException(422, "统一模型请求格式不正确或超出容量限制") from None

        return handle


router = APIRouter(prefix="/integration/knowledge/ai", tags=["knowledge-ai"], route_class=SafeRoute)


def identity(request: Request, db: Session = Depends(get_db)):
    audience = settings.KNOWLEDGE_AI_CLIENT_ID
    if (
        not settings.KNOWLEDGE_AI_ENABLED
        or not audience
        or audience in {settings.CASDOOR_CLIENT_ID, settings.portal_client_id}
        or not settings.OIDC_GLOBAL_LOGOUT_ENABLED
        or not settings.CASDOOR_ACCOUNT_STATUS_VISIBLE
    ):
        raise HTTPException(503, "知识库统一模型入口尚未启用或身份核验尚未配置")
    scheme, _, token = request.headers.get("authorization", "").partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(401, "需要当前知识库用户的有效身份令牌")
    claims = security.decode_access_token(token, audience=audience)
    if (
        claims.get("owner") != settings.CASDOOR_ORG
        or not isinstance(claims.get("sub"), str)
        or not 0 < len(claims["sub"]) <= 255
    ):
        raise HTTPException(403, "当前身份不属于知识库组织")
    oidc_logout.ensure_not_revoked(db, claims, audience)
    # Mandatory here even though older application endpoints support a staged rollout flag.
    oidc_status.ensure_active_token(token, claims, expected_audience=audience)
    roles = {
        item.get("name")
        for item in claims.get("roles", [])
        if isinstance(item, dict)
        and item.get("owner") == settings.CASDOOR_ORG
        and item.get("isEnabled", True) is True
    }
    if not roles & {"kb_manager", "kb_editor", "kb_viewer"}:
        raise HTTPException(403, "当前账号没有知识库访问权限")
    if password_policy.observe_identity(db, claims):
        db.commit()
    password_policy.enforce(db, claims["sub"], request.url.path)
    return claims


@router.get("/models")
def models(db: Session = Depends(get_db), claims: dict = Depends(identity)):
    return service.models(db, claims)


@router.post("/chat/completions")
def completion(
    payload: Completion,
    response: Response,
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    with diagnostics.request_scope(str(uuid4())) as trace:
        response.headers[diagnostics.ID_HEADER] = trace.id
        return service.complete(db, claims, payload)
