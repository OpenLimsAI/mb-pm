"""项目结构编辑（编辑模式）：读取结构快照、按提交的完整结构在一个事务里增删改。

规则（与前端编辑模式一致）：
- 统一保存：提交的是编辑后的完整结构，后端与当前库比对后一次性生效；任何校验失败则全部不生效。
- 版本校验：进入编辑模式时拿到结构版本，保存时若他人已改过结构（含计划日期、负责人、预算等），拒绝并提示重新载入。
- 只改结构：名称、里程碑标记、负责人、计划起止、工时、预算、备注、前置依赖、子项目；
  状态、进度、实际日期与实际花费不在这里改。
- 删除保护：已开始（状态不是「未开始」、进度 > 0 或已有实际开始 / 完成日期）或已录实际花费的任务不能删除。
- 不自动顺延：只保存本次修改的日期，不推算后续任务（冲突由前端提示）。
"""

import hashlib
import json
from collections import defaultdict
from datetime import UTC, datetime
from decimal import Decimal
from uuid import uuid4

from fastapi import HTTPException, status
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.models import AuditLog, Project, SubProject, Task, TaskDependency, User
from app.models.task import TASK_WBS_ORDER
from app.schemas.structure import StructureSaveIn
from app.services.rollup import live_span, recompute_project, recompute_subproject


def _num(value) -> str | None:
    return None if value is None else f"{Decimal(value):.2f}"


def _load(db: Session, project_id: str):
    subs = (
        db.query(SubProject)
        .filter_by(project_id=project_id)
        .order_by(SubProject.sort_order, SubProject.id)
        .all()
    )
    sub_ids = [s.id for s in subs]
    tasks = (
        db.query(Task).filter(Task.sub_project_id.in_(sub_ids)).order_by(*TASK_WBS_ORDER).all()
        if sub_ids
        else []
    )
    task_ids = {t.id for t in tasks}
    deps = (
        db.query(TaskDependency)
        .filter(
            or_(
                TaskDependency.predecessor_id.in_(task_ids),
                TaskDependency.successor_id.in_(task_ids),
            )
        )
        .all()
        if task_ids
        else []
    )
    return subs, tasks, deps


def structure_version(project, subs, tasks, deps) -> str:
    """结构指纹：只含编辑模式可改的字段（进度等日常录入不会让编辑中的草稿失效）。"""
    data = {
        "project": [project.code, project.name],
        "subs": sorted([s.id, s.name, s.module, s.stage, s.sort_order] for s in subs),
        "tasks": sorted(
            [
                t.id,
                t.sub_project_id,
                t.code,
                t.name,
                bool(t.is_milestone),
                t.owner_id,
                t.planned_start.isoformat(),
                t.planned_end.isoformat(),
                _num(t.estimated_effort),
                _num(t.cost_budget),
                t.notes or "",
                t.sort_order,
            ]
            for t in tasks
        ),
        "deps": sorted([d.predecessor_id, d.successor_id] for d in deps),
    }
    return hashlib.sha256(json.dumps(data, ensure_ascii=False).encode()).hexdigest()


def delete_block_reason(task: Task) -> str | None:
    """已开始或已录实际花费的任务不能在编辑模式里删除。"""
    if task.actual_cost is not None and Decimal(task.actual_cost) > 0:
        return "已录实际花费"
    if task.status != "未开始" or (task.progress or 0) > 0 or task.actual_start or task.actual_end:
        return "已开始"
    return None


def structure_snapshot(db: Session, project: Project) -> dict:
    subs, tasks, deps = _load(db, project.id)
    start, end = live_span(db, [project])[project.id]
    return {
        "version": structure_version(project, subs, tasks, deps),
        "project": {
            "id": project.id,
            "code": project.code,
            "name": project.name,
            "owner_id": project.owner_id,
            "planned_start": start.isoformat(),
            "planned_end": end.isoformat(),
        },
        "sub_projects": [
            {
                "id": s.id,
                "name": s.name,
                "module": s.module,
                "stage": s.stage,
                "sort_order": s.sort_order,
                "status": s.status,
                "progress": s.progress,
            }
            for s in subs
        ],
        "tasks": [
            {
                "id": t.id,
                "sub_project_id": t.sub_project_id,
                "code": t.code,
                "name": t.name,
                "is_milestone": bool(t.is_milestone),
                "owner_id": t.owner_id,
                "planned_start": t.planned_start.isoformat(),
                "planned_end": t.planned_end.isoformat(),
                "estimated_effort": float(t.estimated_effort or 0),
                "cost_budget": None if t.cost_budget is None else float(t.cost_budget),
                "notes": t.notes,
                "status": t.status,
                "progress": t.progress,
                "actual_cost": None if t.actual_cost is None else float(t.actual_cost),
                "locked_reason": delete_block_reason(t),
                "sort_order": t.sort_order,
            }
            for t in tasks
        ],
        "dependencies": [
            {
                "id": d.id,
                "predecessor_id": d.predecessor_id,
                "successor_id": d.successor_id,
                "type": d.type,
                "lag_days": d.lag_days,
            }
            for d in deps
        ],
    }


