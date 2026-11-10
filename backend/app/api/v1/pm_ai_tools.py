"""Project tools shared by the local assistant and authenticated MCP clients."""

import json
from datetime import UTC, datetime
from typing import Annotated
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.api.deps import get_current_user
from app.api.v1.planning import schedule_state
from app.api.v1.pm_ai import CurrentUser as ProjectAIUser
from app.api.v1.project_ai_work import current_analyst, project_access
from app.core.config import settings
from app.db.session import get_db
from app.models import User
from app.services import project_schedule_assist
from app.services.pm_ai_agent import PlanRequest, plan_question
from app.services.pm_ai_context import MANAGERS, ContextRequest, recheck_user
from app.services.pm_ai_triage import TriageRequest, build_triage

router = APIRouter(prefix="/pm-ai", tags=["pm-ai-tools"])
DB = Annotated[Session, Depends(get_db)]
Analyst = Annotated[User, Depends(current_analyst)]
CurrentUser = Annotated[User, Depends(get_current_user)]
MCP_VERSION = "2025-06-18"


class ScheduleComparison(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    project_id: str = Field(min_length=1, max_length=64)
    task_id: str = Field(min_length=1, max_length=64)
    delays: list[Annotated[int, Field(strict=True, ge=1, le=365)]] = Field(
        min_length=1, max_length=3
    )
    locked_ids: list[Annotated[str, Field(min_length=1, max_length=64)]] = Field(
        default_factory=list, max_length=200
    )


@router.post("/schedule/compare")
def compare_schedules(payload: ScheduleComparison, db: DB, user: Analyst):
    return schedule_comparison(payload, db, user, confirmable=True)


def schedule_comparison(payload, db, user, *, confirmable):
    if user.role not in MANAGERS:
        raise HTTPException(403, "排期比较需要项目管理权限")
    project_access(db, user, payload.project_id, write=True, lock=confirmable)
    tasks, dependencies, calendar = schedule_state(db, user, payload.project_id, lock=confirmable)
    task = project_schedule_assist.selected_task(tasks, payload.task_id)
    locked = [
        {
            "task_id": item.id,
            "name": item.name,
            "code": item.code,
            "start_date": item.planned_start.isoformat(),
            "date": item.planned_end.isoformat(),
        }
        for item in tasks
        if item.id in payload.locked_ids
    ]
    # preview_schedule validates all supplied IDs, including an unknown lock.
    from app.services.planning import move_workdays, preview_schedule

    plans = []
    for days in dict.fromkeys(payload.delays):
        start = move_workdays(task.planned_start, days, calendar)
        end = move_workdays(task.planned_end, days, calendar)
        schedule = preview_schedule(
            tasks, dependencies, calendar, task.id, start, end, payload.locked_ids
        )
        plan = {"delay_workdays": days, "locked_milestones": locked, "schedule": schedule}
        if confirmable:
            token = expires = None
            if schedule["changes"] and not schedule["conflicts"]:
                token, expires = project_schedule_assist.issue_confirmation(
                    user.id,
                    payload.project_id,
                    task.id,
                    project_schedule_assist.DelayIntent(delay_workdays=days, fixed_milestones=[]),
                    locked,
                    start,
                    end,
                    schedule,
                    {
                        "provider": "rules",
                        "providers": {"rules": {"model": "project-calendar-v1"}},
                        "revision": calendar["revision"],
                    },
                )
            plan.update(confirmation_token=token, expires_at=expires)
        plans.append(plan)
    return {
        "as_of": datetime.now(UTC),
        "calendar": {"weekdays": calendar["weekdays"], "revision": calendar["revision"]},
        "plans": plans,
        "review_url": (
            f"/projects/{quote(payload.project_id, safe='')}?tab=wbs&task={quote(task.id, safe='')}"
        ),
    }


@router.post("/agent/plan")
def plan_agent(payload: PlanRequest, db: DB, user: ProjectAIUser):
    return plan_question(db, user, payload)


@router.post("/agent/triage")
def triage_agent(payload: TriageRequest, db: DB, user: ProjectAIUser):
    return build_triage(db, user, payload)


class RunIdentifier(BaseModel):
    model_config = ConfigDict(extra="forbid")
    run_id: str = Field(min_length=1, max_length=40)


class ContextIdentifier(BaseModel):
    model_config = ConfigDict(extra="forbid")
    project_id: str | None = Field(default=None, max_length=64)


class HistoryPage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    page: int = Field(default=1, ge=1)
    page_size: int = Field(default=20, ge=1, le=50)
    project_id: str | None = Field(default=None, min_length=1, max_length=64)
    task_id: str | None = Field(default=None, min_length=1, max_length=64)


def tool_definitions():
    tools = [
        ("pm_context", "读取有权查看的项目上下文与证据", ContextIdentifier, True, True),
        (
            "pm_agent_plan",
            "识别问题的项目、任务与分析方式，返回可核对范围",
            PlanRequest,
            True,
            True,
        ),
        ("pm_work_priorities", "按任务实际状态列出当前工作重点与来源", TriageRequest, True, True),
        (
            "pm_compare_schedule",
            "按项目日历比较顺延方案和固定里程碑冲突，需要项目管理权限",
            ScheduleComparison,
            True,
            True,
        ),
        (
            "pm_analyze",
            "生成项目重点、异常解释、周报、会议草稿或措施跟踪；结果需本人复核",
            ContextRequest,
            False,
            False,
        ),
        (
            "pm_run_status",
            "读取本人分析任务的状态、证据与草稿，review_url 可交给用户打开",
            RunIdentifier,
            True,
            True,
        ),
        ("pm_run_history", "分页读取本人的分析历史", HistoryPage, True, True),
        ("pm_cancel_analysis", "取消本人尚未完成的分析任务", RunIdentifier, False, True),
    ]
    return [
        {
            "name": name,
            "description": description,
            "inputSchema": schema.model_json_schema(),
            "annotations": {
                "readOnlyHint": readonly,
                "destructiveHint": False,
                "idempotentHint": idempotent,
                "openWorldHint": name == "pm_analyze",
            },
        }
        for name, description, schema, readonly, idempotent in tools
    ]


@router.get("/tools")
def list_tools(user: CurrentUser):
    return {
        "schema_version": 1,
        "tools": tool_definitions(),
        "mcp_endpoint": "/api/v1/pm-ai/mcp",
        "execution": "业务变更由本人在应用中核对差异后确认",
    }


def call_tool(name, arguments, db, user):
    from app.api.v1 import pm_ai

    user = recheck_user(db, user.id)

    if name == "pm_context":
        value = ContextIdentifier.model_validate(arguments)
        return pm_ai.get_context(db, user, value.project_id)
    if name == "pm_agent_plan":
        return plan_question(db, user, PlanRequest.model_validate(arguments))
    if name == "pm_work_priorities":
        return build_triage(db, user, TriageRequest.model_validate(arguments))
    if name == "pm_compare_schedule":
        return schedule_comparison(
            ScheduleComparison.model_validate(arguments), db, user, confirmable=False
        )
    if name == "pm_analyze":
        return pm_ai.create_run(ContextRequest.model_validate(arguments), db, user)
    if name == "pm_run_status":
        value = RunIdentifier.model_validate(arguments)
        return pm_ai.get_run(value.run_id, db, user)
    if name == "pm_run_history":
        value = HistoryPage.model_validate(arguments)
        return pm_ai.list_runs(db, user, **value.model_dump())
    if name == "pm_cancel_analysis":
        value = RunIdentifier.model_validate(arguments)
        return pm_ai.cancel_run(value.run_id, db, user)
    raise ValueError("unknown tool")


@router.get("/mcp")
def mcp_stream(user: CurrentUser):
    return Response(status_code=405, headers={"Allow": "POST"})


@router.post("/mcp")
async def mcp(request: Request, db: DB, user: CurrentUser):
    origin = request.headers.get("origin")
    if origin and origin not in {settings.pms_origin, settings.portal_origin}:
        raise HTTPException(403, "请求来源验证失败")
    protocol = request.headers.get("mcp-protocol-version")
    if protocol and protocol != MCP_VERSION:
        raise HTTPException(400, "不支持该 MCP 协议版本")
    try:
        message = await request.json()
    except ValueError:
        return JSONResponse(
            {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Invalid JSON"}}
        )
    request_id = message.get("id") if isinstance(message, dict) else None

    def error(code, text):
        return JSONResponse(
            {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": text}}
        )

    if (
        not isinstance(message, dict)
        or message.get("jsonrpc") != "2.0"
        or not isinstance(message.get("method"), str)
        or ("id" in message and type(request_id) not in (str, int))
    ):
        return error(-32600, "Invalid Request")
    method = message["method"]
    if "id" not in message:
        if method == "notifications/initialized":
            return Response(status_code=202)
        return error(-32600, "Unsupported notification")
    params = message.get("params", {})
    if not isinstance(params, dict):
        return error(-32602, "Invalid params")
    if method == "initialize":
        result = {
            "protocolVersion": MCP_VERSION,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": "pm-local-assistant", "version": "1.0"},
            "instructions": "使用当前身份读取项目和生成草稿。请将分析的 review_url 交给用户核对。业务变更需要用户在页面中确认。",
        }
    elif method == "ping":
        result = {}
    elif method == "tools/list":
        result = {"tools": tool_definitions()}
    elif method == "tools/call":
        if not isinstance(params.get("name"), str) or not isinstance(
            params.get("arguments", {}), dict
        ):
            return error(-32602, "Invalid tool arguments")
        try:
            value = jsonable_encoder(
                await run_in_threadpool(
                    call_tool, params["name"], params.get("arguments", {}), db, user
                )
            )
            result = {
                "content": [{"type": "text", "text": json.dumps(value, ensure_ascii=False)}],
                "structuredContent": value,
                "isError": False,
            }
        except ValidationError:
            return error(-32602, "工具参数未通过校验")
        except ValueError:
            return error(-32602, "未知工具")
        except HTTPException as exc:
            safe = exc.detail if isinstance(exc.detail, str) else "项目工具调用失败"
            result = {"content": [{"type": "text", "text": safe}], "isError": True}
    else:
        return error(-32601, "Method not found")
    return JSONResponse(jsonable_encoder({"jsonrpc": "2.0", "id": request_id, "result": result}))
