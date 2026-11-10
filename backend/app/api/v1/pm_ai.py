"""Permission-scoped project context and durable, reviewable analysis runs."""

from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models import User
from app.models.pm_ai import PMAIRun
from app.services import pm_ai_runs
from app.services.pm_ai_context import ContextRequest, build_context, recheck_user

router = APIRouter(prefix="/pm-ai", tags=["project-ai-assistant"])
DB = Annotated[Session, Depends(get_db)]


def active_user(db: DB, user: Annotated[User, Depends(get_current_user)]):
    return recheck_user(db, user.id)


CurrentUser = Annotated[User, Depends(active_user)]


@router.get("/context")
def get_context(db: DB, user: CurrentUser, project_id: str | None = None):
    return build_context(db, user, ContextRequest(project_ids=[project_id] if project_id else []))


@router.post("/runs", status_code=202)
def create_run(payload: ContextRequest, db: DB, user: CurrentUser):
    return pm_ai_runs.run_view(pm_ai_runs.create_run(db, user, payload))


@router.get("/runs")
def list_runs(
    db: DB, user: CurrentUser, page: int = Query(1, ge=1), page_size: int = Query(20, ge=1, le=50)
):
    query = db.query(PMAIRun).filter_by(created_by=user.id)
    rows = (
        query.order_by(PMAIRun.created_at.desc(), PMAIRun.id)
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    items = []
    for row in rows:
        try:
            pm_ai_runs.authorize_run(db, user, row)
        except HTTPException:
            continue
        items.append(pm_ai_runs.run_view(row))
    return {"items": items, "total": query.count(), "page": page, "page_size": page_size}


@router.get("/runs/{run_id}")
def get_run(run_id: str, db: DB, user: CurrentUser):
    run = pm_ai_runs.get_run(db, user, run_id)
    result = pm_ai_runs.run_view(run)
    if run.state == "succeeded":
        current = build_context(db, user, ContextRequest.model_validate(run.request))
        result["stale"] = current["source"]["fingerprint"] != run.source.get("fingerprint")
    return result


@router.post("/runs/{run_id}/cancel")
def cancel_run(run_id: str, db: DB, user: CurrentUser):
    run = pm_ai_runs.get_run(db, user, run_id)
    run = db.query(PMAIRun).filter_by(id=run.id).with_for_update().populate_existing().one()
    if run.state in {"queued", "running"}:
        run.state, run.finished_at, run.claim = "cancelled", datetime.now(UTC), None
        db.commit()
    return pm_ai_runs.run_view(run)
