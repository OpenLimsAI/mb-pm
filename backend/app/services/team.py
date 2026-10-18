"""项目团队规则：任务只能派给项目团队（负责人 + 团队成员）里的人。

- 改派 / 新建任务（任务接口、编辑模式保存）时，新的负责人或协作人必须已在团队中，否则拒绝并提示先在「团队」页添加；
  沿用原负责人不受影响。
- 仍负责或协作本项目任务的人不能移出团队（先转交任务）。
- 整包导入、复制项目、更换项目负责人时，已有任务的人自动留在团队中；启动时为老数据补齐（幂等）。
"""

from collections.abc import Iterable

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Project, ProjectMember, SubProject, Task, User

ADD_FIRST = "请先在项目「团队」页把 Ta 加入项目成员"


def team_ids(db: Session, project: Project) -> set[str]:
    members = db.scalars(
        select(ProjectMember.user_id).where(ProjectMember.project_id == project.id)
    )
    return {project.owner_id, *members}


def assignee_tasks(db: Session, project_id: str) -> dict[str, int]:
    """本项目各人负责或协作的任务数。"""
    rows = db.execute(
        select(Task.owner_id, Task.collaborator_ids)
        .join(SubProject, SubProject.id == Task.sub_project_id)
        .where(SubProject.project_id == project_id)
    )
    counts: dict[str, int] = {}
    for owner_id, collaborator_ids in rows:
        for user_id in {owner_id, *(collaborator_ids or [])}:
            if user_id:
                counts[user_id] = counts.get(user_id, 0) + 1
    return counts


def _names(db: Session, user_ids: Iterable[str]) -> str:
    ids = sorted(set(user_ids))
    found = dict(db.execute(select(User.id, User.display_name).where(User.id.in_(ids))).all())
    return "、".join(found.get(i, i) for i in ids)


def ensure_in_team(db: Session, project: Project, user_ids: Iterable[str]) -> None:
    outside = {u for u in user_ids if u} - team_ids(db, project)
    if outside:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"{_names(db, outside)} 不在项目团队中，{ADD_FIRST}",
        )


def ensure_assignees_kept(db: Session, project: Project, member_ids: Iterable[str]) -> None:
    """替换团队名单前调用：仍有任务的人不能移出。"""
    kept = {project.owner_id, *member_ids}
    dropped = set(assignee_tasks(db, project.id)) - kept
    if dropped:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"{_names(db, dropped)} 仍负责或协作本项目任务，不能移出团队；请先在 WBS 中转交这些任务",
        )


def include_assignees(db: Session, project: Project) -> int:
    """把有任务但不在团队里的人加为团队成员，返回新增人数（调用方提交）。"""
    db.flush()
    missing = set(assignee_tasks(db, project.id)) - team_ids(db, project)
    missing &= set(db.scalars(select(User.id).where(User.id.in_(missing))))
    for user_id in sorted(missing):
        db.add(ProjectMember(project_id=project.id, user_id=user_id))
    if missing:
        db.flush()
    return len(missing)


def backfill_assignees(db: Session) -> int:
    """老数据：所有项目中有任务但不在团队名单里的人补为团队成员（幂等），返回新增人数。"""
    added = sum(include_assignees(db, project) for project in db.scalars(select(Project)).all())
    if added:
        db.commit()
    return added
