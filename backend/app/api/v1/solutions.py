# ruff: noqa: B008
"""Authenticated solution application, independent of PM business membership."""

from urllib.parse import quote
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import require_same_origin
from app.api.v1 import portal
from app.core.config import settings
from app.db.session import get_db
from app.models.solution import KnowledgeSolution, SolutionAnswer, SolutionSource
from app.schemas.solution import (
    AskInput,
    PolishInput,
    ReviewAction,
    SolutionInput,
    SolutionRevision,
    SolutionSave,
    SourceInput,
)
from app.schemas.solution_ai import ModelSettingsInput, ModelTestInput
from app.services import assistant_diagnostics as diagnostics
from app.services import password_policy, solution_ai, solution_knowledge
from app.services import solutions as service

router = APIRouter(prefix="/solutions", tags=["solutions"])


def identity(request: Request, db: Session = Depends(get_db)):
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        require_same_origin(request, origin=settings.portal_origin)
    claims = portal.session_claims(request, db)
    password_policy.enforce(db, claims["sub"], request.url.path)
    return claims


class PrivateModelRoute(APIRoute):
    """FastAPI validation must never echo draft API keys in its `input` error field."""

    def get_route_handler(self):
        original = super().get_route_handler()

        async def safe_handler(request):
            try:
                return await original(request)
            except RequestValidationError:
                raise HTTPException(
                    422, "模型配置格式不正确，请检查必填项、长度和默认模型"
                ) from None

        return safe_handler


model_router = APIRouter(prefix="/ai", route_class=PrivateModelRoute)


@model_router.get("/settings")
def ai_settings(db: Session = Depends(get_db), claims: dict = Depends(identity)):
    return solution_ai.settings(db, claims)


@model_router.put("/settings")
def save_ai_settings(
    payload: ModelSettingsInput, db: Session = Depends(get_db), claims: dict = Depends(identity)
):
    return solution_ai.save_settings(db, claims, payload)


@model_router.post("/test")
def test_ai_settings(
    payload: ModelTestInput, db: Session = Depends(get_db), claims: dict = Depends(identity)
):
    return solution_ai.test_connection(db, claims, payload)


router.include_router(model_router)


@router.get("")
@router.get("/")
def listing(db: Session = Depends(get_db), claims: dict = Depends(identity)):
    rows = db.scalars(
        select(KnowledgeSolution)
        .where(service.readable(claims))
        .order_by(KnowledgeSolution.updated_at.desc())
    ).all()
    result = []
    for row in rows:
        # A revoked KB grant must also remove titles/body from the application list.
        try:
            service.check_solution_evidence(db, row, claims)
        except HTTPException as exc:
            if exc.status_code in (403, 404):
                continue
            raise
        result.append(service.solution_out(row, claims))
    return result


@router.post("", status_code=201)
@router.post("/", status_code=201)
def create(payload: SolutionInput, db: Session = Depends(get_db), claims: dict = Depends(identity)):
    return service.create_solution(db, payload, claims)


@router.get("/trash")
def trash_listing(db: Session = Depends(get_db), claims: dict = Depends(identity)):
    rows = db.scalars(
        select(KnowledgeSolution)
        .where(
            KnowledgeSolution.issuer == claims["iss"],
            KnowledgeSolution.owner_id == claims["sub"],
            KnowledgeSolution.deleted_at.is_not(None),
        )
        .order_by(KnowledgeSolution.deleted_at.desc())
    ).all()
    result = []
    for row in rows:
        try:
            service.check_solution_evidence(db, row, claims)
        except HTTPException as exc:
            if exc.status_code in (403, 404):
                continue
            raise
        result.append(
            {
                "id": row.id,
                "title": row.title,
                "revision": row.revision,
                "deleted_at": row.deleted_at,
            }
        )
    return result


