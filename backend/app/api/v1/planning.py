"""Working calendars, staff capacity, and atomic schedule preview/application."""

import json
from datetime import UTC, date, datetime
from typing import Annotated
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, require_role
from app.api.v1.task_collaboration import invalidate_acceptance, record_activity
from app.db.session import get_db
from app.models import AuditLog, Project, ProjectMember, SubProject, Task, TaskDependency, User
from app.models.planning import ProjectCalendar, UserWeeklyCapacity
from app.services.planning import calendar_dict, preview_schedule
from app.services.rollup import recompute_project, recompute_subproject
from app.services.scope import is_full_access, visible_project_ids_for

router = APIRouter(prefix="/planning", tags=["planning"])
manager = require_role("admin", "cmc_lead", "project_lead")
Db = Annotated[Session, Depends(get_db)]
Manager = Annotated[User, Depends(manager)]
CurrentUser = Annotated[User, Depends(get_current_user)]


def ensure_project(db, user, project_id, lock=False):
    query = db.query(Project).filter_by(id=project_id)
    project = (query.with_for_update() if lock else query).first()
    if not project or project_id not in visible_project_ids_for(user, db):
        raise HTTPException(404, "项目不存在或不可访问")
    return project


def audit(db, user, action, target, detail):
    db.add(
        AuditLog(
            id=f"log-{uuid4().hex[:12]}",
            actor_id=user.id,
            action=action,
            target="项目计划",
            target_id=target,
            detail=json.dumps(detail, ensure_ascii=False, default=str),
            created_at=datetime.now(UTC),
        )
    )


class CalendarInput(BaseModel):
    weekdays: list[int] = Field(
        default_factory=lambda: list(range(1, 8)), min_length=1, max_length=7
    )
    holidays: list[date] = Field(default_factory=list, max_length=3660)
    working_dates: list[date] = Field(default_factory=list, max_length=3660)
    revision: int = Field(ge=0)

    @field_validator("weekdays")
    @classmethod
    def valid_weekdays(cls, values):
        if any(day < 1 or day > 7 for day in values) or len(set(values)) != len(values):
            raise ValueError("工作周须为不重复的 1–7")
        return sorted(values)


@router.get("/calendars")
def calendars(db: Db, user: CurrentUser):
    ids = visible_project_ids_for(user, db)
    return [
        {"project_id": row.project_id, **calendar_dict(row)}
        for row in db.query(ProjectCalendar).filter(ProjectCalendar.project_id.in_(ids))
    ]


@router.put("/projects/{project_id}/calendar")
def save_calendar(
    project_id: str,
    payload: CalendarInput,
    db: Db,
    user: Manager,
):
    ensure_project(db, user, project_id, lock=True)
    row = db.get(ProjectCalendar, project_id)
    before = calendar_dict(row)
    if payload.revision != before["revision"]:
        raise HTTPException(409, "工作日历已被更新，请刷新后重新保存")
    if row is None:
        row = ProjectCalendar(project_id=project_id)
        db.add(row)
    row.weekdays = payload.weekdays
    row.holidays = sorted({day.isoformat() for day in payload.holidays})
    row.working_dates = sorted({day.isoformat() for day in payload.working_dates})
    row.revision = before["revision"] + 1
    audit(db, user, "更新工作日历", project_id, {"before": before, "after": calendar_dict(row)})
    db.commit()
    return {"project_id": project_id, **calendar_dict(row)}


class ScheduleInput(BaseModel):
    task_id: str
    new_start: date
    new_end: date
    locked_ids: list[str] = Field(default_factory=list, max_length=5000)
    fingerprint: str | None = None
    reason: str = Field(default="", max_length=2000)


def schedule_state(db, user, project_id, lock=False):
    ensure_project(db, user, project_id, lock=lock)
    subs = db.query(SubProject).filter_by(project_id=project_id).all()
    query = db.query(Task).filter(Task.sub_project_id.in_([s.id for s in subs])).order_by(Task.id)
    tasks = (query.with_for_update() if lock else query).all()
    ids = [task.id for task in tasks]
    deps = (
        db.query(TaskDependency)
        .filter(TaskDependency.predecessor_id.in_(ids), TaskDependency.successor_id.in_(ids))
        .all()
    )
    # Cross-project successors cannot silently be left with broken dependencies.
    external = (
        db.query(TaskDependency)
        .filter(TaskDependency.predecessor_id.in_(ids), ~TaskDependency.successor_id.in_(ids))
        .first()
    )
    if external:
        raise HTTPException(422, "项目存在跨项目下游依赖，请先由负责人协调跨项目计划")
    return tasks, deps, calendar_dict(db.get(ProjectCalendar, project_id))


