"""Personal AI task conversations authenticated by the portal."""
# ruff: noqa: B008

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy.orm import Session

from app.api.deps import require_same_origin
from app.api.v1 import portal
from app.core.config import settings
from app.db.session import get_db
from app.schemas.assistant import TaskCreate, TaskQuestion, TaskRevision, TaskSave
from app.services import assistant as service
from app.services import assistant_diagnostics as diagnostics
from app.services import assistant_operations, assistant_requests, password_policy, web_search

router = APIRouter(prefix="/assistant/tasks", tags=["ai-assistant"])


def job_response(response, action):
    response.headers["Cache-Control"] = "no-store"
    try:
        return action()
    except HTTPException as exc:
        raise HTTPException(
            exc.status_code,
            exc.detail,
            headers={**(exc.headers or {}), "Cache-Control": "no-store"},
        ) from None


def identity(request: Request, db: Session = Depends(get_db)):
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        require_same_origin(request, origin=settings.portal_origin)
    claims = portal.session_claims(request, db)
    password_policy.enforce(db, claims["sub"], request.url.path)
    return claims


@router.get("")
def listing(
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
    search: str = Query(default="", max_length=200),
    trashed: bool = False,
    offset: int = Query(default=0, ge=0, le=1000000),
):
    return service.listing(db, claims, search, trashed, offset)


@router.post("", status_code=201)
def create(payload: TaskCreate, db: Session = Depends(get_db), claims: dict = Depends(identity)):
    return service.create(db, claims, payload)


@router.get("/capabilities")
def capabilities(
    model_profile_id: str | None = Query(default=None, min_length=1, max_length=100),
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    return web_search.capabilities_for_model(db, claims, model_profile_id)


@router.get("/operations")
def operations(
    response: Response,
    diagnostic_id: str = Query(default="", max_length=32, pattern=r"^(?:[a-f0-9]{32})?$"),
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    return job_response(response, lambda: assistant_operations.overview(db, claims, diagnostic_id))


@router.put("/operations/settings")
def operation_settings(
    payload: assistant_operations.Limits,
    response: Response,
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    return job_response(response, lambda: assistant_operations.save_limits(db, claims, payload))


@router.post("/operations/prune")
def prune_requests(
    response: Response, db: Session = Depends(get_db), claims: dict = Depends(identity)
):
    return job_response(response, lambda: assistant_operations.prune(db, claims))


@router.post("/preflight")
def preflight(
    payload: assistant_operations.Preflight,
    response: Response,
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    return job_response(response, lambda: assistant_operations.preflight(db, claims, payload))


@router.get("/{task_id}/sources")
def read_source(
    task_id: str,
    response: Response,
    path: str = Query(max_length=1024),
    offset: int = Query(default=0, ge=0, le=500000),
    length: int = Query(default=8000, ge=1, le=12000),
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    return job_response(
        response,
        lambda: service.read_source(
            db, claims, service.get_task(db, task_id, claims), path, offset, length
        ),
    )


@router.get("/{task_id}")
def detail(task_id: str, db: Session = Depends(get_db), claims: dict = Depends(identity)):
    return service.detail(db, service.get_task(db, task_id, claims), claims)


@router.put("/{task_id}")
def save(
    task_id: str, payload: TaskSave, db: Session = Depends(get_db), claims: dict = Depends(identity)
):
    task = service.get_task(db, task_id, claims)
    service.active(task)
    return service.change(
        db,
        claims,
        task,
        payload.revision,
        payload.model_dump(exclude={"revision"}, exclude_unset=True),
    )


@router.post("/{task_id}/messages")
def question(
    task_id: str,
    payload: TaskQuestion,
    response: Response,
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    with diagnostics.request_scope(payload.request_id) as trace:
        response.headers[diagnostics.ID_HEADER] = trace.id
        return assistant_requests.run_inline(
            db, claims, service.get_task(db, task_id, claims), payload
        )


@router.post("/{task_id}/requests", status_code=202)
def submit_request(
    task_id: str,
    payload: TaskQuestion,
    response: Response,
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    return job_response(
        response,
        lambda: assistant_requests.submit(
            db, claims, service.get_task(db, task_id, claims), payload
        )[2],
    )


@router.get("/{task_id}/requests/active")
def active_request(
    task_id: str,
    response: Response,
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    return job_response(response, lambda: assistant_requests.get_active(db, claims, task_id))


@router.get("/{task_id}/requests/{request_id}")
def request_status(
    task_id: str,
    request_id: str,
    response: Response,
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    return job_response(response, lambda: assistant_requests.get(db, claims, task_id, request_id))


@router.post("/{task_id}/requests/{request_id}/cancel")
def cancel_request(
    task_id: str,
    request_id: str,
    response: Response,
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    return job_response(
        response, lambda: assistant_requests.cancel(db, claims, task_id, request_id)
    )


@router.post("/{task_id}/trash")
def trash(
    task_id: str,
    payload: TaskRevision,
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    task = service.get_task(db, task_id, claims)
    return service.set_trashed(db, claims, task, payload.revision, trashed=True)


@router.post("/{task_id}/restore")
def restore(
    task_id: str,
    payload: TaskRevision,
    db: Session = Depends(get_db),
    claims: dict = Depends(identity),
):
    task = service.get_task(db, task_id, claims)
    return service.set_trashed(db, claims, task, payload.revision, trashed=False)
