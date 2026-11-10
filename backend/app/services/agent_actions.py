"""Review, revalidation, and atomic execution of delegated project proposals."""

import json
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.v1 import pm_management, task_collaboration, tasks
from app.api.v1.planning import apply_schedule_changes, schedule_state
from app.core.config import settings
from app.models import AgentProposal, AuditLog, Project, SubProject, Task, TaskDependency, User
from app.models.task_collaboration import TaskAcceptance, TaskDeliverable
from app.schemas import agent_actions as schema
from app.schemas.task import TaskCreate, TaskUpdate
from app.services import agent_projects, planning
from app.services.project_ai_actions import digest
from app.services.project_schedule_assist import selected_task
from app.services.rollup import recompute_project
from app.services.scope import is_full_access, is_own_task_only, visible_task_ids_for

PENDING = "pending_confirmation"
RETRYABLE = {"cancelled", "expired", "stale"}
TASK_ACTIONS = {"update_progress", "attach_deliverable", "submit_acceptance"}
REVIEW_DURATION = timedelta(hours=24)
STALE_MESSAGE = "项目数据已变化，请重新生成提案后核对"


@dataclass
class Prepared:
    changes: list[dict]
    evidence: dict
    task: Task | None = None
    schedule: dict | None = None
    schedule_tasks: list[Task] | None = None


