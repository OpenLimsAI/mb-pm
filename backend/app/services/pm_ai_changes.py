"""Validated, atomic changes proposed by a scoped project AI analysis."""

import json
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Annotated, Literal
from urllib.parse import quote
from uuid import uuid4

from cryptography.fernet import InvalidToken
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, model_validator

from app.api.v1.pm_management import RegisterInput, check_owner, register_view
from app.api.v1.task_collaboration import record_activity
from app.api.v1.tasks import apply_task_create, apply_task_update
from app.core.security import digest, seal, unseal
from app.models import AuditLog, Project, SubProject, Task
from app.models.pm_ai_changes import PMAIChangeReceipt
from app.models.pm_management import PMRegisterEntry
from app.models.task_collaboration import TaskAcceptance
from app.schemas.business_values import MAX_EFFORT
from app.schemas.task import TaskCreate, TaskOut, TaskUpdate
from app.services.scope import visible_project_ids_for, visible_task_ids_for

PURPOSE = "pm-ai-change-set-v1"
CONFIRMATION_WINDOW = timedelta(minutes=10)


class Draft(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    reason: str = Field(min_length=1, max_length=2000)
    evidence_ids: list[Annotated[str, Field(min_length=1, max_length=160)]] = Field(
        min_length=1, max_length=20
    )


class TaskUpdateDraft(Draft):
    kind: Literal["task_update"]
    task_id: str = Field(min_length=1, max_length=64)
    expected_revision: int = Field(ge=1)
    progress: int | None = Field(default=None, ge=0, le=100)
    status: Literal["未开始", "进行中", "已完成", "延迟", "阻塞"] | None = None
    actual_effort: Decimal | None = Field(
        default=None, ge=0, le=MAX_EFFORT, decimal_places=2, allow_inf_nan=False
    )
    notes: str | None = Field(default=None, max_length=5000)

    @model_validator(mode="after")
    def meaningful(self):
        fields = self.model_fields_set & {"progress", "status", "actual_effort", "notes"}
        if not fields or any(
            getattr(self, name) is None for name in fields & {"progress", "status"}
        ):
            raise ValueError("请填写至少一项有效的执行字段")
        return self


class TaskCreateDraft(Draft):
    kind: Literal["task_create"]
    project_id: str = Field(min_length=1, max_length=64)
    sub_project_id: str = Field(min_length=1, max_length=64)
    owner_id: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=200)
    planned_start: date
    planned_end: date

    @model_validator(mode="after")
    def ordered(self):
        if self.planned_end < self.planned_start:
            raise ValueError("计划结束不能早于开始")
        return self


class RegisterCreateDraft(Draft):
    kind: Literal["register_create"]
    project_id: str = Field(min_length=1, max_length=64)
    register_kind: Literal["risk", "issue", "decision"]
    title: str = Field(min_length=1, max_length=200)
    owner_id: str = Field(min_length=1, max_length=64)
    due_date: date
    severity: Literal["low", "medium", "high"] = "medium"
    mitigation: str = Field(default="", max_length=5000)


class RegisterUpdateDraft(Draft):
    kind: Literal["register_update"]
    entry_id: str = Field(min_length=1, max_length=64)
    expected_revision: int = Field(ge=1)
    status: Literal["open", "closed"]
    closure: str | None = Field(default=None, max_length=5000)
    mitigation: str | None = Field(default=None, max_length=5000)

    @model_validator(mode="after")
    def close_with_result(self):
        if self.status == "closed" and not self.closure:
            raise ValueError("关闭事项须填写处理结果")
        if any(
            getattr(self, name) is None
            for name in self.model_fields_set & {"closure", "mitigation"}
        ):
            raise ValueError("措施和处理结果须为文字")
        return self


ActionDraft = Annotated[
    TaskUpdateDraft | TaskCreateDraft | RegisterCreateDraft | RegisterUpdateDraft,
    Field(discriminator="kind"),
]
ACTIONS = TypeAdapter(list[ActionDraft])


class ChangePreviewInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    actions: list[ActionDraft] = Field(min_length=1, max_length=20)


class ChangeApplyInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    confirmation_token: str = Field(min_length=1, max_length=160000)


def access(db, user, run_id):
    from app.models.pm_ai import PMAIRun
    from app.services.pm_ai_context import recheck_user
    from app.services.pm_ai_runs import authorize_run

    user = recheck_user(db, user.id)
    run = db.get(PMAIRun, run_id)
    if not run or run.created_by != user.id:
        raise HTTPException(404, "分析不存在或不可访问")
    if run.state != "succeeded":
        raise HTTPException(409, "请等待分析完成后再核对建议")
    authorize_run(db, user, run)
    return user, run


