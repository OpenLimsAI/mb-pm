"""Project risk/issue/decision register, cost detail, real change reports and inbox."""

import json
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Annotated, Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models import Project, ProjectFinance, ProjectMember, SubProject, Task, User
from app.models.audit_log import AuditLog
from app.models.pm_management import (
    PMCostEntry,
    PMNotificationPreference,
    PMNotificationState,
    PMRegisterEntry,
)
from app.services.scope import is_full_access, visible_project_ids_for, visible_task_ids_for

router = APIRouter(prefix="/pm", tags=["project-management"])
DONE = {"已完成", "已验证"}
DB = Annotated[Session, Depends(get_db)]
CurrentUser = Annotated[User, Depends(get_current_user)]


@router.get("/context")
def management_context(user: CurrentUser):
    return {
        "business_date": date.today().isoformat(),
        "timezone": str(datetime.now().astimezone().tzinfo),
    }


def project_access(db, user, project_id, write=False):
    project = db.get(Project, project_id)
    if not project or (
        not is_full_access(user) and project_id not in visible_project_ids_for(user, db)
    ):
        raise HTTPException(404, "项目不存在或无权访问")
    if write and user.role not in {"admin", "cmc_lead", "project_lead"}:
        raise HTTPException(403, "仅项目管理者可维护台账")
    return project


def project_tasks(db, user, project_id):
    query = db.query(Task).join(SubProject).filter(SubProject.project_id == project_id)
    if not is_full_access(user):
        query = query.filter(Task.id.in_(visible_task_ids_for(user, db)))
    return query.all()


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


@router.get("/projects/{project_id}/register")
def get_register(project_id: str, db: DB, user: CurrentUser):
    project_access(db, user, project_id)
    return [
        register_view(r)
        for r in db.query(PMRegisterEntry)
        .filter_by(project_id=project_id)
        .order_by(PMRegisterEntry.due_date, PMRegisterEntry.id)
    ]


@router.post("/projects/{project_id}/register", status_code=201)
def create_register(
    project_id: str,
    data: RegisterInput,
    db: DB,
    user: CurrentUser,
):
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
    db.commit()
    db.refresh(row)
    return register_view(row)


def check_owner(db, project, owner_id):
    member = db.get(User, owner_id)
    team = {m.user_id for m in db.query(ProjectMember).filter_by(project_id=project.id)} | {
        project.owner_id
    }
    if not member or not member.is_active or owner_id not in team:
        raise HTTPException(422, "负责人须为活跃的项目团队成员")


@router.put("/projects/{project_id}/register/{entry_id}")
def update_register(
    project_id: str,
    entry_id: str,
    data: RegisterInput,
    db: DB,
    user: CurrentUser,
):
    project = project_access(db, user, project_id, True)
    row = (
        db.query(PMRegisterEntry)
        .filter_by(id=entry_id, project_id=project_id)
        .with_for_update()
        .first()
    )
    if not row:
        raise HTTPException(404, "事项不存在")
    if data.expected_revision != row.revision:
        raise HTTPException(409, "事项已被其他人修改，请刷新后核对")
    check_owner(db, project, data.owner_id)
    before = register_view(row)
    for key, value in data.model_dump(exclude={"expected_revision"}).items():
        setattr(row, key, value)
    row.revision += 1
    audit(
        db,
        user,
        project_id,
        "更新项目跟进事项",
        before,
        data.model_dump(exclude={"expected_revision"}),
    )
    db.commit()
    db.refresh(row)
    return register_view(row)


class CostInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    kind: Literal["actual", "payment", "remaining"]
    title: str = Field(min_length=1, max_length=200)
    category: str = Field(min_length=1, max_length=40)
    task_id: str | None = Field(default=None, max_length=64)
    amount: Decimal = Field(gt=0, le=9999999999, max_digits=12, decimal_places=2)
    occurred_on: date
    evidence_url: str = Field(default="", max_length=2000)
    notes: str = Field(default="", max_length=5000)
    voided: bool = False
    void_reason: str = Field(default="", max_length=2000)
    expected_revision: int | None = Field(default=None, ge=1)

    @model_validator(mode="after")
    def void_explanation(self):
        if self.voided and not self.void_reason:
            raise ValueError("作废须填写原因，历史记录仍会保留")
        return self

    @field_validator("evidence_url")
    @classmethod
    def evidence_link(cls, value):
        if value:
            from urllib.parse import urlparse

            parsed = urlparse(value)
            if (
                parsed.scheme not in {"http", "https"}
                or not parsed.netloc
                or parsed.username
                or parsed.password
            ):
                raise ValueError("凭据链接须为不含账号密码的 HTTP/HTTPS 地址")
        return value