def _invalid(message: str) -> HTTPException:
    return HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, message)


def _find_cycle(edges: set[tuple[str, str]], names: dict[str, str]) -> list[str] | None:
    graph: dict[str, list[str]] = defaultdict(list)
    for pred, succ in edges:
        graph[pred].append(succ)
    state: dict[str, int] = {}
    path: list[str] = []

    def visit(node: str) -> list[str] | None:
        state[node] = 1
        path.append(node)
        for nxt in graph[node]:
            if state.get(nxt) == 1:
                return path[path.index(nxt) :] + [nxt]
            if state.get(nxt) is None and (found := visit(nxt)):
                return found
        path.pop()
        state[node] = 2
        return None

    for node in list(graph):
        if state.get(node) is None and (found := visit(node)):
            return [names.get(n, n) for n in found]
    return None


def apply_structure(db: Session, project: Project, body: StructureSaveIn, actor: User) -> dict:
    # 串行化同一项目的并发保存（PostgreSQL 行锁；SQLite 忽略）
    db.query(Project).filter_by(id=project.id).with_for_update().first()
    subs, tasks, deps = _load(db, project.id)
    if structure_version(project, subs, tasks, deps) != body.version:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "项目结构已被他人修改，请重新载入后再编辑（本次修改未保存）"
        )
    sub_by_id = {s.id: s for s in subs}
    task_by_id = {t.id: t for t in tasks}

    # —— 校验引用：key 唯一，已有 id 必须属于本项目且只出现一次 —— #
    keys: set[str] = set()
    seen_subs: set[str] = set()
    seen_tasks: set[str] = set()
    payload_tasks = []  # (子项目 key, 任务)
    for sub in body.sub_projects:
        if sub.key in keys:
            raise _invalid(f"重复的标识：{sub.key}")
        keys.add(sub.key)
        if sub.id is not None:
            if sub.id not in sub_by_id or sub.id in seen_subs:
                raise _invalid("子项目不属于本项目或重复出现")
            seen_subs.add(sub.id)
        for task in sub.tasks:
            if task.key in keys:
                raise _invalid(f"重复的标识：{task.key}")
            keys.add(task.key)
            if task.id is not None:
                if task.id not in task_by_id or task.id in seen_tasks:
                    raise _invalid("任务不属于本项目或重复出现")
                seen_tasks.add(task.id)
            payload_tasks.append((sub.key, task))

    codes: dict[str, str] = {}
    for _, task in payload_tasks:
        if task.code in codes:
            raise _invalid(f"任务编号重复：{task.code}")
        codes[task.code] = task.name
        if task.planned_end < task.planned_start:
            raise _invalid(f"「{task.name}」的计划结束早于计划开始")

    # 负责人：新建或改了负责人时必须是启用账号；沿用原负责人不受影响
    owner_ids = {task.owner_id for _, task in payload_tasks}
    users = {u.id: u for u in db.query(User).filter(User.id.in_(owner_ids)).all()}
    for _, task in payload_tasks:
        user = users.get(task.owner_id)
        unchanged = task.id is not None and task_by_id[task.id].owner_id == task.owner_id
        if user is None or (not user.is_active and not unchanged):
            raise _invalid(f"「{task.name}」的负责人不存在或已停用")

    # 前置依赖：引用本次结构中的任务（id 或 key），不能自依赖，不能成环
    id_to_key = {task.id: task.key for _, task in payload_tasks if task.id is not None}
    task_keys = {task.key for _, task in payload_tasks}
    names = {task.key: task.code for _, task in payload_tasks}
    edges: set[tuple[str, str]] = set()
    for _, task in payload_tasks:
        for ref in task.predecessors:
            pred = id_to_key.get(ref) or (ref if ref in task_keys else None)
            if pred is None:
                raise _invalid(f"「{task.name}」的前置任务不存在或已被删除")
            if pred == task.key:
                raise _invalid(f"「{task.name}」不能依赖自己")
            edges.add((pred, task.key))
    if cycle := _find_cycle(edges, names):
        raise _invalid("前置依赖形成了环：" + " → ".join(cycle))

    # 删除保护
    removed_tasks = [t for t in tasks if t.id not in seen_tasks]
    blocked = [f"{t.code}（{r}）" for t in removed_tasks if (r := delete_block_reason(t))]
    if blocked:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "以下任务已开始或已录实际花费，不能删除：" + "、".join(blocked),
        )
    removed_subs = [s for s in subs if s.id not in seen_subs]

    # 项目本身（Lv1）：编号与名称，权限与「修改项目信息」一致（系统管理员 / CMC 负责人 / 项目负责人）
    project_before = {"code": project.code, "name": project.name}
    project_updated = bool(body.project) and (body.project.code, body.project.name) != (
        project.code,
        project.name,
    )
    if project_updated:
        if actor.role not in ("admin", "cmc_lead") and project.owner_id != actor.id:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "只有项目负责人或系统管理员 / CMC 负责人可以修改项目编号和名称",
            )
        taken = (
            db.query(Project.id)
            .filter(Project.code == body.project.code, Project.id != project.id)
            .first()
        )
        if taken:
            raise HTTPException(
                status.HTTP_409_CONFLICT, f"项目编号 {body.project.code} 已存在，请换一个编号"
            )

    # —— 写入 —— #
    if project_updated:
        project.code, project.name = body.project.code, body.project.name
    # 子项目顺序：已有子项目的相对顺序没变、新子项目都排在末尾时，保留原排序号（新的接在最大值之后），
    # 否则按提交顺序重新编号。原样保存不能改动排序号，否则会让他人正在编辑的版本无谓失效。
    existing_order = [sub.id for sub in body.sub_projects if sub.id is not None]
    subs_reordered = existing_order != [
        s.id
        for s in sorted((sub_by_id[i] for i in existing_order), key=lambda s: (s.sort_order, s.id))
    ]
    keep_order = not subs_reordered and all(
        sub.id is None for sub in body.sub_projects[len(existing_order) :]
    )
    next_order = max((s.sort_order or 0 for s in subs), default=0) + 1
    key_to_sub: dict[str, str] = {}
    created_subs = 0
    for order, sub in enumerate(body.sub_projects):
        if sub.id is not None:
            obj = sub_by_id[sub.id]
            obj.name, obj.module, obj.stage = sub.name, sub.module, sub.stage
            if not keep_order:
                obj.sort_order = order
        else:
            if keep_order:
                sort_order, next_order = next_order, next_order + 1
            else:
                sort_order = order
            obj = SubProject(
                id=f"sp-{uuid4().hex[:10]}",
                project_id=project.id,
                name=sub.name,
                module=sub.module,
                stage=sub.stage,
                status="未开始",
                progress=0,
                sort_order=sort_order,
            )
            db.add(obj)
            created_subs += 1
        key_to_sub[sub.key] = obj.id

    # 依赖记录随任务级联删除；计入「删除的依赖」
    removed_task_ids = [t.id for t in removed_tasks]
    cascaded_deps = (
        db.query(TaskDependency)
        .filter(
            or_(
                TaskDependency.predecessor_id.in_(removed_task_ids),
                TaskDependency.successor_id.in_(removed_task_ids),
            )
        )
        .count()
        if removed_task_ids
        else 0
    )
    # 任务有增减或移动的子项目，保存后重算其进度
    touched_subs = {t.sub_project_id for t in removed_tasks}
    for task in removed_tasks:
        db.delete(task)
    db.flush()

    # 任务顺序：按提交列表中的位置（子项目内从 1 开始）。某子项目的任务和先后都没变时保留原顺序号，
    # 原样保存不改数据、不让他人的编辑版本失效。已有任务的先后或所属子项目变化才算「调整顺序」。
    stored_ids: dict[str, list[str]] = defaultdict(list)
    for t in tasks:  # _load 已按 WBS 顺序排列
        if t.id in seen_tasks:
            stored_ids[t.sub_project_id].append(t.id)
    renumber: set[str] = set()
    reordered = subs_reordered  # 子项目或任务的先后有调整
    for sub in body.sub_projects:
        ids = [task.id for task in sub.tasks]
        stored = stored_ids.get(sub.id, []) if sub.id else []
        if sub.id is None or None in ids or ids != stored:
            renumber.add(sub.key)
        existing = [i for i in ids if i is not None]
        if existing != [i for i in stored if i in set(existing)]:
            reordered = True

    key_to_task: dict[str, str] = {}
    created_tasks = updated_tasks = 0
    position: dict[str, int] = defaultdict(int)
    for sub_key, task in payload_tasks:
        position[sub_key] += 1
        values = {
            "sub_project_id": key_to_sub[sub_key],
            "code": task.code,
            "name": task.name,
            "is_milestone": task.is_milestone,
            "owner_id": task.owner_id,
            "planned_start": task.planned_start,
            # 里程碑是时间点：结束 = 开始（工时按提交值保存，已有里程碑的工时不被清零）
            "planned_end": task.planned_start if task.is_milestone else task.planned_end,
            "estimated_effort": task.estimated_effort,
            "cost_budget": task.cost_budget,
            "notes": (task.notes or "").strip() or None,
        }
        if task.id is not None:
            obj = task_by_id[task.id]
            if obj.sub_project_id != values["sub_project_id"]:
                touched_subs.update((obj.sub_project_id, values["sub_project_id"]))
            changed = any(getattr(obj, k) != v for k, v in values.items())
            for k, v in values.items():
                setattr(obj, k, v)
            if sub_key in renumber:
                obj.sort_order = position[sub_key]
            updated_tasks += changed
        else:
            obj = Task(
                id=f"tk-{uuid4().hex[:10]}",
                status="未开始",
                priority="中",
                progress=0,
                is_critical_path=False,
                sort_order=position[sub_key],
                **values,
            )
            db.add(obj)
            created_tasks += 1
            touched_subs.add(values["sub_project_id"])
        key_to_task[task.key] = obj.id
    db.flush()

    # 删掉不再出现的子项目（其任务已删除或已移走）
    if removed_subs:
        removed_ids = [s.id for s in removed_subs]
        db.expire_all()
        if db.query(Task).filter(Task.sub_project_id.in_(removed_ids)).count():
            raise _invalid("要删除的子项目下仍有任务")
        db.query(SubProject).filter(SubProject.id.in_(removed_ids)).delete(
            synchronize_session=False
        )

    # 依赖：按目标集合增删，保留未变化记录的类型与滞后天数
    desired = {(key_to_task[a], key_to_task[b]) for a, b in edges}
    remaining_ids = set(key_to_task.values())
    current = (
        db.query(TaskDependency)
        .filter(
            or_(
                TaskDependency.predecessor_id.in_(remaining_ids),
                TaskDependency.successor_id.in_(remaining_ids),
            )
        )
        .all()
        if remaining_ids
        else []
    )
    kept = set()
    removed_deps = 0
    for dep in current:
        pair = (dep.predecessor_id, dep.successor_id)
        if not (pair[0] in remaining_ids and pair[1] in remaining_ids):
            continue  # 跨项目的依赖不归编辑模式管理，原样保留
        if pair in desired and pair not in kept:
            kept.add(pair)
        else:
            db.delete(dep)
            removed_deps += 1
    for pred, succ in sorted(desired - kept):
        db.add(
            TaskDependency(
                id=f"dep-{uuid4().hex[:10]}",
                predecessor_id=pred,
                successor_id=succ,
                type="FS",
                lag_days=0,
            )
        )
    db.flush()

    # 汇总：只重算任务有增减 / 移动的子项目及项目（没有任务的子项目归零）；
    # 原样保存或只改名称、日期等时不动已有进度
    if touched_subs:
        for sub in db.query(SubProject).filter(SubProject.id.in_(touched_subs)).all():
            if db.query(Task.id).filter_by(sub_project_id=sub.id).first():
                recompute_subproject(db, sub.id)
            else:
                sub.progress, sub.status = 0, "未开始"
        if remaining_ids:
            recompute_project(db, project.id)
        else:
            db.get(Project, project.id).progress = 0

    result = {
        "created_sub_projects": created_subs,
        "deleted_sub_projects": len(removed_subs),
        "created_tasks": created_tasks,
        "updated_tasks": updated_tasks,
        "deleted_tasks": len(removed_tasks),
        "added_dependencies": len(desired - kept),
        "removed_dependencies": removed_deps + cascaded_deps,
        "reordered": reordered,
        "project_updated": project_updated,
    }
    db.add(
        AuditLog(
            id=f"log-{uuid4().hex[:12]}",
            actor_id=actor.id,
            action="项目结构变更",
            target="项目",
            target_id=project.id[:40],
            detail=json.dumps(
                {
                    "project_id": project.id,
                    "summary": (body.summary or "").strip(),
                    **result,
                    "deleted_task_codes": [t.code for t in removed_tasks],
                    **(
                        {
                            "project_before": project_before,
                            "project_after": body.project.model_dump(),
                        }
                        if project_updated
                        else {}
                    ),
                },
                ensure_ascii=False,
            ),
            created_at=datetime.now(UTC),
        )
    )
    db.commit()
    return result
