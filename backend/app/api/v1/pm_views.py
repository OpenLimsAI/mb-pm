"""Named views are preferences, never an authorization grant."""

import json
from typing import Annotated, Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models import User
from app.models.pm_view import PMView

DB = Annotated[Session, Depends(get_db)]
Actor = Annotated[User, Depends(get_current_user)]

router = APIRouter(prefix="/pm/views", tags=["project-management"])


class ViewInput(BaseModel):
    kind: Literal["projects", "tasks"]
    name: str = Field(min_length=1, max_length=80)
    state: dict
    revision: int | None = None

    @field_validator("name")
    @classmethod
    def clean_name(cls, value):
        if not value.strip():
            raise ValueError("视图名称不能为空")
        return value.strip()

    @field_validator("state")
    @classmethod
    def bounded_state(cls, value):
        if len(json.dumps(value, ensure_ascii=False)) > 12000:
            raise ValueError("视图设置过大")
        return value


def out(row):
    return {
        "id": row.id,
        "kind": row.kind,
        "name": row.name,
        "state": row.state,
        "revision": row.revision,
    }


@router.get("")
def list_views(db: DB, user: Actor):
    return [
        out(row)
        for row in db.scalars(
            select(PMView).where(PMView.user_id == user.id).order_by(PMView.created_at)
        )
    ]


@router.put("")
def save_view(payload: ViewInput, db: DB, user: Actor):
    # Serialize writes per account, including the maximum-count check.
    db.execute(select(User).where(User.id == user.id).with_for_update())
    rows = list(
        db.scalars(select(PMView).where(PMView.user_id == user.id, PMView.kind == payload.kind))
    )
    row = next((v for v in rows if v.name == payload.name), None)
    if row:
        if payload.revision != row.revision:
            raise HTTPException(409, "视图已更新，请重新载入后保存")
        row.state = payload.state
        row.revision += 1
    else:
        if len(rows) >= 20:
            raise HTTPException(422, "每类最多保存 20 个视图")
        row = PMView(
            id=f"view-{uuid4().hex}",
            user_id=user.id,
            kind=payload.kind,
            name=payload.name,
            state=payload.state,
        )
        db.add(row)
    db.commit()
    db.refresh(row)
    return out(row)


@router.delete("/{view_id}", status_code=204)
def delete_view(view_id: str, db: DB, user: Actor):
    row = db.get(PMView, view_id)
    if not row or row.user_id != user.id:
        raise HTTPException(404, "视图不存在")
    db.delete(row)
    db.commit()