def project_access(db, user, run, project_id, *, manage=False):
    scope = run.context.get("project_ids", run.context.get("scope", {}).get("project_ids", []))
    if project_id not in scope or project_id not in visible_project_ids_for(user, db):
        raise HTTPException(404, "目标项目不在当前分析范围内")
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "项目不存在")
    if manage and not (
        user.role in {"admin", "cmc_lead"}
        or user.role == "project_lead"
        and project.owner_id == user.id
    ):
        raise HTTPException(403, "该操作须由当前项目负责人执行")
    return project


def action_project(db, action):
    if isinstance(action, TaskCreateDraft | RegisterCreateDraft):
        return action.project_id
    if isinstance(action, TaskUpdateDraft):
        value = (
            db.query(SubProject.project_id)
            .join(Task, Task.sub_project_id == SubProject.id)
            .filter(Task.id == action.task_id)
            .scalar()
        )
    else:
        value = db.query(PMRegisterEntry.project_id).filter_by(id=action.entry_id).scalar()
    if value is None:
        raise HTTPException(404, "建议关联的记录不存在")
    return value


def task_values(action):
    return action.model_dump(
        exclude_unset=True, include={"progress", "status", "actual_effort", "notes"}
    )


def prepare(db, user, run, actions):
    references = {ref["id"] for ref in run.source.get("refs", [])}
    included_tasks = {row["id"] for row in run.context.get("tasks", [])}
    included_subprojects = {row["id"] for row in run.context.get("sub_projects", [])}
    included_entries = {row["id"] for row in run.context.get("register_entries", [])}
    changes, targets, project_ids = [], set(), set()
    for action in actions:
        if not set(action.evidence_ids) <= references:
            raise HTTPException(422, "建议须引用当前分析提供的依据")
        project_id = action_project(db, action)
        project = project_access(
            db, user, run, project_id, manage=not isinstance(action, TaskUpdateDraft)
        )
        project_ids.add(project_id)
        before, after, entity_id = {}, {}, None
        if isinstance(action, TaskUpdateDraft):
            if action.task_id not in included_tasks:
                raise HTTPException(422, "任务未包含在本次分析中，请重新选择范围生成分析")
            task = db.get(Task, action.task_id)
            if task.id not in visible_task_ids_for(user, db):
                raise HTTPException(404, "任务不存在或不可访问")
            if user.role not in {"admin", "cmc_lead", "project_lead"} and user.id not in [
                task.owner_id,
                *(task.collaborator_ids or []),
            ]:
                raise HTTPException(403, "只能更新自己负责或协作的任务")
            if task.revision != action.expected_revision:
                raise HTTPException(409, "任务版本已变化，请重新核对建议")
            before = TaskOut.model_validate(task).model_dump(
                mode="json",
                include={
                    "id",
                    "code",
                    "name",
                    "revision",
                    "status",
                    "progress",
                    "actual_effort",
                    "notes",
                },
            )
            after = {
                **before,
                **json.loads(TaskUpdate(**task_values(action)).model_dump_json(exclude_unset=True)),
            }
            acceptance = db.get(TaskAcceptance, task.id)
            if after == before:
                raise HTTPException(422, "任务字段没有变化")
            if acceptance and acceptance.state == "accepted" and after["status"] == "已验证":
                after["status"] = "已完成"
            title, entity_id = task.name, task.id
        elif isinstance(action, TaskCreateDraft):
            if action.sub_project_id not in included_subprojects:
                raise HTTPException(422, "子项目未包含在本次分析中，请重新选择范围生成分析")
            sub = db.get(SubProject, action.sub_project_id)
            if not sub or sub.project_id != project_id:
                raise HTTPException(422, "子项目不属于目标项目")
            check_owner(db, project, action.owner_id)
            title = action.name
            after = action.model_dump(
                mode="json", exclude={"kind", "reason", "evidence_ids", "project_id"}
            )
            after.update(status="未开始", progress=0)
        elif isinstance(action, RegisterCreateDraft):
            check_owner(db, project, action.owner_id)
            title = action.title
            after = action.model_dump(
                mode="json",
                exclude={"kind", "reason", "evidence_ids", "project_id", "register_kind"},
            )
            after.update(kind=action.register_kind, status="open", closure="")
        else:
            if action.entry_id not in included_entries:
                raise HTTPException(422, "跟进事项未包含在本次分析中，请重新生成分析")
            entry = db.get(PMRegisterEntry, action.entry_id)
            if entry.revision != action.expected_revision:
                raise HTTPException(409, "跟进事项版本已变化，请重新核对建议")
            check_owner(db, project, entry.owner_id)
            before = json.loads(json.dumps(register_view(entry), default=str))
            after = {
                **before,
                **action.model_dump(
                    mode="json", exclude_unset=True, include={"status", "closure", "mitigation"}
                ),
            }
            if after == before:
                raise HTTPException(422, "跟进事项没有变化")
            title, entity_id = entry.title, entry.id
        target = ("task" if isinstance(action, TaskUpdateDraft) else "register", entity_id)
        if entity_id and target in targets:
            raise HTTPException(422, "同一批建议不能重复修改同一条记录")
        targets.add(target)
        changes.append(
            {
                "kind": action.kind,
                "entity_id": entity_id,
                "project_id": project_id,
                "title": title,
                "before": before,
                "after": after,
                "evidence_ids": action.evidence_ids,
            }
        )
    return changes, sorted(project_ids)