@router.post("/projects/{project_id}/schedule-preview")
def preview(
    project_id: str,
    payload: ScheduleInput,
    db: Db,
    user: Manager,
):
    tasks, deps, calendar = schedule_state(db, user, project_id)
    return preview_schedule(
        tasks,
        deps,
        calendar,
        payload.task_id,
        payload.new_start,
        payload.new_end,
        payload.locked_ids,
    )


@router.post("/projects/{project_id}/schedule-apply")
def apply(
    project_id: str,
    payload: ScheduleInput,
    db: Db,
    user: Manager,
):
    if not payload.reason.strip():
        raise HTTPException(422, "请填写本次调整原因")
    tasks, deps, calendar = schedule_state(db, user, project_id, lock=True)
    result = preview_schedule(
        tasks,
        deps,
        calendar,
        payload.task_id,
        payload.new_start,
        payload.new_end,
        payload.locked_ids,
    )
    if payload.fingerprint != result["fingerprint"]:
        raise HTTPException(409, "计划、任务状态或工作日历已变化，请重新预览后应用")
    if result["conflicts"]:
        raise HTTPException(409, "存在锁定节点或依赖冲突，未修改任何任务")
    apply_schedule_changes(
        db, user, tasks, result["changes"], f"联动排期：{payload.reason.strip()}"
    )
    audit(
        db,
        user,
        "联动调整计划",
        project_id,
        {"reason": payload.reason.strip(), "changes": result["changes"]},
    )
    recompute_project(db, project_id)
    db.commit()
    return result


def apply_schedule_changes(db, user, tasks, schedule_changes, activity_note):
    """Apply a verified plan under the caller's transaction and task locks."""
    by_id = {task.id: task for task in tasks}
    for change in schedule_changes:
        task = by_id[change["task_id"]]
        task.planned_start = date.fromisoformat(change["new_start"])
        task.planned_end = date.fromisoformat(change["new_end"])
        changes = {
            "planned_start": {"before": change["old_start"], "after": change["new_start"]},
            "planned_end": {"before": change["old_end"], "after": change["new_end"]},
        }
        record_activity(db, task, user, "change", activity_note, changes)
        invalidate_acceptance(db, task, user)
        # Explicit timestamp also invalidates structure-editor snapshots.
        task.updated_at = datetime.now(UTC)
    db.flush()
    for sub_id in {task.sub_project_id for task in tasks}:
        recompute_subproject(db, sub_id)


class CapacityInput(BaseModel):
    user_id: str
    week_start: date
    available_hours: float = Field(ge=0, le=168, allow_inf_nan=False)
    leave_hours: float = Field(default=0, ge=0, le=168, allow_inf_nan=False)
    revision: int = Field(default=0, ge=0)

    @model_validator(mode="after")
    def valid(self):
        if self.week_start.isoweekday() != 1:
            raise ValueError("周开始须为星期一")
        if self.leave_hours > self.available_hours:
            raise ValueError("请假工时不能大于可用工时")
        return self


class CapacityOut(CapacityInput):
    model_config = ConfigDict(from_attributes=True)


def visible_staff(db, user):
    if is_full_access(user):
        return {u.id for u in db.query(User)}
    pids = visible_project_ids_for(user, db)
    ids = {
        row.user_id for row in db.query(ProjectMember).filter(ProjectMember.project_id.in_(pids))
    }
    for task in db.query(Task).join(SubProject).filter(SubProject.project_id.in_(pids)):
        ids.add(task.owner_id)
        ids.update(task.collaborator_ids or [])
    return ids


@router.get("/capacities", response_model=list[CapacityOut])
def capacities(db: Db, user: Manager):
    return (
        db.query(UserWeeklyCapacity)
        .filter(UserWeeklyCapacity.user_id.in_(visible_staff(db, user)))
        .all()
    )


@router.put("/capacities", response_model=CapacityOut)
def save_capacity(payload: CapacityInput, db: Db, user: Manager):
    if payload.user_id not in visible_staff(db, user):
        raise HTTPException(404, "成员不存在或不在可见项目中")
    # Lock the parent staff row to serialize creation as well as update.
    target = db.query(User).filter_by(id=payload.user_id).with_for_update().first()
    if not target or not target.is_active:
        raise HTTPException(422, "成员已停用")
    key = f"{payload.user_id}:{payload.week_start.isoformat()}"
    row = db.get(UserWeeklyCapacity, key)
    if payload.revision != (row.revision if row else 0):
        raise HTTPException(409, "本周容量已变化，请刷新后重新保存")
    before = CapacityOut.model_validate(row).model_dump() if row else None
    if row is None:
        row = UserWeeklyCapacity(
            id=key, user_id=payload.user_id, week_start=payload.week_start.isoformat()
        )
        db.add(row)
    row.available_hours = payload.available_hours
    row.leave_hours = payload.leave_hours
    row.revision = payload.revision + 1
    audit(
        db, user, "调整每周容量", payload.user_id, {"before": before, "after": payload.model_dump()}
    )
    db.commit()
    return row
