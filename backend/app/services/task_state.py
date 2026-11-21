"""One status/progress contract for task writes; never repair untouched history."""

from fastapi import HTTPException

DONE = {"已完成", "已验证"}
ACTIVE = {"进行中", "延迟", "阻塞"}


def task_state_patch(current, changes: dict) -> dict:
    result = dict(changes)
    if not {"status", "progress", "is_milestone"} & result.keys():
        return result
    status = result.get("status", getattr(current, "status", "未开始"))
    progress = result.get("progress", getattr(current, "progress", 0))
    milestone = result.get("is_milestone", getattr(current, "is_milestone", False))
    if "status" in result and "progress" not in result:
        if status in DONE:
            progress = 100
        elif status == "未开始" or milestone or getattr(current, "status", None) in DONE:
            progress = 0
    elif "progress" in result and "status" not in result:
        if progress == 100:
            status = status if status in DONE else "已完成"
        elif status in DONE or (status == "未开始" and progress > 0):
            status = "进行中"
    if (
        (status in DONE and progress != 100)
        or (status == "未开始" and progress != 0)
        or (status in ACTIVE and progress >= 100)
        or (milestone and progress not in (0, 100))
    ):
        raise HTTPException(
            422, "状态与进度不一致：未开始为 0%，完成或验证为 100%；里程碑进行中为 0%"
        )
    if progress != getattr(current, "progress", None) or "progress" in result:
        result["progress"] = progress
    if status != getattr(current, "status", None) or "status" in result:
        result["status"] = status
    return result
