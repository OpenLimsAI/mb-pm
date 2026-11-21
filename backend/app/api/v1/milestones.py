"""Atomic, retry-safe milestone and prerequisite editing."""

import hashlib
import json
from datetime import UTC, date, datetime
from typing import Annotated, Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy.orm import Session

from app.api.deps import require_role
from app.api.v1.task_collaboration import invalidate_acceptance, record_activity
from app.api.v1.tasks import create_task_record, update_task_record
from app.db.session import get_db
from app.models import AuditLog, Project, SubProject, Task, TaskDependency, User
from app.schemas.task import TaskCreate, TaskUpdate
from app.services.dependency_graph import lock_dependency_graph, validate_dependency_changes
from app.services.rollup import recompute_project, recompute_subproject
from app.services.scope import visible_project_ids_for, visible_task_ids_for
from app.services.team import team_ids

router = APIRouter(prefix="/milestones", tags=["milestones"])
Manager = Annotated[User, Depends(require_role("admin", "cmc_lead", "project_lead"))]
DB = Annotated[Session, Depends(get_db)]


class MilestoneMutation(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    request_id: str = Field(min_length=16, max_length=100)
    operation: Literal["create", "update", "delete"]
    project_id: str = Field(min_length=1, max_length=64)
    task_id: str | None = Field(default=None, max_length=64)
    expected_revision: int | None = Field(default=None, ge=1)
    expected_dependencies: list[tuple[str, str, str, str, int]] | None = Field(
        default=None, max_length=5000
    )
    sub_project_id: str | None = Field(default=None, max_length=64)
    name: str | None = Field(default=None, min_length=1, max_length=200)
    planned_end: date | None = None
    priority: Literal["高", "中", "低"] = "中"
    notes: str | None = Field(default=None, max_length=5000)
    predecessor_ids: list[Annotated[str, Field(min_length=1, max_length=64)]] = Field(
        default_factory=list, max_length=5000
    )

    @model_validator(mode="after")
    def complete_operation(self):
        if len(self.predecessor_ids) != len(set(self.predecessor_ids)):
            raise ValueError("前置任务不能重复")
        if self.operation != "delete" and (not self.name or not self.planned_end):
            raise ValueError("请填写里程碑名称与计划达成日")
        if self.operation == "create":
            if not self.sub_project_id or self.task_id:
                raise ValueError("新建里程碑须指定子项目")
        elif (
            not self.task_id or self.expected_revision is None or self.expected_dependencies is None
        ):
            raise ValueError("请重新打开里程碑，核对当前版本和依赖后保存")
        return self


def dependency_snapshot(rows):
    return sorted(
        (row.id, row.predecessor_id, row.successor_id, row.type, row.lag_days) for row in rows
    )


@router.post("/atomic")
def mutate_milestone(
    body: MilestoneMutation,
    db: DB,
    user: Manager,
):
    lock_dependency_graph(db)
    visible = visible_project_ids_for(user, db)
    if body.project_id not in visible:
        raise HTTPException(404, "项目不存在或无权访问")
    # Acquire all involved project locks in the same order as dependency writes.
    predecessor_projects = {
        pid
        for (pid,) in db.query(SubProject.project_id)
        .join(Task)
        .filter(Task.id.in_(body.predecessor_ids))
    }
    if not predecessor_projects <= visible:
        raise HTTPException(404, "前置任务不存在或无权访问")
    project_ids = sorted({body.project_id, *predecessor_projects})
    db.query(Project).filter(Project.id.in_(project_ids)).order_by(
        Project.id
    ).populate_existing().with_for_update().all()
    project = db.get(Project, body.project_id)
    if not project or not set(project_ids) <= visible_project_ids_for(user, db):
        raise HTTPException(404, "项目不存在或无权访问")
    receipt_id = (
        "msr-"
        + hashlib.sha256(f"{user.id}:{body.project_id}:{body.request_id}".encode()).hexdigest()[:26]
    )
    request_data = body.model_dump(mode="json")
    request_data["predecessor_ids"] = sorted(body.predecessor_ids)
    if body.expected_dependencies is not None:
        request_data["expected_dependencies"] = sorted(body.expected_dependencies)
    request_hash = hashlib.sha256(json.dumps(request_data, sort_keys=True).encode()).hexdigest()
    receipt = db.get(AuditLog, receipt_id)
    if receipt:
        saved = json.loads(receipt.detail)
        if receipt.actor_id != user.id or saved.get("request_hash") != request_hash:
            raise HTTPException(409, "该保存请求已用于其他内容，请重新核对后保存")
        return {**saved["result"], "replayed": True}

    task = None
    current = []
    editable_dependencies = []
    if body.operation != "create":
        task = (
            db.query(Task).filter_by(id=body.task_id).populate_existing().with_for_update().first()
        )
        sub = db.get(SubProject, task.sub_project_id) if task else None
        if not task or not task.is_milestone or not sub or sub.project_id != body.project_id:
            raise HTTPException(404, "里程碑不存在或不属于当前项目")
        current = (
            db.query(TaskDependency)
            .filter(
                (TaskDependency.predecessor_id == task.id)
                | (TaskDependency.successor_id == task.id)
            )
            .all()
        )
        visible_tasks = visible_task_ids_for(user, db)
        editable_dependencies = [
            row
            for row in current
            if row.predecessor_id in visible_tasks and row.successor_id in visible_tasks
        ]
        if task.revision != body.expected_revision or dependency_snapshot(
            editable_dependencies
        ) != sorted(body.expected_dependencies):
            raise HTTPException(409, "里程碑或依赖已被修改，请保留草稿并重新核对；本次未保存")

    if body.operation == "delete":
        if len(editable_dependencies) != len(current):
            raise HTTPException(409, "无法删除关联依赖超出当前权限的里程碑，请由管理员核对")
        task_id, sub_id = task.id, task.sub_project_id
        removed = len(current)
        db.delete(task)
        db.flush()
        recompute_subproject(db, sub_id)
        recompute_project(db, project.id)
    else:
        predecessors = db.query(Task).filter(Task.id.in_(body.predecessor_ids)).all()
        if len(predecessors) != len(body.predecessor_ids):
            raise HTTPException(422, "前置任务已不存在，请重新核对")
        task_id = task.id if task else f"tk-{uuid4().hex[:20]}"
        incoming = [row for row in editable_dependencies if row.successor_id == task_id]
        kept = set()
        removed_rows = []
        for row in incoming:
            if row.predecessor_id in body.predecessor_ids and row.predecessor_id not in kept:
                kept.add(row.predecessor_id)
            else:
                removed_rows.append(row)
        additions = [(pred, task_id, "FS", 0) for pred in body.predecessor_ids if pred not in kept]
        validate_dependency_changes(db, additions, [row.id for row in removed_rows])
        if body.operation == "create":
            sub = db.get(SubProject, body.sub_project_id)
            if not sub or sub.project_id != project.id:
                raise HTTPException(422, "子项目不属于当前项目")
            owner_id = sub.owner_id if sub.owner_id in team_ids(db, project) else project.owner_id
            prefix = f"{project.code}-MIL-"
            codes = [
                code
                for (code,) in db.query(Task.code)
                .join(SubProject)
                .filter(SubProject.project_id == project.id)
            ]
            numbers = [
                int(code[len(prefix) :])
                for code in codes
                if code.startswith(prefix) and code[len(prefix) :].isdigit()
            ]
            code = f"{prefix}{max(numbers, default=0) + 1:02d}"
            task = create_task_record(
                TaskCreate(
                    id=task_id,
                    code=code,
                    name=body.name,
                    sub_project_id=sub.id,
                    owner_id=owner_id,
                    status="未开始",
                    priority=body.priority,
                    planned_start=body.planned_end,
                    planned_end=body.planned_end,
                    is_milestone=True,
                    notes=body.notes,
                ),
                db,
                user,
            )
            record_activity(db, task, user, "change", "新增里程碑及达成条件")
        else:
            task = update_task_record(
                task.id,
                TaskUpdate(
                    expected_revision=body.expected_revision,
                    name=body.name,
                    planned_start=body.planned_end,
                    planned_end=body.planned_end,
                    priority=body.priority,
                    notes=body.notes,
                ),
                db,
                user,
            )
        for row in removed_rows:
            db.delete(row)
        for pred, succ, kind, lag in additions:
            db.add(
                TaskDependency(
                    id=f"dep-{uuid4().hex[:20]}",
                    predecessor_id=pred,
                    successor_id=succ,
                    type=kind,
                    lag_days=lag,
                )
            )
        if removed_rows or additions:
            invalidate_acceptance(db, task, user)
            task.revision += 1
            record_activity(
                db,
                task,
                user,
                "change",
                "修改里程碑达成条件",
                {
                    "predecessors": {
                        "before": [row.predecessor_id for row in incoming],
                        "after": body.predecessor_ids,
                    }
                },
            )
        removed = len(removed_rows)
    result = {"task_id": task_id, "removed_dependencies": removed, "replayed": False}
    db.add(
        AuditLog(
            id=receipt_id,
            actor_id=user.id,
            action="里程碑原子保存",
            target="任务",
            target_id=task_id,
            detail=json.dumps(
                {"request_hash": request_hash, "operation": body.operation, "result": result},
                ensure_ascii=False,
            ),
            created_at=datetime.now(UTC),
        )
    )
    db.commit()
    return result
