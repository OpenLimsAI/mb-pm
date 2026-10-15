"""项目结构编辑（概览 / WBS 页签的「编辑模式」，与模板结构编辑同一套用法）。

路由：
    GET /api/v1/projects/{project_id}/structure   结构快照与版本（进入编辑模式时读取）
    PUT /api/v1/projects/{project_id}/structure   统一保存编辑后的完整结构（一个事务，全部生效或全不生效）

权限：admin / cmc_lead，以及能看到该项目的 project_lead；执行层不能修改结构。
"""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.deps import require_role
from app.db.session import get_db
from app.models import Project, User
from app.schemas.structure import StructureSaveIn
from app.services.scope import visible_project_ids_for
from app.services.structure import apply_structure, structure_snapshot

router = APIRouter(prefix="/projects", tags=["structure"])
editor = require_role("admin", "cmc_lead", "project_lead")


def _project(project_id: str, user: User, db: Session) -> Project:
    project = db.get(Project, project_id)
    if project is None or project_id not in visible_project_ids_for(user, db):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "项目不存在或无权访问")
    return project


@router.get("/{project_id}/structure")
def get_structure(project_id: str, db: Session = Depends(get_db), user: User = Depends(editor)):
    return structure_snapshot(db, _project(project_id, user, db))


@router.put("/{project_id}/structure")
def save_structure(
    project_id: str,
    body: StructureSaveIn,
    db: Session = Depends(get_db),
    user: User = Depends(editor),
):
    project = _project(project_id, user, db)
    result = apply_structure(db, project, body, user)
    return {"result": result, **structure_snapshot(db, project)}
