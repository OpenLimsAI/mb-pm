"""复制项目 —— 以已有项目为蓝本新建一个项目（项目列表「复制项目」），一个事务内完成。

照搬结构与计划：项目属性、团队成员、子项目、任务 / 里程碑（名称、负责人、协作人、优先级、计划日期、
工时、成本预算、备注、标签、关键路径标记）、任务依赖、项目总预算。
执行数据重置：任务一律「未开始」、进度 0，不带实际开始 / 完成、实际工时、实际花费；
项目状态「活跃」，已承诺与成本结构（手工填报）清零，与新建项目一致。
不复制：基线、AI 分析、审计记录。
日期：指定新的计划开始时，项目与全部任务的计划日期按同样天数平移。
人员：已停用的负责人改由新项目负责人承担；已停用的团队成员 / 协作人不带入。
"""

import json
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import (
    AuditLog,
    Project,
    ProjectFinance,
    ProjectMember,
    SubProject,
    Task,
    TaskDependency,
    User,
)
from app.models.task import TASK_WBS_ORDER
from app.schemas.project import ProjectCopyIn
from app.services.rollup import live_span, recompute_project

_TASK_CODE_MAX = 50  # Task.code 列宽


def recode(code: str, old: str, new: str) -> str:
    """任务编号以原项目编号为前缀（如 MAB-201-USP-001）时换成新项目编号；换后超长则保留原编号。"""
    if code.startswith(f"{old}-"):
        recoded = new + code[len(old) :]
        if len(recoded) <= _TASK_CODE_MAX:
            return recoded
    return code


def copy_project(db: Session, source: Project, body: ProjectCopyIn, actor: User) -> Project:
    if db.scalar(select(Project.id).where(Project.code == body.code)):
        raise HTTPException(status.HTTP_409_CONFLICT, f"项目编号 {body.code} 已存在，请换一个编号")
    owner_id = body.owner_id or source.owner_id
    owner = db.get(User, owner_id)
    if owner is None or not owner.is_active:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "项目负责人不存在或已停用")

    active = set(db.scalars(select(User.id).where(User.is_active.is_(True))))

    def assignee(user_id: str) -> str:
        return user_id if user_id in active else owner_id

    # 原项目的计划起止按任务实时派生（与页面显示一致），新的计划开始相对它平移
    source_start, source_end = live_span(db, [source])[source.id]
    offset = (body.planned_start - source_start) if body.planned_start else timedelta(0)

    project = Project(
        id=f"p-{uuid4().hex[:12]}",
        code=body.code,
        name=body.name,
        product_type=source.product_type,
        current_stage=source.current_stage,
        target_stage=source.target_stage,
        owner_id=owner_id,
        status="活跃",
        health="green",
        progress=0,
        planned_start=source_start + offset,
        planned_end=source_end + offset,
        template_id=source.template_id,
        template_version=source.template_version,
        description=source.description,
    )
    db.add(project)
    db.flush()
    for member in source.members:
        if member.user_id != owner_id and member.user_id in active:
            db.add(ProjectMember(project_id=project.id, user_id=member.user_id))

    sub_ids: dict[str, str] = {}
    subs = db.scalars(
        select(SubProject)
        .where(SubProject.project_id == source.id)
        .order_by(SubProject.sort_order, SubProject.id)
    ).all()
    for sub in subs:
        sub_ids[sub.id] = f"sp-{uuid4().hex[:10]}"
        db.add(
            SubProject(
                id=sub_ids[sub.id],
                name=sub.name,
                project_id=project.id,
                stage=sub.stage,
                module=sub.module,
                owner_id=None if sub.owner_id is None else assignee(sub.owner_id),
                status="未开始",
                progress=0,
                sort_order=sub.sort_order,
            )
        )
    db.flush()

    task_ids: dict[str, str] = {}
    tasks = db.scalars(
        select(Task).where(Task.sub_project_id.in_(list(sub_ids))).order_by(*TASK_WBS_ORDER)
    ).all()
    for task in tasks:
        task_ids[task.id] = f"tk-{uuid4().hex[:10]}"
        collaborators = [c for c in task.collaborator_ids or [] if c in active]
        db.add(
            Task(
                id=task_ids[task.id],
                code=recode(task.code, source.code, project.code),
                name=task.name,
                sub_project_id=sub_ids[task.sub_project_id],
                owner_id=assignee(task.owner_id),
                collaborator_ids=collaborators or None,
                status="未开始",
                priority=task.priority,
                planned_start=task.planned_start + offset,
                planned_end=task.planned_end + offset,
                estimated_effort=task.estimated_effort,
                cost_budget=task.cost_budget,
                progress=0,
                is_milestone=task.is_milestone,
                is_critical_path=task.is_critical_path,
                notes=task.notes,
                tags=list(task.tags) if task.tags else None,
                sort_order=task.sort_order,
            )
        )
    db.flush()

    deps = db.scalars(
        select(TaskDependency).where(
            TaskDependency.predecessor_id.in_(list(task_ids)),
            TaskDependency.successor_id.in_(list(task_ids)),
        )
    ).all()
    for dep in deps:
        db.add(
            TaskDependency(
                id=f"dep-{uuid4().hex[:10]}",
                predecessor_id=task_ids[dep.predecessor_id],
                successor_id=task_ids[dep.successor_id],
                type=dep.type,
                lag_days=dep.lag_days,
            )
        )

    finance = db.get(ProjectFinance, source.id)
    if finance is not None:
        db.add(
            ProjectFinance(
                project_id=project.id,
                total_budget=finance.total_budget,
                spent=0,
                committed=0,
                breakdown={category: 0 for category in finance.breakdown or {}},
                fiscal_year=f"{project.planned_start.year}-{project.planned_end.year}",
                notes=f"复制自 {source.code}，尚未发生支出"[:200],
            )
        )
    db.flush()
    recompute_project(db, project.id)  # 按复制后的任务派生 health（进度为 0）

    db.add(
        AuditLog(
            id=f"log-{uuid4().hex[:12]}",
            actor_id=actor.id,
            action="复制项目",
            target="项目",
            target_id=project.id[:40],
            detail=json.dumps(
                {
                    "source_id": source.id,
                    "source_code": source.code,
                    "project_id": project.id,
                    "code": project.code,
                    "shift_days": offset.days,
                    "sub_projects": len(sub_ids),
                    "tasks": len(task_ids),
                    "dependencies": len(deps),
                },
                ensure_ascii=False,
            ),
            created_at=datetime.now(UTC),
        )
    )
    db.commit()
    db.refresh(project)
    return project
