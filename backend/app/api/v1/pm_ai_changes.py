"""Reviewed project AI commands; reading an analysis never executes its suggestions."""

from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models import User
from app.services import pm_ai_changes as service

router = APIRouter(prefix="/pm-ai/runs", tags=["project AI changes"])
DB = Annotated[Session, Depends(get_db)]
CurrentUser = Annotated[User, Depends(get_current_user)]


@router.post("/{run_id}/changes/preview")
def preview(run_id: str, body: service.ChangePreviewInput, db: DB, user: CurrentUser):
    return service.preview(db, user, run_id, body)


@router.post("/{run_id}/changes/apply")
def apply(run_id: str, body: service.ChangeApplyInput, db: DB, user: CurrentUser):
    return service.apply(db, user, run_id, body)


@router.get("/{run_id}/changes/receipts")
def receipts(run_id: str, db: DB, user: CurrentUser):
    return service.receipts(db, user, run_id)
