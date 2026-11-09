"""Treat model output as editable proposals; only confirmed, validated actions write data."""

import hashlib
import json
import re
from datetime import UTC, date, datetime
from typing import Literal

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.api.v1.planning import apply_schedule_changes, schedule_state
from app.api.v1.task_collaboration import record_activity
from app.models import AuditLog, SubProject, Task, User
from app.models.pm_management import PMRegisterEntry
from app.models.project_ai_work import ProjectAIAction
from app.schemas.task import TaskCreate
from app.services import ai
from app.services.planning import preview_schedule
from app.services.rollup import recompute_project, recompute_subproject
from app.services.task_order import next_sort_order
from app.services.team import ensure_in_team


class ActionDraft(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    action_key: str = Field(min_length=1, max_length=80, pattern=r"^[A-Za-z0-9_-]+$")
    kind: Literal["task", "risk", "schedule"]
    title: str = Field(min_length=1, max_length=200)
    reason: str = Field(min_length=1, max_length=2000)
    owner_id: str | None = Field(default=None, max_length=64)
    sub_project_id: str | None = Field(default=None, max_length=64)
    task_id: str | None = Field(default=None, max_length=64)
    planned_start: date | None = None
    planned_end: date | None = None
    due_date: date | None = None
    severity: Literal["high", "medium", "low"] = "medium"
    locked_ids: list[str] = Field(default_factory=list, max_length=5000)

    @model_validator(mode="after")
    def required(self):
        if self.kind in {"task", "risk"} and not self.owner_id:
            raise ValueError("请选择负责人")
        if self.kind == "risk" and not self.due_date:
            raise ValueError("请填写风险处理期限")
        if self.kind in {"task", "schedule"} and (not self.planned_start or not self.planned_end):
            raise ValueError("请填写计划起止日期")
        if self.kind == "task" and not self.sub_project_id:
            raise ValueError("请选择新任务所属子项目")
        if self.kind == "schedule" and not self.task_id:
            raise ValueError("请选择调整的任务")
        if self.planned_start and self.planned_end and self.planned_end < self.planned_start:
            raise ValueError("结束日期不能早于开始日期")
        return self


class ActionInput(BaseModel):
    draft: ActionDraft
    fingerprint: str | None = Field(default=None, max_length=64)


def digest(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, ensure_ascii=False, default=str).encode()
    ).hexdigest()


def action_id(report_id, key):
    return digest([report_id, key])[:40]


def proposals(content):
    """Bounded parsing is advisory only; never execute or trust IDs supplied by the model."""
    matches = re.findall(r"```pm-actions\s*([\s\S]*?)```", content[:500000])
    if not matches or len(matches[0]) > 40000:
        return []
    try:
        rows = json.loads(matches[0])
    except (ValueError, TypeError):
        return []
    if not isinstance(rows, list):
        return []
    allowed = {
        "kind",
        "title",
        "reason",
        "owner_id",
        "sub_project_id",
        "task_id",
        "planned_start",
        "planned_end",
        "due_date",
        "severity",
    }
    result = []
    for index, row in enumerate(rows[:12]):
        if not isinstance(row, dict) or row.get("kind") not in {"task", "risk", "schedule"}:
            continue
        values = {k: v[:2000] for k, v in row.items() if k in allowed and isinstance(v, str)}
        values["action_key"] = f"suggestion-{index}"
        result.append(values)
    return result