def cost_view(row):
    return {
        key: getattr(row, key)
        for key in (
            "id",
            "project_id",
            "task_id",
            "kind",
            "title",
            "category",
            "amount",
            "occurred_on",
            "evidence_url",
            "notes",
            "voided",
            "void_reason",
            "revision",
        )
    }


@router.get("/projects/{project_id}/costs")
def get_costs(project_id: str, db: DB, user: CurrentUser):
    project_access(db, user, project_id)
    # Actual ledger amounts explain existing task costs; they are NEVER added to spent.
    rows = (
        db.query(PMCostEntry)
        .filter_by(project_id=project_id)
        .order_by(PMCostEntry.occurred_on, PMCostEntry.id)
        .all()
    )
    all_tasks = db.query(Task).join(SubProject).filter(SubProject.project_id == project_id).all()
    spent = sum((t.actual_cost or Decimal(0) for t in all_tasks), Decimal(0))
    detail = sum((r.amount for r in rows if r.kind == "actual" and not r.voided), Decimal(0))
    payments = sum((r.amount for r in rows if r.kind == "payment" and not r.voided), Decimal(0))
    remaining = sum((r.amount for r in rows if r.kind == "remaining" and not r.voided), Decimal(0))
    finance = db.get(ProjectFinance, project_id)
    return {
        "items": [cost_view(r) for r in rows],
        "spent": spent,
        "recorded_actual": detail,
        "unreconciled": spent - detail,
        "payments": payments,
        "remaining": remaining,
        "forecast": spent + payments + remaining,
        "budget": finance.total_budget if finance else None,
    }


def check_cost_task(db, project_id, task_id):
    if (
        task_id
        and not db.query(Task)
        .join(SubProject)
        .filter(Task.id == task_id, SubProject.project_id == project_id)
        .first()
    ):
        raise HTTPException(422, "关联任务不属于此项目")


@router.post("/projects/{project_id}/costs", status_code=201)
def create_cost(
    project_id: str,
    data: CostInput,
    db: DB,
    user: CurrentUser,
):
    project_access(db, user, project_id, True)
    check_cost_task(db, project_id, data.task_id)
    row = PMCostEntry(
        id=f"cost-{uuid4().hex[:20]}",
        project_id=project_id,
        **data.model_dump(exclude={"expected_revision"}),
    )
    db.add(row)
    audit(
        db, user, project_id, "创建费用明细", None, data.model_dump(exclude={"expected_revision"})
    )
    db.commit()
    db.refresh(row)
    return cost_view(row)


@router.put("/projects/{project_id}/costs/{entry_id}")
def update_cost(
    project_id: str,
    entry_id: str,
    data: CostInput,
    db: DB,
    user: CurrentUser,
):
    project_access(db, user, project_id, True)
    row = (
        db.query(PMCostEntry)
        .filter_by(id=entry_id, project_id=project_id)
        .with_for_update()
        .first()
    )
    if not row:
        raise HTTPException(404, "费用明细不存在")
    if data.expected_revision != row.revision:
        raise HTTPException(409, "费用明细已被其他人修改，请刷新后核对")
    check_cost_task(db, project_id, data.task_id)
    before = cost_view(row)
    for key, value in data.model_dump(exclude={"expected_revision"}).items():
        setattr(row, key, value)
    row.revision += 1
    audit(
        db, user, project_id, "更新费用明细", before, data.model_dump(exclude={"expected_revision"})
    )
    db.commit()
    db.refresh(row)
    return cost_view(row)


@router.get("/projects/{project_id}/quality")
def quality(project_id: str, db: DB, user: CurrentUser):
    project_access(db, user, project_id)
    today = date.today()
    result = []
    for task in project_tasks(db, user, project_id):
        checks = []
        if task.cost_budget is None:
            checks.append(("budget", "未填任务预算"))
        if task.status in DONE and task.actual_end is None:
            checks.append(("actual-end", "已完成但未填实际结束日期"))
        if task.status != "未开始" and task.actual_cost is None:
            checks.append(("cost", "已开始但未填实际花费（确实未发生可填 0）"))
        if (
            task.status not in DONE
            and task.status != "未开始"
            and task.updated_at
            and (today - task.updated_at.date()).days >= 14
        ):
            checks.append(("stale", "进行中的任务已超过 14 天未更新"))
        for key, reason in checks:
            result.append(
                {
                    "id": f"{task.id}:{key}",
                    "task_id": task.id,
                    "title": task.name,
                    "reason": reason,
                    "owner_id": task.owner_id,
                    "url": f"/projects/{project_id}?tab=wbs&task={task.id}",
                }
            )
    return {"as_of": datetime.now(UTC), "items": result}


