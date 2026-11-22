"""Domain-owned PM register (risk/issue/decision) helpers and persistence."""

import json
from datetime import UTC, date, datetime
from typing import Literal
from uuid import uuid4

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy.orm import Session

from app.models import Project, User
from app.models.audit_log import AuditLog
from app.models.pm_management import PMRegisterEntry
from app.services.scope import is_full_access, visible_project_ids_for
from app.services.team import check_owner


class RegisterInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    kind: Literal["risk", "issue", "decision"]
    title: str = Field(min_length=1, max_length=200)
    owner_id: str = Field(min_length=1, max_length=64)
    due_date: date
    severity: Literal["high", "medium", "low"] = "medium"
    status: Literal["open", "closed"] = "open"
    mitigation: str = Field(default="", max_length=5000)
    closure: str = Field(default="", max_length=5000)
    expected_revision: int | None = Field(default=None, ge=1)

    @model_validator(mode="after")
    def closed_reason(self):
        if self.status == "closed" and not self.closure:
            raise ValueError("关闭事项须填写处理结果或决策结论")
        return self


def project_access(db, user, project_id, write=False):
    project = db.get(Project, project_id)
    if not project or (
        not is_full_access(user) and project_id not in visible_project_ids_for(user, db)
    ):
        raise HTTPException(404, "项目不存在或无权访问")
    if write and user.role not in {"admin", "cmc_lead", "project_lead"}:
        raise HTTPException(403, "仅项目管理者可维护台账")
    return project


def audit(db, user, project_id, action, before, after):
    db.add(
        AuditLog(
            id=f"log-{uuid4().hex[:12]}",
            actor_id=user.id,
            action=action,
            target="项目",
            target_id=project_id,
            created_at=datetime.now(UTC),
            detail=json.dumps({"before": before, "after": after}, ensure_ascii=False, default=str),
        )
    )


def register_view(row):
    return {
        key: getattr(row, key)
        for key in (
            "id",
            "project_id",
            "kind",
            "title",
            "owner_id",
            "due_date",
            "severity",
            "status",
            "mitigation",
            "closure",
            "revision",
            "updated_at",
        )
    }


def create_register_record(project_id: str, data: RegisterInput, db: Session, user: User):
    project = project_access(db, user, project_id, True)
    check_owner(db, project, data.owner_id)
    row = PMRegisterEntry(
        id=f"reg-{uuid4().hex[:20]}",
        project_id=project_id,
        **data.model_dump(exclude={"expected_revision"}),
    )
    db.add(row)
    audit(
        db,
        user,
        project_id,
        "创建项目跟进事项",
        None,
        data.model_dump(exclude={"expected_revision"}),
    )
    db.flush()
    return row


def register_project_id(db: Session, entry_id: str) -> str | None:
    return db.query(PMRegisterEntry.project_id).filter_by(id=entry_id).scalar()


def get_register_entry(db: Session, entry_id: str) -> PMRegisterEntry | None:
    return db.get(PMRegisterEntry, entry_id)


def lock_register_entries(db: Session, entry_ids: list[str]) -> list[PMRegisterEntry]:
    if not entry_ids:
        return []
    return (
        db.query(PMRegisterEntry)
        .filter(PMRegisterEntry.id.in_(entry_ids))
        .order_by(PMRegisterEntry.id)
        .with_for_update()
        .populate_existing()
        .all()
    )


def insert_register_entry(
    db: Session, *, entry_id: str, project_id: str, **values
) -> PMRegisterEntry:
    row = PMRegisterEntry(id=entry_id, project_id=project_id, **values)
    db.add(row)
    return row


def update_register_entry_fields(db: Session, entry_id: str, changes: dict) -> PMRegisterEntry:
    row = db.query(PMRegisterEntry).filter_by(id=entry_id).with_for_update().one()
    for field, value in changes.items():
        setattr(row, field, value)
    row.revision += 1
    return row