def utc(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def manager(user: User, project: Project) -> bool:
    return is_full_access(user) or (user.role == "project_lead" and project.owner_id == user.id)


def require_manager(user: User, project: Project) -> None:
    if not manager(user, project):
        raise HTTPException(403, "仅项目负责人或全局项目管理员可以提出此变更")


def project_for(db: Session, user: User, project_id: str, *, lock=False) -> Project:
    project = agent_projects.permitted_project(db, user, project_id)
    if lock:
        project = db.scalars(
            select(Project)
            .where(Project.id == project_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        ).first()
        if not project:
            raise HTTPException(404, "项目不存在或无权访问")
        agent_projects.permitted_project(db, user, project_id)
    return project


def task_for(db: Session, user: User, project: Project, task_id: str, *, lock=False) -> Task:
    task, parent = agent_projects.find_task(db, user, task_id)
    if parent.id != project.id:
        raise HTTPException(404, "任务不存在或不属于当前项目")
    if lock:
        task = task_collaboration.lock_task_for_update(db, task_id)
        if not task or task.sub_project.project_id != project.id:
            raise HTTPException(404, "任务不存在或不属于当前项目")
    if not manager(user, project) and not (
        is_own_task_only(user) and user.id in {task.owner_id, *(task.collaborator_ids or [])}
    ):
        raise HTTPException(403, "只能更新自己负责或协作的任务")
    return task


def schedule_preview(
    db: Session, user: User, project: Project, payload: schema.SchedulePreview, *, lock=False
) -> tuple[dict, list[Task]]:
    require_manager(user, project)
    task_ids = select(Task.id).join(SubProject).where(SubProject.project_id == project.id)
    external = db.scalar(
        select(TaskDependency.id)
        .where(
            or_(
                and_(
                    TaskDependency.predecessor_id.in_(task_ids),
                    TaskDependency.successor_id.not_in(task_ids),
                ),
                and_(
                    TaskDependency.successor_id.in_(task_ids),
                    TaskDependency.predecessor_id.not_in(task_ids),
                ),
            )
        )
        .limit(1)
    )
    if external is not None:
        raise HTTPException(409, "存在跨项目依赖，请由负责人协调跨项目计划")
    schedule_tasks, deps, calendar = schedule_state(db, user, project.id, lock=lock)
    task = selected_task(schedule_tasks, payload.task_id)
    start, end = payload.new_start, payload.new_end
    if payload.delay_workdays is not None:
        start = planning.move_workdays(task.planned_start, payload.delay_workdays, calendar)
        end = planning.move_workdays(task.planned_end, payload.delay_workdays, calendar)
    return (
        planning.preview_schedule(
            schedule_tasks, deps, calendar, task.id, start, end, payload.locked_ids
        ),
        schedule_tasks,
    )


def change(title: str, before: dict, after: dict) -> dict:
    return {"title": title, "before": before, "after": after}


def owner_name(db: Session, project: Project, owner_id: str) -> str:
    pm_management.check_owner(db, project, owner_id)
    return db.get(User, owner_id).display_name


def invalidation(acceptance: TaskAcceptance | None, task: Task) -> tuple[dict, dict]:
    if not acceptance or acceptance.state not in {"submitted", "accepted"}:
        return {}, {}
    before = {"验收状态": "待验收" if acceptance.state == "submitted" else "已通过"}
    after = {"验收状态": "待重新提交"}
    if task.status == "已验证":
        before["任务状态"] = "已验证"
        after["任务状态"] = "已完成"
    return before, after


def prepare(
    db: Session, user: User, project: Project, action: schema.Action, *, lock=False
) -> Prepared:
    if action.kind not in TASK_ACTIONS:
        require_manager(user, project)

    if isinstance(action, schema.ScheduleChange):
        result, schedule_tasks = schedule_preview(db, user, project, action, lock=lock)
        if result["conflicts"]:
            raise HTTPException(409, {"message": "排期存在冲突", "conflicts": result["conflicts"]})
        if action.fingerprint and result["fingerprint"] != action.fingerprint:
            raise HTTPException(409, STALE_MESSAGE)
        if not result["changes"]:
            raise HTTPException(422, "计划日期没有变化")
        if len(result["changes"]) > 200:
            raise HTTPException(422, "本次联动超过 200 项任务，请在项目计划中调整")
        changes, evidence = [], {}
        task_by_id = {task.id: task for task in schedule_tasks}
        for item in result["changes"]:
            task = task_by_id[item["task_id"]]
            acceptance = db.get(TaskAcceptance, task.id)
            before, after = invalidation(acceptance, task)
            changes.append(
                change(
                    f"{item['code']} {item['name']}",
                    {"计划开始": item["old_start"], "计划结束": item["old_end"], **before},
                    {"计划开始": item["new_start"], "计划结束": item["new_end"], **after},
                )
            )
            if acceptance:
                evidence[task.id] = task_collaboration.acceptance_out(acceptance)
        changes.append(
            change(
                "项目计划结束",
                {"计划结束": result["previous_finish"]},
                {"计划结束": result["new_finish"]},
            )
        )
        return Prepared(
            changes,
            {"schedule": result, "acceptance": evidence},
            schedule=result,
            schedule_tasks=schedule_tasks,
        )

    if isinstance(action, schema.CreateTask):
        sub = db.get(SubProject, action.sub_project_id)
        if not sub or sub.project_id != project.id:
            raise HTTPException(404, "子项目不存在或不属于当前项目")
        owner = owner_name(db, project, action.owner_id)
        return Prepared(
            [
                change(
                    "新建任务",
                    {},
                    {
                        "任务名称": action.name,
                        "子项目": sub.name,
                        "负责人": owner,
                        "计划开始": action.planned_start.isoformat(),
                        "计划结束": action.planned_end.isoformat(),
                        "任务状态": "未开始",
                        "说明": action.notes,
                    },
                )
            ],
            {"sub_project": sub.id, "owner": action.owner_id},
        )

    if isinstance(action, schema.RegisterRisk):
        owner = owner_name(db, project, action.owner_id)
        return Prepared(
            [
                change(
                    "登记风险",
                    {},
                    {
                        "标题": action.title,
                        "处理人": owner,
                        "处理期限": action.due_date.isoformat(),
                        "严重度": {"high": "高", "medium": "中", "low": "低"}[action.severity],
                        "应对措施": action.mitigation,
                    },
                )
            ],
            {"owner": action.owner_id},
        )

    task = task_for(db, user, project, action.task_id, lock=lock)
    if task.revision != action.expected_revision:
        raise HTTPException(409, STALE_MESSAGE)
    acceptance = db.get(TaskAcceptance, task.id)
    evidence = {
        "task_revision": task.revision,
        "acceptance": task_collaboration.acceptance_out(acceptance),
    }
    invalid_before, invalid_after = invalidation(acceptance, task)
    title = f"{task.code} {task.name}"

    if isinstance(action, schema.UpdateProgress):
        if task.progress == action.progress and not action.progress_note:
            raise HTTPException(422, "进度没有变化，请填写进展说明或更改进度")
        before = {"完成度": task.progress}
        after = {"完成度": action.progress, "进展说明": action.progress_note}
        if task.progress != action.progress:
            before.update(invalid_before)
            after.update(invalid_after)
    elif isinstance(action, schema.ReassignTask):
        if task.owner_id == action.owner_id:
            raise HTTPException(422, "负责人没有变化")
        before = {"负责人": db.get(User, task.owner_id).display_name, **invalid_before}
        after = {"负责人": owner_name(db, project, action.owner_id), **invalid_after}
    elif isinstance(action, schema.AttachDeliverable):
        task_collaboration.validate_deliverable_link(action.url)
        deliverables = db.query(TaskDeliverable).filter_by(task_id=task.id)
        if deliverables.count() >= 100:
            raise HTTPException(422, "单个任务最多保存100个交付物版本")
        version = (
            deliverables.filter_by(title=action.title)
            .with_entities(func.max(TaskDeliverable.version))
            .scalar()
            or 0
        )
        before = invalid_before
        after = {
            "交付物名称": action.title,
            "版本": version + 1,
            "链接": action.url,
            "说明": action.notes,
            **invalid_after,
        }
    else:
        if not acceptance:
            raise HTTPException(422, "尚未设置验收要求")
        if utc(acceptance.updated_at) != utc(action.expected_acceptance_updated_at):
            raise HTTPException(409, "验收要求已变化，请重新核对")
        deliverables = task_collaboration.acceptance_deliverables(
            db, acceptance, action.deliverable_ids
        )
        reviewer = db.get(User, acceptance.reviewer_id)
        if (
            not reviewer
            or not reviewer.is_active
            or task.id not in visible_task_ids_for(reviewer, db)
        ):
            raise HTTPException(422, "指定验收人已停用或无权查看此任务，请重新指定")
        before = {"验收状态": "待提交" if acceptance.state == "draft" else "已退回"}
        after = {
            "验收状态": "待验收",
            "验收人": reviewer.display_name,
            "提交版本": [f"{item.title} · v{item.version}" for item in deliverables],
        }
    return Prepared([change(title, before, after)], evidence, task=task)


def snapshot(prepared: Prepared) -> str:
    return digest([prepared.changes, prepared.evidence])


def view(row: AgentProposal, *, review=False, replayed=False) -> dict:
    state = row.state
    if state == PENDING and utc(row.expires_at) <= datetime.now(UTC):
        state = "expired"
    review_url = None
    if state == PENDING:
        review_url = settings.pms_origin + agent_projects.project_link(
            row.project_id, tab="ai", agent_proposal=row.id
        )
    result = {
        "id": row.id,
        "project_id": row.project_id,
        "kind": row.kind,
        "reason": row.draft["reason"],
        "state": state,
        "created_at": utc(row.created_at),
        "expires_at": utc(row.expires_at),
        "finished_at": utc(row.finished_at) if row.finished_at else None,
        "changes": row.changes,
        "review_url": review_url,
        "result": row.result,
        "error": row.error or ("确认期限已过，请重新生成提案" if state == "expired" else None),
        "retried_from": row.draft.get("retried_from"),
    }
    if review:
        result["review_key"] = review_key(row) if state == PENDING else None
        result["replayed"] = replayed
    return result


def review_key(row: AgentProposal) -> str:
    return digest([row.id, row.snapshot_digest, row.request_digest])


def allowed_proposals(db: Session, user: User, project: Project):
    query = select(AgentProposal).where(
        AgentProposal.created_by == user.id, AgentProposal.project_id == project.id
    )
    if not manager(user, project):
        query = query.where(
            AgentProposal.kind.in_(TASK_ACTIONS),
            AgentProposal.draft["action"]["task_id"]
            .as_string()
            .in_(visible_task_ids_for(user, db)),
        )
    return query


def get(db: Session, user: User, proposal_id: str, project_id=None, *, lock=False):
    if project_id is None:
        project_id = db.scalar(
            select(AgentProposal.project_id).where(
                AgentProposal.id == proposal_id, AgentProposal.created_by == user.id
            )
        )
    if project_id is None:
        raise HTTPException(404, "提案不存在或无权访问")
    project = project_for(db, user, project_id, lock=lock)
    query = allowed_proposals(db, user, project).where(AgentProposal.id == proposal_id)
    row = db.scalars(query.with_for_update() if lock else query).first()
    if not row:
        raise HTTPException(404, "提案不存在或无权访问")
    return project, row


def propose(
    db: Session, user: User, project: Project, payload: schema.Propose, *, retried_from=None
):
    proposal_id = "ap-" + digest([user.id, project.id, payload.request_id])[:35]
    draft = payload.model_dump(mode="json", exclude={"request_id"})
    if retried_from:
        draft["retried_from"] = retried_from
    fingerprint = digest(draft)
    old = db.get(AgentProposal, proposal_id)
    if old:
        _, old = get(db, user, old.id, project.id)
        return existing(old, fingerprint)
    prepared = prepare(db, user, project, payload.action)
    now = datetime.now(UTC)
    row = AgentProposal(
        id=proposal_id,
        project_id=project.id,
        created_by=user.id,
        kind=payload.action.kind,
        state=PENDING,
        created_at=now,
        expires_at=now + REVIEW_DURATION,
        draft=draft,
        request_digest=fingerprint,
        snapshot_digest=snapshot(prepared),
        changes=prepared.changes,
    )
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        old = db.get(AgentProposal, proposal_id)
        if not old:
            raise
        _, old = get(db, user, old.id, project.id)
        return existing(old, fingerprint)
    return view(row)


def existing(row: AgentProposal, request_digest: str) -> dict:
    if row.request_digest != request_digest:
        raise HTTPException(409, "请求编号已用于不同的提案，请更换编号")
    return view(row)


def transition(db: Session, row: AgentProposal, state: str) -> bool:
    # The first write claims the pending row. SQLite has no SELECT FOR UPDATE.
    claim = db.execute(
        update(AgentProposal)
        .where(AgentProposal.id == row.id, AgentProposal.state == PENDING)
        .values(state=state)
        .execution_options(synchronize_session=False)
    )
    if not claim.rowcount:
        db.rollback()
        return False
    row.state = state
    return True


def cancel(db: Session, row: AgentProposal) -> dict:
    state = view(row)["state"]
    if state == "cancelled":
        return view(row)
    if state != PENDING:
        raise HTTPException(409, "只有待确认提案可以取消")
    if not transition(db, row, "cancelled"):
        db.refresh(row)
        if row.state == "cancelled":
            return view(row)
        raise HTTPException(409, "提案状态已变化，请重新查询")
    row.finished_at = datetime.now(UTC)
    db.commit()
    return view(row)


def retry(db: Session, user: User, project: Project, row: AgentProposal, request_id: str) -> dict:
    if view(row)["state"] not in RETRYABLE:
        raise HTTPException(409, "只有取消、过期或数据已变化的提案可以重新生成")
    new_id = "ap-" + digest([user.id, project.id, request_id])[:35]
    old = db.get(AgentProposal, new_id)
    if old:
        _, old = get(db, user, old.id, project.id)
        if old.draft.get("retried_from") != row.id:
            raise HTTPException(409, "请求编号已用于不同的提案，请更换编号")
        return view(old)
    action = dict(row.draft["action"])
    if "expected_revision" in action:
        task = task_for(db, user, project, action["task_id"])
        action["expected_revision"] = task.revision
    if action["kind"] == "submit_acceptance":
        acceptance = db.get(TaskAcceptance, action["task_id"])
        if not acceptance:
            raise HTTPException(422, "尚未设置验收要求")
        action["expected_acceptance_updated_at"] = utc(acceptance.updated_at)
    if action["kind"] == "schedule":
        action["fingerprint"] = None
    return propose(
        db,
        user,
        project,
        schema.Propose(request_id=request_id, reason=row.draft["reason"], action=action),
        retried_from=row.id,
    )


def finish_stale(db: Session, row: AgentProposal) -> None:
    row.state = "stale"
    row.error = STALE_MESSAGE
    row.finished_at = datetime.now(UTC)
    db.commit()
    raise HTTPException(409, STALE_MESSAGE)


def confirm(db: Session, user: User, project: Project, row: AgentProposal, key: str) -> dict:
    if row.kind not in TASK_ACTIONS:
        require_manager(user, project)
    elif row.state != "applied":
        task_for(db, user, project, row.draft["action"]["task_id"], lock=True)
    if review_key(row) != key:
        raise HTTPException(409, "确认信息与提案不匹配，请重新核对")
    if row.state == "applied":
        return view(row, review=True, replayed=True)
    if view(row)["state"] != PENDING:
        raise HTTPException(409, "提案已结束或过期，请重新生成")
    if not transition(db, row, "applying"):
        db.refresh(row)
        if row.state == "applied":
            return view(row, review=True, replayed=True)
        raise HTTPException(409, "提案状态已变化，请重新查询")
    action = schema.Propose(
        request_id="review", reason=row.draft["reason"], action=row.draft["action"]
    ).action
    try:
        prepared = prepare(db, user, project, action, lock=True)
    except HTTPException as exc:
        if exc.status_code in {404, 409, 422}:
            finish_stale(db, row)
        raise
    if snapshot(prepared) != row.snapshot_digest:
        finish_stale(db, row)
    result = execute(db, user, project, row, action, prepared)
    now = datetime.now(UTC)
    receipt_id = "log-" + uuid4().hex[:24]
    row.state, row.finished_at = "applied", now
    row.result = {**result, "receipt_id": receipt_id}
    db.add(
        AuditLog(
            id=receipt_id,
            actor_id=user.id,
            action="确认 Agent 业务提案",
            target="项目",
            target_id=project.id,
            detail=json.dumps(
                {
                    "proposal_id": row.id,
                    "kind": row.kind,
                    "reason": row.draft["reason"],
                    "result": row.result,
                },
                ensure_ascii=False,
            ),
            created_at=now,
        )
    )
    db.commit()
    return view(row, review=True)


def execute(
    db: Session,
    user: User,
    project: Project,
    row: AgentProposal,
    action: schema.Action,
    prepared: Prepared,
) -> dict:
    if isinstance(action, schema.ScheduleChange):
        result = prepared.schedule
        apply_schedule_changes(
            db,
            user,
            prepared.schedule_tasks,
            result["changes"],
            f"Agent 排期提案：{row.draft['reason']}",
        )
        recompute_project(db, project.id)
        return {
            "schedule": result,
            "url": agent_projects.project_link(project.id, tab="wbs", task=action.task_id),
        }

    if isinstance(action, schema.CreateTask):
        task = tasks.create_task_record(
            TaskCreate(
                id="tk-" + row.id[3:],
                code="AG-" + row.id[3:15],
                **action.model_dump(exclude={"kind"}),
            ),
            db,
            user,
        )
        task_collaboration.record_activity(db, task, user, "change", "从 Agent 提案创建任务")
        return task_result(project, task)

    if isinstance(action, schema.RegisterRisk):
        risk = pm_management.create_register_record(
            project.id,
            pm_management.RegisterInput(kind="risk", **action.model_dump(exclude={"kind"})),
            db,
            user,
        )
        return {
            "risk_id": risk.id,
            "status": risk.status,
            "url": agent_projects.project_link(project.id, tab="management"),
        }

    task = prepared.task
    if isinstance(action, schema.UpdateProgress | schema.ReassignTask):
        updated = tasks.update_task_record(
            task.id,
            TaskUpdate(**action.model_dump(exclude={"kind", "task_id"})),
            db,
            user,
        )
        return task_result(project, updated)
    if isinstance(action, schema.AttachDeliverable):
        item = task_collaboration.new_deliverable(
            db, task, user, action.title, action.notes, link=action.url
        )
        return {**task_result(project, task), "deliverable_id": item.id, "version": item.version}

    acceptance = task_collaboration.apply_acceptance_action(
        db,
        task,
        user,
        task_collaboration.AcceptanceAction(action="submit", comment=row.draft["reason"]),
        selected_ids=action.deliverable_ids,
    )
    return {
        **task_result(project, task),
        "acceptance": task_collaboration.acceptance_out(acceptance),
    }


def task_result(project: Project, task: Task) -> dict:
    return {
        "task_id": task.id,
        "owner_id": task.owner_id,
        "revision": task.revision,
        "progress": task.progress,
        "status": task.status,
        "url": agent_projects.project_link(project.id, tab="wbs", task=task.id),
    }
