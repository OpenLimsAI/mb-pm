# ruff: noqa: B008
"""User-confirmed global incremental indexing for existing manual upload receipts."""

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import Field, StrictBool
from sqlalchemy.orm import Session

from app.api.v1.knowledge_sources import Input, connected, principal, require_worker
from app.db.session import get_db
from app.services import knowledge_source_manual_index_v3 as manual
from app.services.information.store import Store

router = APIRouter(prefix="/knowledge-sources/v3/library", tags=["knowledge-source-manual-index"])


class ManualIndexInput(Input):
    paper_id: str = Field(alias="paperId", min_length=1, max_length=1100)
    confirmed: StrictBool


@router.post("/manual-index", status_code=202)
def start_manual_index(
    body: ManualIndexInput, db: Session = Depends(get_db), actor=Depends(principal)
):
    if body.confirmed is not True:
        raise HTTPException(422, "请先确认此操作会处理知识库中所有待索引资料")
    require_worker()
    return manual.create_job(Store(db, actor["tenant"]), actor, body.paper_id, connector=connected)


@router.get("/manual-index/status")
def manual_index_status(
    paper_id: str = Query(alias="paperId", min_length=1, max_length=1100),
    db: Session = Depends(get_db),
    actor=Depends(principal),
):
    store = Store(db, actor["tenant"])
    _, _, version, _ = manual.resolve_manual(store, actor["subject"], paper_id, connected)
    can_start = True
    try:
        manual.manager_authority(db, actor["subject"])
    except HTTPException as exc:
        if exc.status_code != 403:
            raise
        can_start = False
    return {**manual.public_status(store, version), "canStart": can_start}