def preview_action(db, project, user, report, draft):
    if draft.kind in {"task", "risk"}:
        ensure_in_team(db, project, [draft.owner_id])
        owner = db.get(User, draft.owner_id)
        if not owner or not owner.is_active:
            raise HTTPException(422, "负责人须为活跃的项目团队成员")
    changes = []
    schedule = None
    if draft.kind == "task":
        sub = db.get(SubProject, draft.sub_project_id)
        if not sub or sub.project_id != project.id:
            raise HTTPException(422, "子项目不属于当前项目")
        changes = [
            {
                "type": "新增任务",
                "name": draft.title,
                "owner_id": draft.owner_id,
                "sub_project_id": sub.id,
                "start": draft.planned_start,
                "end": draft.planned_end,
                "status": "未开始",
                "progress": 0,
            }
        ]
    elif draft.kind == "risk":
        changes = [
            {
                "type": "新增风险",
                "name": draft.title,
                "owner_id": draft.owner_id,
                "due_date": draft.due_date,
                "severity": draft.severity,
            }
        ]
    else:
        tasks, deps, calendar = schedule_state(db, user, project.id)
        schedule = preview_schedule(
            tasks,
            deps,
            calendar,
            draft.task_id,
            draft.planned_start,
            draft.planned_end,
            draft.locked_ids,
        )
        if schedule["conflicts"]:
            raise HTTPException(
                409,
                {
                    "message": "建议与锁定节点或依赖冲突，请调整后重新预览",
                    "conflicts": schedule["conflicts"],
                },
            )
        changes = schedule["changes"]
        if not changes:
            raise HTTPException(422, "计划日期未变化，无需执行")
    _, source = ai.project_context(db, project)
    normalized = draft.model_dump(mode="json")
    return {
        "draft": normalized,
        "changes": changes,
        "fingerprint": digest(
            [
                source["fingerprint"],
                report.id,
                normalized,
                changes,
                schedule["fingerprint"] if schedule else None,
            ]
        ),
        "report_stale": report.source.get("fingerprint") != source["fingerprint"],
        "schedule": schedule,
    }


def apply_action(db, project, user, report, payload):
    draft = payload.draft
    key = action_id(report.id, draft.action_key)
    old = db.get(ProjectAIAction, key)
    if old:
        if old.draft != draft.model_dump(mode="json"):
            raise HTTPException(409, "这条建议已经执行，请查看执行记录，避免重复创建")
        return {**old.result, "replayed": True}
    result = preview_action(db, project, user, report, draft)
    if payload.fingerprint != result["fingerprint"]:
        raise HTTPException(409, "项目数据或建议内容已变化，请重新预览再执行")
    target_id = "ai-" + key[:30]
    if draft.kind == "task":
        data = TaskCreate(
            id=target_id,
            code="AI-" + key[:12],
            name=draft.title,
            sub_project_id=draft.sub_project_id,
            owner_id=draft.owner_id,
            planned_start=draft.planned_start,
            planned_end=draft.planned_end,
            notes=f"来源分析：{report.id}\n采纳原因：{draft.reason}",
            sort_order=next_sort_order(db, draft.sub_project_id),
        )
        task = Task(**data.model_dump())
        db.add(task)
        db.flush()
        record_activity(
            db,
            task,
            user,
            "change",
            "从 AI 建议创建任务",
            {"name": {"before": None, "after": task.name}},
        )
        recompute_subproject(db, task.sub_project_id)
    elif draft.kind == "risk":
        db.add(
            PMRegisterEntry(
                id=target_id,
                project_id=project.id,
                kind="risk",
                title=draft.title,
                owner_id=draft.owner_id,
                due_date=draft.due_date,
                severity=draft.severity,
                mitigation=f"来源分析：{report.id}\n{draft.reason}",
                status="open",
            )
        )
    else:
        tasks, _, _ = schedule_state(db, user, project.id, lock=True)
        apply_schedule_changes(
            db, user, tasks, result["changes"], f"采纳 AI 排期建议：{draft.reason}"
        )
        target_id = draft.task_id
    db.flush()
    recompute_project(db, project.id)
    view = {
        "kind": draft.kind,
        "target_id": target_id,
        "changes": result["changes"],
        "replayed": False,
    }
    # JSON columns require ISO dates, unlike FastAPI's response encoder.
    view = json.loads(json.dumps(view, default=str))
    db.add(
        ProjectAIAction(
            id=key,
            analysis_id=report.id,
            action_key=draft.action_key,
            created_by=user.id,
            created_at=datetime.now(UTC),
            draft=draft.model_dump(mode="json"),
            result=view,
        )
    )
    db.add(
        AuditLog(
            id="log-" + key[:24],
            actor_id=user.id,
            action="确认执行 AI 建议",
            target="项目",
            target_id=project.id,
            created_at=datetime.now(UTC),
            detail=json.dumps(
                {"analysis_id": report.id, "draft": draft.model_dump(mode="json"), "result": view},
                ensure_ascii=False,
            ),
        )
    )
    db.commit()
    return view