@router.get("/projects/{project_id}/changes")
def changes(
    project_id: str,
    db: DB,
    user: CurrentUser,
    days: int = Query(7, ge=1, le=90),
):
    project_access(db, user, project_id)
    tasks = project_tasks(db, user, project_id)
    task_map = {t.id: t for t in tasks}
    now = datetime.now(UTC)
    since = now - timedelta(days=days)
    items = []
    # Only actual persisted events are included; there is no reconstructed historical trend.
    from app.models.task_collaboration import TaskActivity

    for row in (
        db.query(TaskActivity)
        .filter(TaskActivity.task_id.in_(task_map), TaskActivity.created_at >= since)
        .order_by(TaskActivity.created_at.desc())
        .limit(1000)
    ):
        items.append(
            {
                "id": row.id,
                "created_at": row.created_at,
                "actor_id": row.actor_id,
                "action": row.kind,
                "title": task_map[row.task_id].name,
                "task_id": row.task_id,
                "detail": row.body,
                "changes": row.changes or {},
            }
        )
    for row in (
        db.query(AuditLog)
        .filter(
            AuditLog.target_id == project_id,
            AuditLog.created_at >= since,
            user.role in {"admin", "cmc_lead", "project_lead"},
        )
        .order_by(AuditLog.created_at.desc())
        .limit(1000)
    ):
        detail, delta = row.detail or "", {}
        try:
            payload = json.loads(detail)
            if isinstance(payload, dict) and "before" in payload and "after" in payload:
                before, after = payload.get("before") or {}, payload.get("after") or {}
                if isinstance(before, dict) and isinstance(after, dict):
                    delta = {
                        key: {"before": before.get(key), "after": after.get(key)}
                        for key in set(before) | set(after)
                        if key
                        not in {"id", "project_id", "revision", "updated_at", "expected_revision"}
                        and before.get(key) != after.get(key)
                    }
                    detail = after.get("title") or before.get("title") or row.action
        except (ValueError, TypeError):
            pass
        items.append(
            {
                "id": row.id,
                "created_at": row.created_at,
                "actor_id": row.actor_id,
                "action": row.action,
                "title": "项目",
                "task_id": None,
                "detail": detail,
                "changes": delta,
            }
        )
    completed, blocked, delayed = set(), set(), set()
    for item in items:
        delta = item.get("changes", {})
        status = delta.get("status", {})
        if status.get("after") in DONE and status.get("before") not in DONE:
            completed.add(item["task_id"])
        if status.get("after") == "阻塞" and status.get("before") != "阻塞":
            blocked.add(item["task_id"])
        end = delta.get("planned_end", {})
        if end.get("after") and end.get("before") and end["after"] > end["before"]:
            delayed.add(item["task_id"])
    summary = {"completed": len(completed), "blocked": len(blocked), "delayed": len(delayed)}
    items.sort(key=lambda item: item["created_at"].replace(tzinfo=UTC), reverse=True)
    return {
        "from": since,
        "to": now,
        "items": items[:1000],
        "truncated": len(items) > 1000,
        "summary": summary,
    }


class PreferenceInput(BaseModel):
    mode: Literal["immediate", "daily", "paused"]


class StateInput(BaseModel):
    event_keys: list[str] = Field(min_length=1, max_length=200)
    action: Literal["read", "unread", "snooze"]
    hours: int = Field(default=24, ge=1, le=168)


def utc(value):
    return value.replace(tzinfo=UTC) if value and not value.tzinfo else value