def fingerprint(actions, changes):
    return digest(
        json.dumps(
            [ACTIONS.dump_python(actions, mode="json", exclude_unset=True), changes],
            sort_keys=True,
            ensure_ascii=False,
        )
    )


def action_set(actions):
    """Compare a batch independently of the order of its distinct target records."""
    return sorted(json.dumps(item, sort_keys=True, ensure_ascii=False) for item in actions)


def preview(db, user, run_id, payload):
    user, run = access(db, user, run_id)
    changes, _ = prepare(db, user, run, payload.actions)
    actions = ACTIONS.dump_python(payload.actions, mode="json", exclude_unset=True)
    if len(json.dumps(actions, ensure_ascii=False)) > 60000:
        raise HTTPException(422, "建议内容过长，请分批核对")
    expires = datetime.now(UTC) + CONFIRMATION_WINDOW
    token = seal(
        {
            "purpose": PURPOSE,
            "receipt_id": digest(
                json.dumps([run.id, user.id, action_set(actions)], ensure_ascii=False)
            )[:32],
            "run_id": run.id,
            "actor_id": user.id,
            "project_ids": sorted({change["project_id"] for change in changes}),
            "actions": actions,
            "fingerprint": fingerprint(payload.actions, changes),
            "expires": expires.timestamp(),
        }
    )
    return {
        "actions": actions,
        "changes": changes,
        "confirmation_token": token,
        "expires_at": expires,
    }


def decode(token, user_id, run_id):
    try:
        value = unseal(token)
    except (InvalidToken, ValueError):
        raise HTTPException(409, "确认记录无效，请重新预览") from None
    if (
        not isinstance(value, dict)
        or value.get("purpose") != PURPOSE
        or value.get("actor_id") != user_id
        or value.get("run_id") != run_id
    ):
        raise HTTPException(409, "确认记录无效，请重新预览")
    return value


