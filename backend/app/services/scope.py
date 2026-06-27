"""行级权限范围 — 服务端等价于前端 lib/scope.ts。

策略：
    admin / cmc_lead   → 看全部
    project_lead       → 自己负责 + 作为成员的项目
    rd / production    → 仅作为成员的项目（任务级用 owner/collaborator 进一步收窄）
    qa_qc              → 同上 + 跨项目"分析方法 / 稳定性"任务可见

调用方式：
    visible_project_ids = visible_project_ids_for(user, db)
    stmt = select(Project).where(Project.id.in_(visible_project_ids))
"""

from sqlalchemy import String, cast, or_, select
from sqlalchemy.orm import Session

from app.models import Project, ProjectMember, SubProject, Task, User

# QA/QC 跨项目可见的子项目模块（保持与前端 scope.ts 同一定义）
QC_CROSS_MODULES: set[str] = {"分析方法", "稳定性"}


def is_full_access(user: User) -> bool:
    return user.role in ("admin", "cmc_lead")


def visible_project_ids_for(user: User, db: Session) -> set[str]:
    """返回当前用户能看见的所有 project.id 的集合。"""
    if is_full_access(user):
        return set(db.execute(select(Project.id)).scalars().all())

    if user.role == "project_lead":
        ids = set(
            db.execute(
                select(Project.id).where(
                    or_(
                        Project.owner_id == user.id,
                        Project.id.in_(
                            select(ProjectMember.project_id).where(ProjectMember.user_id == user.id)
                        ),
                    )
                )
            )
            .scalars()
            .all()
        )
        return ids

    # rd / production / qa_qc：作为成员的项目
    member_pids = set(
        db.execute(select(ProjectMember.project_id).where(ProjectMember.user_id == user.id))
        .scalars()
        .all()
    )

    # qa_qc 额外加上 — 任何项目里有 分析方法 / 稳定性 子项目的项目
    if user.role == "qa_qc":
        cross_pids = set(
            db.execute(select(SubProject.project_id).where(SubProject.module.in_(QC_CROSS_MODULES)))
            .scalars()
            .all()
        )
        member_pids |= cross_pids

    return member_pids


def visible_task_ids_for(user: User, db: Session) -> set[str]:
    """返回当前用户能看见的 task.id 集合。

    admin/cmc_lead/project_lead → 项目内所有任务
    rd / production              → 仅自己 owner 或 collaborator 的任务
    qa_qc                        → 同上 + 跨项目"分析方法 / 稳定性"任务
    """
    if is_full_access(user):
        return set(db.execute(select(Task.id)).scalars().all())

    if user.role == "project_lead":
        # 自己项目内的全部任务
        proj_ids = visible_project_ids_for(user, db)
        if not proj_ids:
            return set()
        return set(
            db.execute(select(Task.id).join(SubProject).where(SubProject.project_id.in_(proj_ids)))
            .scalars()
            .all()
        )

    # rd / production / qa_qc：本人任务（owner 或 collaborator）
    own_ids = set(
        db.execute(
            select(Task.id).where(
                or_(
                    Task.owner_id == user.id,
                    # collaborator_ids 是通用 JSON 列；用对带引号 token 的文本 LIKE 做成员判断，
                    # 在 SQLite / PostgreSQL 均可（避免 JSON.contains 在 SQLite 上失效）。
                    cast(Task.collaborator_ids, String).like(f'%"{user.id}"%'),
                )
            )
        )
        .scalars()
        .all()
    )

    # qa_qc 额外：跨项目分析/稳定性任务
    if user.role == "qa_qc":
        qc_ids = set(
            db.execute(
                select(Task.id)
                .join(SubProject, Task.sub_project_id == SubProject.id)
                .where(SubProject.module.in_(QC_CROSS_MODULES))
            )
            .scalars()
            .all()
        )
        own_ids |= qc_ids

    return own_ids


def is_own_task_only(user: User) -> bool:
    """True = 只能改自己的任务（rd / production / qa_qc）。"""
    return user.role in ("rd", "production", "qa_qc")
