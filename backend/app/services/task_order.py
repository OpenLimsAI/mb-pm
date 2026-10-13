"""任务在子项目内的手动顺序（Task.sort_order）。

WBS 树 / 表格 / 甘特与编辑模式都按 TASK_WBS_ORDER 排列：有顺序号的在前、按顺序号；
没有顺序号的（升级前的老数据）在后、按计划开始与编号。启动时 backfill_all 为老数据补号，
补号沿用原显示顺序且不改动 updated_at（这不是用户修改）。
"""

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.models import Task
from app.models.task import TASK_WBS_ORDER


def fill_sub_order(db: Session, sub_project_id: str) -> int:
    """给子项目内还没有顺序号的任务补号（接在已有最大值之后），返回补号后的最大顺序号。"""
    rows = db.execute(
        select(Task.id, Task.sort_order)
        .where(Task.sub_project_id == sub_project_id)
        .order_by(*TASK_WBS_ORDER)
    ).all()
    n = max((order for _, order in rows if order is not None), default=0)
    for task_id, order in rows:
        if order is None:
            n += 1
            db.execute(
                update(Task)
                .where(Task.id == task_id)
                .values(sort_order=n, updated_at=Task.updated_at)
            )
    return n


def next_sort_order(db: Session, sub_project_id: str) -> int:
    """新任务接在子项目末尾的顺序号。"""
    return fill_sub_order(db, sub_project_id) + 1


def backfill_all(db: Session) -> int:
    """为所有还没有顺序号的任务补号，返回涉及的子项目数（幂等）。"""
    sub_ids = db.scalars(
        select(Task.sub_project_id).where(Task.sort_order.is_(None)).distinct()
    ).all()
    for sub_id in sub_ids:
        fill_sub_order(db, sub_id)
    return len(sub_ids)
