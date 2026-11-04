"""Authenticated Excel export, diff preview and atomic updates of existing tasks."""

import json
import re
from datetime import UTC, datetime
from io import BytesIO
from typing import Annotated
from urllib.parse import quote
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from starlette.datastructures import UploadFile

from app.api.deps import require_role
from app.api.multipart import upload_form
from app.api.v1.task_collaboration import invalidate_acceptance, record_activity
from app.db.session import get_db
from app.models import AuditLog, User
from app.services.project_exchange import export_project, json_value, preview_project, project_state
from app.services.rollup import recompute_project, recompute_subproject

router = APIRouter(prefix="/project-exchange/projects", tags=["project-exchange"])
Db = Annotated[Session, Depends(get_db)]
Manager = Annotated[User, Depends(require_role("admin", "cmc_lead", "project_lead"))]


async def read_upload(request):
    async with upload_form(request, max_files=1, max_fields=2, max_part_size=8192) as form:
        file = form.get("file")
        if not isinstance(file, UploadFile) or not (file.filename or "").lower().endswith(".xlsx"):
            raise HTTPException(422, "请选择 .xlsx 项目工作簿")
        data = await file.read(10 * 1024 * 1024 + 1)
        if len(data) > 10 * 1024 * 1024:
            raise HTTPException(413, "Excel 文件不能超过 10 MiB")
        fingerprint, reason = form.get("fingerprint", ""), form.get("reason", "")
        if not isinstance(fingerprint, str) or not isinstance(reason, str) or len(reason) > 2000:
            raise HTTPException(422, "导入参数格式不正确或原因过长")
    return data, fingerprint, reason.strip()


@router.get("/{project_id}/export")
def export_excel(project_id: str, db: Db, user: Manager):
    state = project_state(db, user, project_id)
    data = export_project(db, state)
    return StreamingResponse(
        BytesIO(data),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": f"attachment; filename=project.xlsx; filename*=UTF-8''{quote(state[0].code + '-项目计划.xlsx', safe='')}",
            "Cache-Control": "no-store",
        },
    )


@router.post("/{project_id}/preview")
async def preview_excel(project_id: str, request: Request, db: Db, user: Manager):
    # Check object scope before parsing an uploaded file.
    state = project_state(db, user, project_id)
    data, _, _ = await read_upload(request)
    return preview_project(data, state)[0]


@router.post("/{project_id}/apply")
async def apply_excel(project_id: str, request: Request, db: Db, user: Manager):
    project_state(db, user, project_id)
    data, fingerprint, reason = await read_upload(request)
    if not re.fullmatch(r"[a-f0-9]{64}", fingerprint) or not reason:
        raise HTTPException(422, "请先预览变更并填写导入原因")
    state = project_state(db, user, project_id, lock=True)
    result, patches = preview_project(data, state)
    if result["fingerprint"] != fingerprint:
        raise HTTPException(
            409, "文件、任务、团队或验收状态已变化，请重新预览；任务已变化时请重新导出"
        )
    if result["errors"]:
        raise HTTPException(
            422, {"message": "工作簿校验失败，未写入任何修改", "errors": result["errors"]}
        )
    if not patches:
        raise HTTPException(422, "没有需要应用的修改")
    changed_subs = set()
    for task, patch in patches:
        actual_changes = {
            key: {"before": json_value(getattr(task, key)), "after": json_value(value)}
            for key, value in patch.items()
        }
        invalidate_acceptance(db, task, user)
        for key, value in patch.items():
            setattr(task, key, value)
        record_activity(db, task, user, "change", f"Excel 回导：{reason}", actual_changes)
        db.add(
            AuditLog(
                id=f"log-{uuid4().hex[:12]}",
                actor_id=user.id,
                action="Excel 回导任务变更",
                target="任务",
                target_id=task.id,
                detail=json.dumps(
                    {"reason": reason, "changes": actual_changes}, ensure_ascii=False
                ),
                created_at=datetime.now(UTC),
            )
        )
        changed_subs.add(task.sub_project_id)
    db.flush()
    for sub_id in changed_subs:
        recompute_subproject(db, sub_id)
    recompute_project(db, project_id)
    db.add(
        AuditLog(
            id=f"log-{uuid4().hex[:12]}",
            actor_id=user.id,
            action="项目 Excel 回导",
            target="项目",
            target_id=project_id,
            detail=json.dumps(
                {
                    "reason": reason,
                    "task_ids": [task.id for task, _ in patches],
                    "fingerprint": fingerprint,
                },
                ensure_ascii=False,
            ),
            created_at=datetime.now(UTC),
        )
    )
    db.commit()
    return {"project_id": project_id, "updated_count": len(patches)}