def notification_items(db, user):
    today = date.today()
    now = datetime.now(UTC)
    tasks = (
        db.query(Task)
        .join(SubProject)
        .join(Project)
        .filter(Task.id.in_(visible_task_ids_for(user, db)), Project.status == "活跃")
        .all()
    )
    task_map = {t.id: t for t in tasks}
    sub_projects = {
        s.id: s.project_id
        for s in db.query(SubProject).filter(SubProject.id.in_({t.sub_project_id for t in tasks}))
    }
    items = []

    def add(key, task, kind, text, created_at=None):
        project_id = sub_projects[task.sub_project_id]
        items.append(
            {
                "key": key,
                "task_id": task.id,
                "project_id": project_id,
                "kind": kind,
                "title": task.name,
                "detail": text,
                "created_at": created_at or now,
                "url": f"/projects/{project_id}?tab=wbs&task={task.id}",
            }
        )

    from app.models.task_collaboration import TaskAcceptance, TaskActivity

    activities = (
        db.query(TaskActivity)
        .filter(TaskActivity.task_id.in_(task_map))
        .order_by(TaskActivity.created_at.desc())
        .limit(2000)
        .all()
    )
    assignments = {}
    for activity in activities:
        changes = activity.changes or {}
        owner = changes.get("owner_id", {})
        collaborators = changes.get("collaborator_ids", {})
        newly_assigned = owner.get("after") == user.id and owner.get("before") != user.id
        newly_assigned |= user.id in (collaborators.get("after") or []) and user.id not in (
            collaborators.get("before") or []
        )
        if newly_assigned and activity.task_id not in assignments:
            assignments[activity.task_id] = activity
    for task in tasks:
        if user.id not in {task.owner_id, *(task.collaborator_ids or [])} or task.status in DONE:
            continue
        assignment = assignments.get(task.id)
        assignment_key = assignment.id if assignment else task.owner_id
        add(
            f"assignment:{task.id}:{assignment_key}",
            task,
            "assignment",
            "你负责或参与的任务",
            assignment.created_at if assignment else task.created_at,
        )
        days = (task.planned_end - today).days
        if days < 0 or task.status in {"延迟", "阻塞"}:
            add(
                f"attention:{task.id}:{task.planned_end}:{task.status}",
                task,
                "attention",
                f"逾期 {-days} 天" if days < 0 else task.status,
            )
        elif days <= 7:
            add(
                f"due:{task.id}:{task.planned_end}",
                task,
                "due",
                f"{days} 天后到期" if days else "今天到期",
            )
    for row in activities:
        if user.id in (row.mention_ids or []) and row.actor_id != user.id:
            add(
                f"mention:{row.id}",
                task_map[row.task_id],
                "mention",
                row.body[:200],
                row.created_at,
            )
    for row in db.query(TaskAcceptance).filter(
        TaskAcceptance.task_id.in_(task_map),
        TaskAcceptance.reviewer_id == user.id,
        TaskAcceptance.state == "submitted",
    ):
        add(
            f"acceptance:{row.task_id}:{row.updated_at.isoformat()}",
            task_map[row.task_id],
            "acceptance",
            "等待你验收交付物",
            row.updated_at,
        )
    states = {
        row.event_key: row for row in db.query(PMNotificationState).filter_by(user_id=user.id)
    }
    for item in items:
        state = states.get(item["key"])
        item["read"] = bool(state and state.read_at)
        item["snoozed"] = bool(state and state.snooze_until and utc(state.snooze_until) > now)
    items = [i for i in items if not i["snoozed"]]
    items.sort(key=lambda item: (item["read"], -utc(item["created_at"]).timestamp()))
    return items


@router.get("/notifications")
def notifications(db: DB, user: CurrentUser):
    pref = db.get(PMNotificationPreference, user.id)
    items = notification_items(db, user)
    mode = pref.mode if pref else "immediate"
    # Freeze one persisted daily digest. Later events remain visible in the inbox,
    # but do not generate additional digest badges until the next day.
    if mode == "daily" and pref.digest_on != date.today():
        pref.digest_on = date.today()
        pref.digest_keys = [item["key"] for item in items if not item["read"]]
        db.commit()
    digest_keys = pref.digest_keys if pref and mode == "daily" else []
    unread = sum(not item["read"] for item in items)
    badge = (
        unread
        if mode == "immediate"
        else int(
            mode == "daily"
            and any(not item["read"] and item["key"] in digest_keys for item in items)
        )
    )
    return {
        "mode": mode,
        "as_of": datetime.now(UTC),
        "unread": unread,
        "badge_count": badge,
        "digest_keys": digest_keys,
        "items": items[:500],
        "truncated": len(items) > 500,
    }


@router.put("/notifications/preferences")
def notification_preferences(data: PreferenceInput, db: DB, user: CurrentUser):
    row = db.get(PMNotificationPreference, user.id)
    if not row:
        row = PMNotificationPreference(user_id=user.id)
        db.add(row)
    if row.mode != data.mode:
        row.digest_on = None
        row.digest_keys = []
    row.mode = data.mode
    db.commit()
    return {"mode": row.mode}


@router.post("/notifications/state")
def notification_state(data: StateInput, db: DB, user: CurrentUser):
    valid = {i["key"] for i in notification_items(db, user)}
    if any(key not in valid for key in data.event_keys):
        raise HTTPException(422, "提醒已失效，请刷新通知")
    now = datetime.now(UTC)
    for key in set(data.event_keys):
        row = db.get(PMNotificationState, (user.id, key))
        if not row:
            row = PMNotificationState(user_id=user.id, event_key=key)
            db.add(row)
        if data.action == "snooze":
            row.snooze_until = now + timedelta(hours=data.hours)
        else:
            row.read_at = now if data.action == "read" else None
    db.commit()
    return {"updated": len(set(data.event_keys))}