@router.post("/trash/{solution_id}/restore")
def restore_trash(
    solution_id: str,
    payload: SolutionRevision,
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    row = db.scalar(
        select(KnowledgeSolution).where(
            KnowledgeSolution.id == solution_id,
            KnowledgeSolution.issuer == claims["iss"],
            KnowledgeSolution.owner_id == claims["sub"],
            KnowledgeSolution.deleted_at.is_not(None),
        )
    )
    if not row:
        raise HTTPException(404, "报告不存在或无权访问")
    service.check_solution_evidence(db, row, claims)
    return service.restore_trashed_solution(db, row, payload.revision, claims)


@router.post("/{solution_id}/trash", status_code=204)
def trash(
    solution_id: str,
    payload: SolutionRevision,
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    row = service.get_solution(db, solution_id, claims, owner=True)
    service.trash_solution(db, row, payload.revision, claims)
    return Response(status_code=204)


@router.get("/reviewers")
def reviewers(db: Session = Depends(get_db), claims: dict = Depends(identity)):
    return service.reviewers(db, claims)


@router.get("/knowledge/status")
def knowledge_status(claims: dict = Depends(identity)):
    configured = solution_knowledge.configured()
    if not configured:
        return {
            "configured": False,
            "available": False,
            "message": "企业知识库连接未配置，可使用本人添加的论文与实践资料",
        }
    try:
        solution_knowledge.check_access(claims)
    except HTTPException as exc:
        return {"configured": True, "available": False, "message": str(exc.detail)}
    return {
        "configured": True,
        "available": True,
        "message": "已连接企业知识库，按实时知识权限检索",
    }


@router.get("/sources")
def sources(
    query: str = Query("", max_length=1000),
    project_name: str = Query("", max_length=200),
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    statement = service.own_sources(db, claims)
    if project_name:
        statement = statement.where(SolutionSource.project_name == project_name)
    if query.strip():
        # Literal matching; wildcard user input is escaped by SQLAlchemy.
        statement = statement.where(
            SolutionSource.title.contains(query, autoescape=True)
            | SolutionSource.content.contains(query, autoescape=True)
        )
    result = [
        service.source_out(source)
        for source in db.scalars(statement.order_by(SolutionSource.updated_at.desc()))
    ]
    if service.external_available(claims):
        result += solution_knowledge.list_sources(claims, query=query, project_name=project_name)
    return result


@router.post("/sources", status_code=201)
def add_source(
    payload: SourceInput, db: Session = Depends(get_db), claims: dict = Depends(identity)
):
    service.register_actor(db, claims)
    row = SolutionSource(
        id=service.uid(), issuer=claims["iss"], owner_id=claims["sub"], **payload.model_dump()
    )
    db.add(row)
    db.commit()
    return service.source_out(row)


@router.get("/sources/{source_id:path}")
def source_detail(
    source_id: str,
    solution_id: str | None = None,
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    if source_id.startswith("kb:"):
        return solution_knowledge.get_source(claims, source_id)
    source = db.scalar(service.own_sources(db, claims).where(SolutionSource.id == source_id))
    if source:
        return service.source_out(source)
    if solution_id:
        row = service.get_solution(db, solution_id, claims)
        service.check_solution_evidence(db, row, claims)
        refs = [ref for ref in row.references if ref["source_id"] == source_id]
        if refs and row.reviewer_id == claims["sub"]:
            # Reviewer sees only the explicitly granted quote, not the author's library.
            ref = refs[0]
            return {
                "id": source_id,
                "title": ref["title"],
                "kind": "note",
                "authors": "",
                "date": "",
                "project_name": row.project_name,
                "tags": ["仅评审引用片段"],
                "content": "\n\n".join(r["excerpt"] for r in refs),
                "locator": ref["locator"],
                "version": ref["source_version"],
                "url": "",
                "updated_at": row.updated_at,
            }
    raise HTTPException(404, "来源不存在或无权访问")


@router.get("/{solution_id}")
def get(solution_id: str, db: Session = Depends(get_db), claims: dict = Depends(identity)):
    row = service.get_solution(db, solution_id, claims)
    service.check_solution_evidence(db, row, claims)
    return service.solution_out(row, claims)


@router.put("/{solution_id}")
def save(
    solution_id: str,
    payload: SolutionSave,
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    row = service.get_solution(db, solution_id, claims, owner=True)
    return service.save_solution(db, row, payload, claims)


@router.post("/{solution_id}/review")
def review(
    solution_id: str,
    payload: ReviewAction,
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    return service.review_solution(
        db, service.get_solution(db, solution_id, claims), payload, claims
    )


@router.get("/{solution_id}/versions")
def versions(solution_id: str, db: Session = Depends(get_db), claims: dict = Depends(identity)):
    row = service.get_solution(db, solution_id, claims)
    service.check_solution_evidence(db, row, claims)
    return service.version_list(db, row, claims)


@router.post("/{solution_id}/ask")
def ask(
    solution_id: str,
    payload: AskInput,
    response: Response,
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    if payload.answer_mode is None:
        return service.ask(
            db, service.get_solution(db, solution_id, claims, owner=True), payload, claims
        )
    with diagnostics.request_scope(uuid4()) as trace:
        response.headers[diagnostics.ID_HEADER] = trace.id
        return service.ask(
            db, service.get_solution(db, solution_id, claims, owner=True), payload, claims
        )


@router.post("/{solution_id}/polish")
def polish(
    solution_id: str,
    payload: PolishInput,
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    return service.polish(
        db, service.get_solution(db, solution_id, claims, owner=True), payload, claims
    )


@router.get("/{solution_id}/history")
def history(solution_id: str, db: Session = Depends(get_db), claims: dict = Depends(identity)):
    solution = service.get_solution(db, solution_id, claims, owner=True)
    service.check_solution_evidence(db, solution, claims)
    rows = db.scalars(
        select(SolutionAnswer)
        .where(
            SolutionAnswer.solution_id == solution_id,
            SolutionAnswer.issuer == claims["iss"],
            SolutionAnswer.owner_id == claims["sub"],
        )
        .order_by(SolutionAnswer.created_at)
    ).all()
    for row in rows:
        service.check_references(db, row.references, claims, existing=row.references)
    return [service.answer_out(row) for row in rows]


@router.get("/{solution_id}/export")
def export(solution_id: str, db: Session = Depends(get_db), claims: dict = Depends(identity)):
    row = service.get_solution(db, solution_id, claims)
    service.check_solution_evidence(db, row, claims)
    data = service.word_export(row)
    service.event(db, row, claims, "export", {"format": "docx"})
    db.commit()
    filename = quote(row.title[:100] + f"_v{row.version}.docx", safe="")
    return Response(
        data,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{filename}"},
    )


@router.post("/{solution_id}/publish")
def publish(solution_id: str, db: Session = Depends(get_db), claims: dict = Depends(identity)):
    row = service.get_solution(db, solution_id, claims, owner=True)
    try:
        return service.publish(db, row, claims)
    except IntegrityError:
        db.rollback()
        # Unique source-per-version constraint makes retry/concurrent POST idempotent.
        return service.publish(
            db, service.get_solution(db, solution_id, claims, owner=True), claims
        )
