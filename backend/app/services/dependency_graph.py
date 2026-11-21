"""Shared dependency write boundary; the graph may span several projects."""

from collections import defaultdict

from fastapi import HTTPException
from sqlalchemy import text

from app.models import TaskDependency


def lock_dependency_graph(db):
    # Project row locks alone cannot serialize disjoint edges that close one
    # cross-project cycle. Always acquire this before taking any project lock.
    if db.get_bind().dialect.name == "postgresql":
        db.execute(text("SELECT pg_advisory_xact_lock(184225, 1)"))


def validate_dependency_changes(db, additions, removed_ids=()):
    """Reject new duplicates/cycles, while allowing repair of historic bad data.

    additions contains (predecessor, successor, type, lag). Existing unrelated
    cycles do not block a deletion or an independent edit. Call under graph lock.
    """
    removed = set(removed_ids)
    edges = [
        (row.id, row.predecessor_id, row.successor_id, row.type, row.lag_days)
        for row in db.query(TaskDependency).all()
        if row.id not in removed
    ]
    outgoing = defaultdict(set)
    pairs = set()
    for _, pred, succ, _, _ in edges:
        outgoing[pred].add(succ)
        pairs.add((pred, succ))
    for pred, succ, _kind, _lag in additions:
        if pred == succ:
            raise HTTPException(422, "任务不能依赖自身")
        if (pred, succ) in pairs:
            raise HTTPException(409, "这两个任务之间已存在依赖，请编辑现有关系")
        queue, visited = [succ], set()
        while queue:
            current = queue.pop()
            if current == pred:
                raise HTTPException(422, "该修改会形成循环依赖，本次未保存")
            if current not in visited:
                visited.add(current)
                queue.extend(outgoing[current] - visited)
        pairs.add((pred, succ))
        outgoing[pred].add(succ)
