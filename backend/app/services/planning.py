"""Calendar-aware dependency scheduling with deterministic optimistic concurrency."""

import hashlib
import json
from datetime import date, timedelta

from fastapi import HTTPException

DEFAULT_CALENDAR = {
    "weekdays": [1, 2, 3, 4, 5, 6, 7],
    "holidays": [],
    "working_dates": [],
    "revision": 0,
}


def calendar_dict(row):
    return {key: getattr(row, key) for key in DEFAULT_CALENDAR} if row else dict(DEFAULT_CALENDAR)


def is_workday(day: date, calendar: dict) -> bool:
    iso = day.isoformat()
    if iso in calendar["working_dates"]:
        return True
    return iso not in calendar["holidays"] and day.isoweekday() in calendar["weekdays"]


def move_workdays(day: date, amount: int, calendar: dict) -> date:
    direction = 1 if amount >= 0 else -1
    remaining = abs(amount)
    iterations = 0
    while remaining:
        try:
            day += timedelta(days=direction)
        except OverflowError:
            raise HTTPException(422, "排期超出有效日期范围") from None
        iterations += 1
        if iterations > 36600:
            raise HTTPException(422, "工作日历在有效范围内没有可用日期")
        if is_workday(day, calendar):
            remaining -= 1
    return day


def work_duration(start: date, end: date, calendar: dict) -> int:
    if (end - start).days > 36600:
        raise HTTPException(422, "任务工期超过 100 年，无法进行联动排期")
    return max(
        0,
        sum(is_workday(start + timedelta(days=i), calendar) for i in range((end - start).days + 1))
        - 1,
    )


def state_fingerprint(tasks, deps, calendar: dict) -> str:
    values = [
        {
            "id": t.id,
            "start": t.planned_start.isoformat(),
            "end": t.planned_end.isoformat(),
            "updated": str(t.updated_at),
            "status": t.status,
            "revision": getattr(t, "revision", None),
        }
        for t in sorted(tasks, key=lambda t: t.id)
    ]
    edges = sorted((d.id, d.predecessor_id, d.successor_id, d.type, d.lag_days) for d in deps)
    raw = json.dumps([values, edges, calendar], sort_keys=True, default=str)
    return hashlib.sha256(raw.encode()).hexdigest()


def preview_schedule(tasks, deps, calendar, task_id, new_start, new_end, locked_ids):
    by_id = {t.id: t for t in tasks}
    if task_id not in by_id:
        raise HTTPException(422, "起始任务不属于当前项目")
    if new_end < new_start:
        raise HTTPException(422, "计划结束不能早于开始")
    if not is_workday(new_start, calendar) or not is_workday(new_end, calendar):
        raise HTTPException(422, "新的起止日期须为项目工作日，可先配置例外工作日")
    if by_id[task_id].status in ("已完成", "已验证"):
        raise HTTPException(422, "已完成任务不能参与联动排期")
    if by_id[task_id].is_milestone and new_end != new_start:
        raise HTTPException(422, "里程碑起止日期须一致")
    unknown_locks = set(locked_ids) - by_id.keys()
    if unknown_locks:
        raise HTTPException(422, "锁定任务不属于当前项目")
    incoming = {t.id: [] for t in tasks}
    outgoing = {t.id: [] for t in tasks}
    for edge in deps:
        if edge.predecessor_id in by_id and edge.successor_id in by_id:
            incoming[edge.successor_id].append(edge)
            outgoing[edge.predecessor_id].append(edge)
    degrees = {tid: len(edges) for tid, edges in incoming.items()}
    queue = sorted(tid for tid, degree in degrees.items() if not degree)
    order = []
    while queue:
        tid = queue.pop(0)
        order.append(tid)
        for edge in outgoing[tid]:
            degrees[edge.successor_id] -= 1
            if not degrees[edge.successor_id]:
                queue.append(edge.successor_id)
    if len(order) != len(tasks):
        raise HTTPException(422, "依赖存在循环，请先修正后再排期")
    affected = {task_id}
    queue = [task_id]
    while queue:
        for edge in outgoing[queue.pop(0)]:
            if edge.successor_id not in affected:
                affected.add(edge.successor_id)
                queue.append(edge.successor_id)
    dates = {t.id: (t.planned_start, t.planned_end) for t in tasks}
    dates[task_id] = (new_start, new_end)
    conflicts = []
    for tid in order:
        if tid not in affected:
            continue
        task = by_id[tid]
        start, end = dates[tid]
        duration = 0 if task.is_milestone else work_duration(start, end, calendar)
        required = start
        for edge in incoming[tid]:
            pstart, pend = dates[edge.predecessor_id]
            anchor = pend if edge.type in ("FS", "FF") else pstart
            needed = move_workdays(anchor, edge.lag_days, calendar)
            if edge.type in ("FF", "SF"):
                needed = move_workdays(needed, -duration, calendar)
            if not is_workday(needed, calendar):
                needed = move_workdays(needed, 1, calendar)
            required = max(required, needed)
        if tid == task_id:
            if required > start:
                conflicts.append(
                    {"task_id": tid, "name": task.name, "reason": "起始日期违反前置依赖"}
                )
        elif required > start:
            if tid in locked_ids or task.status in ("已完成", "已验证"):
                conflicts.append(
                    {"task_id": tid, "name": task.name, "reason": "锁定或已完成节点无法满足依赖"}
                )
            else:
                dates[tid] = (required, move_workdays(required, duration, calendar))
        if tid in locked_ids and dates[tid] != (task.planned_start, task.planned_end):
            conflicts.append({"task_id": tid, "name": task.name, "reason": "锁定节点不能移动"})
    changes = [
        {
            "task_id": tid,
            "name": by_id[tid].name,
            "code": by_id[tid].code,
            "old_start": by_id[tid].planned_start.isoformat(),
            "old_end": by_id[tid].planned_end.isoformat(),
            "new_start": dates[tid][0].isoformat(),
            "new_end": dates[tid][1].isoformat(),
            "is_milestone": by_id[tid].is_milestone,
        }
        for tid in order
        if dates[tid] != (by_id[tid].planned_start, by_id[tid].planned_end)
    ]
    return {
        "fingerprint": state_fingerprint(tasks, deps, calendar),
        "changes": changes,
        "conflicts": conflicts,
        "previous_finish": max((t.planned_end for t in tasks), default=new_end).isoformat(),
        "new_finish": max((end for _, end in dates.values()), default=new_end).isoformat(),
    }
