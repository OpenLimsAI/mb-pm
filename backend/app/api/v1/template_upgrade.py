"""Review and selectively apply template deltas to live projects."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models import Project, User
from app.services import template_upgrade as service
from app.services.scope import is_full_access, visible_project_ids_for, visible_task_ids_for

router = APIRouter(prefix="/projects", tags=["template-upgrade"])
Db = Annotated[Session, Depends(get_db)]
Current = Annotated[User, Depends(get_current_user)]


class Mapping(BaseModel):
    model_config = ConfigDict(extra="forbid")
    node_id: str = Field(min_length=1, max_length=200)
    task_id: str = Field(max_length=64)


class SubMapping(BaseModel):
    model_config = ConfigDict(extra="forbid")
    node_id: str = Field(min_length=1, max_length=200)
    sub_project_id: str = Field(min_length=1, max_length=64)


class OwnerOverride(BaseModel):
    model_config = ConfigDict(extra="forbid")
    node_id: str = Field(min_length=1, max_length=200)
    owner_id: str = Field(min_length=1, max_length=64)


class UpgradePreviewIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source_version: str = Field(min_length=1, max_length=20)
    target_version: str = Field(min_length=1, max_length=20)
    mappings: list[Mapping] = Field(default_factory=list, max_length=5000)
    sub_mappings: list[SubMapping] = Field(default_factory=list, max_length=200)
    owner_overrides: list[OwnerOverride] = Field(default_factory=list, max_length=5000)


class UpgradeApplyIn(UpgradePreviewIn):
    fingerprint: str = Field(min_length=64, max_length=64)
    selected_ids: list[str] = Field(default_factory=list, max_length=20000)
    reason: str = Field(min_length=1, max_length=2000)


def project_for(db, user, project_id, write=False):
    project = db.get(Project, project_id)
    if not project or project_id not in visible_project_ids_for(user, db):
        raise HTTPException(404, "项目不存在或不可访问")
    if write and not (is_full_access(user) or project.owner_id == user.id):
        raise HTTPException(403, "仅项目负责人或管理员可升级项目模板")
    return project


@router.get("/{project_id}/template-upgrade")
def catalog(project_id: str, db: Db, user: Current):
    project = project_for(db, user, project_id)
    result = service.catalog(db, project)
    # Members can inspect template versions, but don't gain visibility of tasks
    # outside their normal scope through the legacy binding selector.
    editable = is_full_access(user) or project.owner_id == user.id
    if not editable:
        allowed = visible_task_ids_for(user, db)
        result["tasks"] = [t for t in result["tasks"] if t["id"] in allowed]
        result["mappings"] = [m for m in result.get("mappings", []) if m["task_id"] in allowed]
    result["editable"] = editable
    return result


@router.post("/{project_id}/template-upgrade/preview")
def preview(project_id: str, body: UpgradePreviewIn, db: Db, user: Current):
    project = project_for(db, user, project_id, True)
    return service.preview(db, project, body)[0]


@router.post("/{project_id}/template-upgrade/apply")
def apply(project_id: str, body: UpgradeApplyIn, db: Db, user: Current):
    project = project_for(db, user, project_id, True)
    if not body.reason.strip():
        raise HTTPException(422, "请填写升级原因")
    try:
        return service.apply(db, project, body, user)
    except ValidationError as error:
        db.rollback()
        raise HTTPException(
            422, "目标模板字段无效：" + "；".join(e["msg"] for e in error.errors())
        ) from None