def apply(db, user, run_id, payload):
    user, run = access(db, user, run_id)
    approved = decode(payload.confirmation_token, user.id, run_id)
    actions = ACTIONS.validate_python(approved["actions"])
    # Project locks serialize confirmation retries and all existing task writers.
    project_ids = approved["project_ids"]
    db.query(Project).filter(Project.id.in_(project_ids)).order_by(
        Project.id
    ).with_for_update().populate_existing().all()
    old = db.get(PMAIChangeReceipt, approved["receipt_id"])
    if old:
        if (
            old.created_by != user.id
            or old.run_id != run_id
            or action_set(old.actions) != action_set(approved["actions"])
        ):
            raise HTTPException(409, "确认记录不匹配")
        return {**old.result, "replayed": True}
    if approved["expires"] <= datetime.now(UTC).timestamp():
        raise HTTPException(409, "确认已过期，请重新预览")
    task_ids = [action.task_id for action in actions if isinstance(action, TaskUpdateDraft)]
    entry_ids = [action.entry_id for action in actions if isinstance(action, RegisterUpdateDraft)]
    db.query(Task).filter(Task.id.in_(task_ids)).order_by(
        Task.id
    ).with_for_update().populate_existing().all()
    db.query(PMRegisterEntry).filter(PMRegisterEntry.id.in_(entry_ids)).order_by(
        PMRegisterEntry.id
    ).with_for_update().populate_existing().all()
    changes, _ = prepare(db, user, run, actions)
    if approved["fingerprint"] != fingerprint(actions, changes):
        raise HTTPException(409, "项目数据已变化，请重新预览")
    results = []
    try:
        for index, (action, change) in enumerate(zip(actions, changes, strict=True)):
            entity_id = f"aic-{approved['receipt_id'][:20]}-{index}"
            if isinstance(action, TaskUpdateDraft):
                task = apply_task_update(
                    db,
                    user,
                    action.task_id,
                    TaskUpdate(
                        expected_revision=action.expected_revision,
                        progress_note=action.reason,
                        **task_values(action),
                    ),
                )
                entity_id = task.id
            elif isinstance(action, TaskCreateDraft):
                task = apply_task_create(
                    db,
                    user,
                    TaskCreate(
                        id=entity_id,
                        code=f"AI-{approved['receipt_id'][:10]}-{index}",
                        **change["after"],
                        notes=action.reason,
                    ),
                )
                record_activity(
                    db,
                    task,
                    user,
                    "change",
                    action.reason,
                    {"name": {"before": None, "after": task.name}},
                )
            elif isinstance(action, RegisterCreateDraft):
                values = RegisterInput.model_validate(change["after"]).model_dump(
                    exclude={"expected_revision"}
                )
                row = PMRegisterEntry(id=entity_id, project_id=action.project_id, **values)
                db.add(row)
            else:
                row = (
                    db.query(PMRegisterEntry).filter_by(id=action.entry_id).with_for_update().one()
                )
                for field in ("status", "closure", "mitigation"):
                    setattr(row, field, change["after"][field])
                row.revision += 1
                entity_id = row.id
            is_task = isinstance(action, TaskCreateDraft | TaskUpdateDraft)
            href = f"/projects/{quote(change['project_id'], safe='')}?tab={'wbs&task=' + quote(entity_id, safe='') if is_task else 'management'}"
            results.append(
                {
                    "kind": action.kind,
                    "entity_id": entity_id,
                    "title": change["title"],
                    "href": href,
                }
            )
            db.add(
                AuditLog(
                    id=f"log-{uuid4().hex[:20]}",
                    actor_id=user.id,
                    action="确认 AI 项目建议",
                    target="项目",
                    target_id=change["project_id"],
                    detail=json.dumps(
                        {
                            "run_id": run_id,
                            "kind": action.kind,
                            "entity_id": entity_id,
                            "reason": action.reason,
                            "evidence_ids": action.evidence_ids,
                            "before": change["before"],
                            "after": change["after"],
                        },
                        ensure_ascii=False,
                    ),
                    created_at=datetime.now(UTC),
                )
            )
        db.flush()
        db.expire_all()
        for result, change in zip(results, changes, strict=True):
            row = db.get(
                Task if result["kind"].startswith("task_") else PMRegisterEntry, result["entity_id"]
            )
            expected = change["after"]
            fields = (
                (
                    "name",
                    "status",
                    "progress",
                    "actual_effort",
                    "notes",
                    "planned_start",
                    "planned_end",
                    "owner_id",
                    "sub_project_id",
                )
                if isinstance(row, Task)
                else (
                    "kind",
                    "title",
                    "owner_id",
                    "due_date",
                    "severity",
                    "status",
                    "mitigation",
                    "closure",
                )
            )
            actual = (
                TaskOut.model_validate(row).model_dump(mode="json")
                if isinstance(row, Task)
                else json.loads(json.dumps(register_view(row), default=str))
            )
            if any(actual.get(field) != expected[field] for field in fields if field in expected):
                raise HTTPException(409, "执行结果核验失败，已撤销本次变更")
        result = {
            "receipt_id": approved["receipt_id"],
            "replayed": False,
            "results": results,
            "verified": True,
        }
        db.add(
            PMAIChangeReceipt(
                id=approved["receipt_id"],
                run_id=run_id,
                created_by=user.id,
                created_at=datetime.now(UTC),
                request_fingerprint=approved["fingerprint"],
                actions=approved["actions"],
                result=result,
            )
        )
        db.commit()
        return result
    except Exception:
        db.rollback()
        raise


def receipts(db, user, run_id):
    user, _ = access(db, user, run_id)
    return [
        {**row.result, "created_at": row.created_at}
        for row in db.query(PMAIChangeReceipt)
        .filter_by(run_id=run_id, created_by=user.id)
        .order_by(PMAIChangeReceipt.created_at.desc())
        .limit(100)
    ]
