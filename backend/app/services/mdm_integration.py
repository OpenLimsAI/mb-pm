"""One database transaction creates a PM project, durable receipt and audit."""

import hashlib
import json
from datetime import UTC, datetime
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models import AuditLog, Project, User
from app.models.mdm_integration import MDMProjectReceipt
from app.schemas.mdm_integration import MDMProjectCreate


def fingerprint(body: MDMProjectCreate) -> str:
    payload = body.model_dump(mode="json", exclude={"request_id"})
    return hashlib.sha256(
        json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def _lock(db: Session, *values: str) -> None:
    if db.bind.dialect.name != "postgresql":
        return
    keys = sorted(
        {
            int.from_bytes(hashlib.sha256(("mdm-create:" + v).encode()).digest()[:8], signed=True)
            for v in values
        }
    )
    for key in keys:
        db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": key})


def describe(db: Session, receipt: MDMProjectReceipt) -> dict:
    project = db.get(Project, receipt.project_id)
    if project is None:
        raise HTTPException(409, "创建回执对应项目已不存在，需人工对账")
    reference = {
        "id": project.id,
        "code": project.code,
        "name": project.name,
        "status": project.status,
        "bindable": project.status in {"活跃", "暂停"},
    }
    return {
        "request_id": receipt.request_id,
        "source_id": receipt.source_id,
        "source_project_id": receipt.source_project_id,
        "project_id": project.id,
        "code": project.code,
        "name": project.name,
        "status": project.status,
        "bindable": reference["bindable"],
        "created_by": receipt.created_by,
        "project": reference,
    }


def get_receipt(db: Session, request_id: str, actor: User) -> dict:
    receipt = db.get(MDMProjectReceipt, request_id)
    if receipt is None or receipt.created_by != actor.id:
        raise HTTPException(404, "创建请求不存在或无权读取")
    return describe(db, receipt)


def create_project(db: Session, body: MDMProjectCreate, actor: User) -> tuple[dict, bool]:
    if body.source_id != settings.MDM_SOURCE_NAMESPACE:
        raise HTTPException(400, "登记来源与服务配置不符")
    request_id = str(body.request_id)
    request_hash = fingerprint(body)
    _lock(
        db,
        "request:" + request_id,
        "source:" + body.source_id + ":" + body.source_project_id,
        "code:" + body.project.code,
    )

    def existing():
        receipt = db.get(MDMProjectReceipt, request_id)
        if receipt:
            if receipt.created_by != actor.id:
                raise HTTPException(404, "创建请求不存在或无权读取")
            if receipt.request_hash != request_hash:
                raise HTTPException(409, "同一请求标识不可用于不同创建参数")
            return describe(db, receipt), False
        return None

    repeat = existing()
    if repeat is not None:
        return repeat
    if db.scalar(
        select(MDMProjectReceipt.request_id).where(
            MDMProjectReceipt.source_id == body.source_id,
            MDMProjectReceipt.source_project_id == body.source_project_id,
        )
    ):
        repeat = existing()
        if repeat is not None:
            return repeat
        raise HTTPException(409, "该登记项目已有创建请求，须使用原请求对账")
    owner = db.get(User, body.project.owner_id)
    if owner is None or not owner.is_active:
        raise HTTPException(422, "项目负责人不存在或已停用")
    if db.scalar(select(Project.id).where(Project.code == body.project.code)):
        repeat = existing()
        if repeat is not None:
            return repeat
        raise HTTPException(409, "执行项目编号已存在，不能按编号自动关联")
    project = Project(
        id="p-mdm-" + uuid4().hex[:24],
        **body.project.model_dump(),
        status="活跃",
        health="green",
        progress=0,
    )
    receipt = MDMProjectReceipt(
        request_id=request_id,
        source_id=body.source_id,
        source_project_id=body.source_project_id,
        request_hash=request_hash,
        project_id=project.id,
        created_by=actor.id,
    )
    try:
        db.add(project)
        db.flush()
        db.add(receipt)
        db.add(
            AuditLog(
                id="al-" + uuid4().hex[:24],
                actor_id=actor.id,
                action="mdm_project_create",
                target="project",
                target_id=project.id,
                created_at=datetime.now(UTC),
                detail=json.dumps(
                    {
                        "request_id": request_id,
                        "source_id": body.source_id,
                        "source_project_id": body.source_project_id,
                        "owner_id": body.project.owner_id,
                    },
                    ensure_ascii=False,
                ),
            )
        )
        db.commit()
    except IntegrityError:
        db.rollback()
        repeat = existing()
        if repeat is not None:
            return repeat
        raise HTTPException(409, "登记来源、项目或创建请求发生并发冲突，请使用原请求对账") from None
    db.refresh(receipt)
    return describe(db, receipt), True
