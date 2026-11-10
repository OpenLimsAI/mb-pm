"""进度汇总 —— 任务进度变更后，自动汇总到子项目和项目。

三级 WBS 派生（与前端 lib/progress.ts 一致）：
    项目/子项目进度 = Σ(任务进度 × 有效权重) / Σ有效权重
    状态       = 100→已完成 / >0→进行中 / 0→未开始
    项目 health = 由任务/里程碑的逾期与临期情况派生（红/黄/绿）
"""

from datetime import date
from decimal import ROUND_HALF_UP, Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import Project, SubProject, Task
from app.services.task_deadlines import COMPLETED_STATUSES, is_overdue


def effective_weight(
    task: Task, method: str, override: Decimal | None = None, *, overridden=False
) -> Decimal:
    if method == "equal":
        return Decimal(1)
    if method == "effort":
        return Decimal(0) if task.is_milestone else Decimal(str(task.estimated_effort or 0))
    weight = override if overridden else task.progress_weight
    if weight is not None:
        return Decimal(str(weight))
    return Decimal(0 if task.is_milestone else 1)


def weighted_progress(
    tasks: list[Task], method: str = "equal", overrides: dict | None = None
) -> dict:
    overrides = overrides or {}
    weights = [
        effective_weight(t, method, overrides.get(t.id), overridden=t.id in overrides)
        for t in tasks
    ]
    denominator = sum(weights, Decimal(0))
    numerator = sum(
        (Decimal(t.progress) * w for t, w in zip(tasks, weights, strict=False)), Decimal(0)
    )
    exact = numerator / denominator if denominator else Decimal(0)
    return {
        "progress": int(exact.quantize(Decimal(1), rounding=ROUND_HALF_UP)),
        "exact_progress": float(exact),
        "numerator": float(numerator),
        "denominator": float(denominator),
    }


def _status_for(progress: int) -> str:
    if progress >= 100:
        return "已完成"
    if progress > 0:
        return "进行中"
    return "未开始"


def _derive_health(tasks: list[Task], today: date | None = None) -> str:
    """红：有逾期里程碑；黄：有逾期任务或临近(≤14d)里程碑；否则绿。

    today 默认取服务器当天日期（每次调用时读取），与前端「今日」= 本机当前日期同一口径。
    """
    today = today or date.today()

    def incomplete(t: Task) -> bool:
        return t.status not in COMPLETED_STATUSES

    overdue_ms = any(t.is_milestone and is_overdue(t, today) for t in tasks)
    overdue_task = any(not t.is_milestone and is_overdue(t, today) for t in tasks)
    near_ms = any(
        t.is_milestone and incomplete(t) and 0 <= (t.planned_end - today).days <= 14 for t in tasks
    )
    if overdue_ms:
        return "red"
    if overdue_task or near_ms:
        return "yellow"
    return "green"


def live_health(db: Session, projects: list[Project]) -> dict[str, str]:
    """按「当天」实时派生各项目 health（一次查询取回相关任务，不写库）。

    health 依赖日期：即使任务没有变动，里程碑也会随时间逾期 / 临近，已存值会逐日过期。
    没有任务的项目沿用已存值。
    """
    if not projects:
        return {}
    rows = db.execute(
        select(SubProject.project_id, Task)
        .join(Task, Task.sub_project_id == SubProject.id)
        .where(SubProject.project_id.in_([p.id for p in projects]))
    ).all()
    tasks_by_project: dict[str, list[Task]] = {}
    for project_id, task in rows:
        tasks_by_project.setdefault(project_id, []).append(task)
    return {
        p.id: _derive_health(tasks_by_project[p.id]) if p.id in tasks_by_project else p.health
        for p in projects
    }


def live_span(db: Session, projects: list[Project]) -> dict[str, tuple[date, date]]:
    """按任务实时派生各项目的计划起止：最早的计划开始 → 最晚的计划结束（一次查询，不写库）。

    任务改了日期、增删了任务，项目起止随之变化；没有任务的项目沿用已存的计划起止。
    """
    if not projects:
        return {}
    rows = db.execute(
        select(SubProject.project_id, func.min(Task.planned_start), func.max(Task.planned_end))
        .join(Task, Task.sub_project_id == SubProject.id)
        .where(SubProject.project_id.in_([p.id for p in projects]))
        .group_by(SubProject.project_id)
    ).all()
    spans = {pid: (start, end) for pid, start, end in rows}
    return {p.id: spans.get(p.id, (p.planned_start, p.planned_end)) for p in projects}


def recompute_subproject(db: Session, sub_id: str) -> None:
    sub = db.get(SubProject, sub_id)
    if not sub:
        return
    tasks = db.query(Task).filter_by(sub_project_id=sub_id).all()
    project = db.get(Project, sub.project_id)
    sub.progress = weighted_progress(tasks, project.progress_method if project else "equal")[
        "progress"
    ]
    sub.status = _status_for(sub.progress)


def recompute_project(db: Session, project_id: str) -> None:
    proj = db.get(Project, project_id)
    if not proj:
        return
    sub_ids = [s.id for s in db.query(SubProject).filter_by(project_id=project_id).all()]
    tasks = db.query(Task).filter(Task.sub_project_id.in_(sub_ids)).all()
    proj.progress = weighted_progress(tasks, proj.progress_method)["progress"]
    proj.health = _derive_health(tasks)


def rollup_for_task(db: Session, task: Task) -> None:
    """单个任务变更后，依次汇总其子项目与项目。调用前请确保 task 的新值已 flush。"""
    recompute_subproject(db, task.sub_project_id)
    sub = db.get(SubProject, task.sub_project_id)
    if sub:
        recompute_project(db, sub.project_id)
