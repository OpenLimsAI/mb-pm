#!/usr/bin/env python3
"""Maibo's delegated business API client and local MCP stdio server."""

from __future__ import annotations

import argparse
import http.client
import json
import os
import re
import sys
from dataclasses import dataclass
from typing import BinaryIO
from urllib.parse import quote, urlencode, urlsplit

BASE_URL_ENV = "MAIBO_AGENT_BASE_URL"
TOKEN_ENV = "MAIBO_AGENT_TOKEN"
API_ROOT = "/api/v1/agent"
HTTP_TIMEOUT = 15
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
MAX_MESSAGE_BYTES = 64 * 1024
PROTOCOL_VERSIONS = ("2025-11-25", "2025-06-18")


class AgentError(Exception):
    def __init__(self, code: str, message: str, status: int | None = None):
        super().__init__(message)
        self.code = code
        self.status = status

    def as_json(self) -> dict:
        result = {"code": self.code, "message": str(self)}
        if self.status is not None:
            result["http_status"] = self.status
        return {"error": result}


ID = {"type": "string", "minLength": 1, "maxLength": 64}
DATE = {"type": "string", "minLength": 10, "maxLength": 10, "format": "date"}
PAGING = {
    "page": {"type": "integer", "minimum": 1, "maximum": 10_000, "default": 1},
    "page_size": {"type": "integer", "minimum": 1, "maximum": 50, "default": 20},
}


@dataclass(frozen=True)
class Tool:
    description: str
    path: str
    fields: dict
    method: str = "GET"
    required: tuple[str, ...] = ()
    mutates: bool = False

    @property
    def path_args(self) -> tuple[str, ...]:
        return tuple(re.findall(r"\{(\w+)\}", self.path))

    def schema(self) -> dict:
        return {
            "type": "object",
            "properties": self.fields,
            "required": [*self.path_args, *self.required],
            "additionalProperties": False,
        }

    def endpoint(self, arguments: dict) -> str:
        if not isinstance(arguments, dict) or arguments.keys() - self.fields.keys():
            raise AgentError("invalid_arguments", "请提供工具声明的参数。")
        query = {}
        path = self.path
        for key in self.schema()["required"]:
            if key not in arguments:
                raise AgentError("invalid_arguments", f"缺少参数 {key}。")
        for key, value in arguments.items():
            schema = self.fields[key]
            if not valid_value(schema, value):
                raise AgentError("invalid_arguments", f"参数 {key} 不符合工具声明。")
            if key in self.path_args:
                if value in {".", ".."} or re.search(r"[/\\%\s]", value):
                    raise AgentError(
                        "invalid_arguments", f"参数 {key} 不能包含路径分隔符。"
                    )
                path = path.replace("{" + key + "}", quote(value, safe=""))
            elif self.method == "GET":
                query[key] = str(value).lower() if type(value) is bool else value
        return API_ROOT + path + ("?" + urlencode(query) if query else "")


def valid_value(schema: dict, value) -> bool:
    if "oneOf" in schema:
        return sum(valid_value(variant, value) for variant in schema["oneOf"]) == 1
    if "enum" in schema and value not in schema["enum"]:
        return False
    if schema["type"] == "integer":
        return type(value) is int and schema["minimum"] <= value <= schema["maximum"]
    if schema["type"] == "boolean":
        return type(value) is bool
    if schema["type"] == "array":
        return (
            isinstance(value, list)
            and schema.get("minItems", 0) <= len(value) <= schema["maxItems"]
            and all(valid_value(schema["items"], item) for item in value)
        )
    if schema["type"] == "object":
        fields = schema["properties"]
        return (
            isinstance(value, dict)
            and not value.keys() - fields.keys()
            and not set(schema["required"]) - value.keys()
            and all(valid_value(fields[key], item) for key, item in value.items())
        )
    return (
        isinstance(value, str)
        and schema.get("minLength", 0) <= len(value) <= schema.get("maxLength", 10_000)
        and not re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\ud800-\udfff]", value)
        and ("pattern" not in schema or bool(re.fullmatch(schema["pattern"], value)))
    )


def string(max_length: int, min_length: int = 1) -> dict:
    return {"type": "string", "minLength": min_length, "maxLength": max_length}


def enum(*values: str) -> dict:
    return {"type": "string", "enum": list(values)}


def integer(minimum: int, maximum: int) -> dict:
    return {"type": "integer", "minimum": minimum, "maximum": maximum}


def action(kind: str, required: dict, **optional) -> dict:
    return {
        "type": "object",
        "properties": {"kind": enum(kind), **required, **optional},
        "required": ["kind", *required],
        "additionalProperties": False,
    }


TASK_VERSION = {"task_id": ID, "expected_revision": integer(1, 2_147_483_647)}
REQUEST_ID = {**string(80), "pattern": r"^[A-Za-z0-9._:-]+$"}
MODEL_CONSENT = {
    "type": "boolean",
    "enum": [True],
    "description": "仅在用户同意将项目快照交给已配置模型时填写 true。",
}
JOB_PATH = "/projects/{project_id}/analysis-jobs/{job_id}"
JOB_IDS = {"project_id": ID, "job_id": ID}
IDS = {"type": "array", "maxItems": 200, "items": ID}
SCHEDULE = {
    "task_id": ID,
    "new_start": DATE,
    "new_end": DATE,
    "delay_workdays": integer(1, 365),
    "locked_ids": IDS,
}
ACTION = {
    "oneOf": [
        action(
            "schedule",
            {"task_id": ID},
            **{k: v for k, v in SCHEDULE.items() if k != "task_id"},
            fingerprint=string(64, 64),
        ),
        action(
            "create_task",
            {
                "sub_project_id": ID,
                "name": string(200),
                "owner_id": ID,
                "planned_start": DATE,
                "planned_end": DATE,
            },
            notes=string(5000, 0),
        ),
        action(
            "update_progress",
            {**TASK_VERSION, "progress": integer(0, 100)},
            progress_note=string(5000, 0),
        ),
        action("reassign_task", {**TASK_VERSION, "owner_id": ID}),
        action(
            "register_risk",
            {"title": string(200), "owner_id": ID, "due_date": DATE},
            severity=enum("low", "medium", "high"),
            mitigation=string(5000, 0),
        ),
        action(
            "attach_deliverable",
            {**TASK_VERSION, "title": string(200), "url": string(2000)},
            notes=string(5000, 0),
        ),
        action(
            "submit_acceptance",
            {
                **TASK_VERSION,
                "expected_acceptance_updated_at": string(64),
                "deliverable_ids": {**IDS, "minItems": 1, "maxItems": 100},
            },
        ),
    ]
}


TOOLS = {
    "projects": Tool("分页列出当前用户可见的项目。", "/projects", PAGING),
    "tasks": Tool(
        "分页列出可见任务，可按项目、负责人、状态、截止日期和逾期筛选。",
        "/tasks",
        {
            "project_id": ID,
            "sub_project_id": ID,
            "owner_id": ID,
            "status": string(32),
            "due_from": DATE,
            "due_to": DATE,
            "overdue": {"type": "boolean", "description": "为 true 时仅返回逾期任务。"},
            **PAGING,
        },
    ),
    "task": Tool(
        "读取一项可见任务的详情、依赖、活动、交付物和验收要求。",
        "/tasks/{task_id}",
        {"task_id": ID, **PAGING},
    ),
    "baseline": Tool(
        "比较当前任务计划与项目基线。省略基线编号时使用最新基线。",
        "/tasks/{task_id}/baseline",
        {"task_id": ID, "baseline_id": ID},
    ),
    "risk-report": Tool(
        "生成项目逾期风险报告。返回审核链接时，可由用户在迈博中查看并保存。",
        "/projects/{project_id}/risk-report",
        {"project_id": ID},
    ),
    "project-context": Tool(
        "查询可见的子项目、项目成员和可执行操作。",
        "/projects/{project_id}/context",
        {"project_id": ID, **PAGING},
    ),
    "register": Tool(
        "查询项目的风险、问题和决策台账。",
        "/projects/{project_id}/register",
        {
            "project_id": ID,
            "kind": enum("risk", "issue", "decision"),
            "status": enum("open", "closed"),
            **PAGING,
        },
    ),
    "schedule-preview": Tool(
        "只模拟排期影响：指定计划起止日期或延期工作日数。",
        "/projects/{project_id}/schedule-preview",
        {"project_id": ID, **SCHEDULE},
        method="POST",
        required=("task_id",),
    ),
    "propose": Tool(
        "提交待人工确认的业务提案。使用稳定 request_id；相同请求可安全重放。",
        "/projects/{project_id}/proposals",
        {
            "project_id": ID,
            "request_id": REQUEST_ID,
            "reason": string(2000),
            "action": ACTION,
        },
        method="POST",
        required=("request_id", "reason", "action"),
        mutates=True,
    ),
    "proposals": Tool(
        "查询本人的项目提案和执行状态。",
        "/projects/{project_id}/proposals",
        {"project_id": ID, **PAGING},
    ),
    "proposal": Tool(
        "查询提案的当前状态和执行回执。",
        "/proposals/{proposal_id}",
        {"proposal_id": ID},
    ),
    "cancel-proposal": Tool(
        "撤销尚未执行的提案。",
        "/proposals/{proposal_id}/cancel",
        {"proposal_id": ID},
        method="POST",
        mutates=True,
    ),
    "retry-proposal": Tool(
        "基于最新数据重新预览失效提案，并生成需人工确认的新提案。",
        "/proposals/{proposal_id}/retry",
        {"proposal_id": ID, "request_id": REQUEST_ID},
        method="POST",
        required=("request_id",),
        mutates=True,
    ),
    "knowledge-search": Tool(
        "搜索当前用户有权访问的知识库，返回来源、版本和摘要。",
        "/knowledge/search",
        {"q": string(500), "offset": integer(0, 1_000_000), "limit": integer(1, 30)},
        required=("q",),
    ),
    "knowledge-read": Tool(
        "按来源编号和版本分段读取知识库原文。",
        "/knowledge/read",
        {
            "source_id": string(1024),
            "version": string(64, 64),
            "offset": integer(0, 4_000_000),
            "limit": integer(1, 24000),
        },
        required=("source_id",),
    ),
    "changes": Tool(
        "读取项目变更；保存 next_cursor，下次带回以继续读取。",
        "/projects/{project_id}/changes",
        {
            "project_id": ID,
            "cursor": string(2048),
            "kind": enum("delay", "deliverable", "approval", "task_update"),
            "limit": integer(1, 50),
            "days": integer(1, 90),
        },
    ),
    "start-analysis": Tool(
        "提交后台项目分析。仅在用户同意将项目快照交给已配置模型时调用。",
        "/projects/{project_id}/analysis-jobs",
        {
            "project_id": ID,
            "request_id": REQUEST_ID,
            "focus": string(1500, 0),
            "prompt": string(4000, 0),
            "allow_model_processing": MODEL_CONSENT,
        },
        method="POST",
        required=("request_id", "allow_model_processing"),
        mutates=True,
    ),
    "analysis-jobs": Tool(
        "列出当前账号发起的后台项目分析。",
        "/projects/{project_id}/analysis-jobs",
        {"project_id": ID, **PAGING},
    ),
    "analysis-job": Tool("查询后台分析状态。", JOB_PATH, JOB_IDS),
    "analysis-result": Tool(
        "获取已完成的后台分析结果和来源链接。", JOB_PATH + "/result", JOB_IDS
    ),
    "cancel-analysis": Tool(
        "取消排队或正在处理的后台分析。",
        JOB_PATH + "/cancel",
        JOB_IDS,
        method="POST",
        mutates=True,
    ),
    "retry-analysis": Tool(
        "经用户同意后，用新请求编号重新提交失败或取消的分析。",
        JOB_PATH + "/retry",
        {**JOB_IDS, "request_id": REQUEST_ID, "allow_model_processing": MODEL_CONSENT},
        method="POST",
        required=("request_id", "allow_model_processing"),
        mutates=True,
    ),
}

HTTP_ERRORS = {
    401: ("authentication_failed", "请检查委托令牌是否有效或已过期。"),
    403: ("forbidden", "当前用户无权执行该操作。"),
    404: ("not_found", "记录不存在或当前用户不可见。"),
    409: ("conflict", "记录已变更或请求冲突，请先查询当前状态。"),
    410: ("expired", "原游标或记录已过期，请重新查询。"),
    422: ("invalid_arguments", "请求参数或业务条件无效。"),
    429: ("rate_limited", "请求过于频繁，请稍后重试。"),
    503: ("unavailable", "迈博 Agent 接口或身份服务暂不可用。"),
}


class Client:
    def __init__(self, base_url: str, token: str):
        try:
            url = urlsplit(base_url)
            self.port = url.port
        except ValueError:
            raise AgentError(
                "configuration_error", f"{BASE_URL_ENV} 格式无效。"
            ) from None
        if (
            url.scheme not in {"http", "https"}
            or not url.hostname
            or url.username is not None
            or url.path not in {"", "/"}
            or re.search(r"[\s\x00-\x1f\x7f?#\\]", base_url)
        ):
            raise AgentError(
                "configuration_error", f"请将 {BASE_URL_ENV} 设为迈博服务的完整源地址。"
            )
        if url.scheme == "http" and url.hostname not in {
            "localhost",
            "127.0.0.1",
            "::1",
        }:
            raise AgentError("configuration_error", "远程迈博地址必须使用 HTTPS。")
        if len(token) > 32768 or not re.fullmatch(r"[A-Za-z0-9._~+/\-]+=*", token):
            raise AgentError(
                "configuration_error", f"请在 {TOKEN_ENV} 中设置有效的用户委托令牌。"
            )
        self.connection = (
            http.client.HTTPSConnection
            if url.scheme == "https"
            else http.client.HTTPConnection
        )
        self.host = url.hostname
        self.token = token

    def call(self, tool: Tool, arguments: dict) -> dict:
        endpoint = tool.endpoint(arguments)
        headers = {
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/json",
        }
        request = {}
        if tool.method != "GET":
            headers["Content-Type"] = "application/json"
            request["body"] = json.dumps(
                {k: v for k, v in arguments.items() if k not in tool.path_args},
                ensure_ascii=False,
            ).encode("utf-8")
        conn = self.connection(self.host, self.port, timeout=HTTP_TIMEOUT)
        try:
            # A single direct request keeps the delegated token on its configured origin.
            conn.request(
                tool.method,
                endpoint,
                headers=headers,
                **request,
            )
            with conn.getresponse() as response:
                if 300 <= response.status < 400:
                    raise AgentError(
                        "unexpected_redirect", "迈博接口返回了重定向。", response.status
                    )
                if not 200 <= response.status < 300:
                    code, message = HTTP_ERRORS.get(
                        response.status, ("http_error", "迈博请求失败。")
                    )
                    raise AgentError(code, message, response.status)
                if response.headers.get_content_type() != "application/json":
                    raise AgentError("invalid_response", "迈博接口返回了非 JSON 内容。")
                body = response.read(MAX_RESPONSE_BYTES + 1)
        except TimeoutError:
            raise AgentError("timeout", "等待迈博接口响应超时。") from None
        except (OSError, http.client.HTTPException, UnicodeError):
            raise AgentError("connection_error", "无法连接到配置的迈博服务。") from None
        finally:
            conn.close()

        if len(body) > MAX_RESPONSE_BYTES:
            raise AgentError("response_too_large", "迈博响应过大，请缩小查询范围。")
        try:
            result = json.loads(body)
        except (ValueError, RecursionError):
            raise AgentError("invalid_response", "迈博接口返回了无效 JSON。") from None
        if not isinstance(result, dict):
            raise AgentError("invalid_response", "迈博接口返回了意外的 JSON 结构。")
        return result


def write_json(stream: BinaryIO, value: dict) -> None:
    stream.write(
        json.dumps(value, ensure_ascii=False).encode("utf-8", errors="backslashreplace")
        + b"\n"
    )
    stream.flush()


def rpc_error(request_id, code: int, message: str) -> dict:
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "error": {"code": code, "message": message},
    }


def serve_mcp(client: Client, incoming: BinaryIO, outgoing: BinaryIO) -> None:
    protocol = None
    ready = False
    while raw := incoming.readline(MAX_MESSAGE_BYTES + 1):
        if len(raw) > MAX_MESSAGE_BYTES:
            write_json(outgoing, rpc_error(None, -32700, "MCP message too large"))
            return
        try:
            message = json.loads(raw.decode("utf-8"))
        except (ValueError, RecursionError):
            write_json(outgoing, rpc_error(None, -32700, "Invalid JSON"))
            continue
        if (
            not isinstance(message, dict)
            or message.get("jsonrpc") != "2.0"
            or not isinstance(message.get("method"), str)
            or ("id" in message and type(message["id"]) not in {int, str})
        ):
            write_json(outgoing, rpc_error(None, -32600, "Invalid request"))
            continue
        method = message["method"]
        if "id" not in message:
            if method == "notifications/initialized" and protocol is not None:
                ready = True
            continue
        request_id = message["id"]
        params = message.get("params", {})
        if not isinstance(params, dict):
            write_json(outgoing, rpc_error(request_id, -32602, "Invalid params"))
            continue

        if method == "ping":
            result = {}
        elif method == "initialize":
            version = params.get("protocolVersion")
            if protocol is not None or not isinstance(version, str):
                write_json(
                    outgoing, rpc_error(request_id, -32602, "Invalid initialize")
                )
                continue
            protocol = version if version in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0]
            result = {
                "protocolVersion": protocol,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "maibo-agent", "version": "1.1.0"},
            }
        elif not ready:
            write_json(
                outgoing, rpc_error(request_id, -32002, "Server not initialized")
            )
            continue
        elif method == "tools/list":
            result = {
                "tools": [
                    {
                        "name": name.replace("-", "_"),
                        "description": tool.description,
                        "inputSchema": tool.schema(),
                        "annotations": {
                            "readOnlyHint": not tool.mutates,
                            "openWorldHint": False,
                        },
                    }
                    for name, tool in TOOLS.items()
                ]
            }
        elif method == "tools/call":
            name = params.get("name")
            tool = TOOLS.get(name.replace("_", "-")) if isinstance(name, str) else None
            if tool is None:
                write_json(outgoing, rpc_error(request_id, -32602, "Unknown tool"))
                continue
            try:
                payload = client.call(tool, params.get("arguments", {}))
            except AgentError as exc:
                result = {
                    "isError": True,
                    "content": [
                        {
                            "type": "text",
                            "text": json.dumps(exc.as_json(), ensure_ascii=False),
                        }
                    ],
                }
            else:
                result = {
                    "content": [
                        {
                            "type": "text",
                            "text": json.dumps(payload, ensure_ascii=False),
                        }
                    ],
                    "structuredContent": payload,
                }
        else:
            write_json(outgoing, rpc_error(request_id, -32601, "Method not found"))
            continue
        write_json(outgoing, {"jsonrpc": "2.0", "id": request_id, "result": result})


def main() -> int:
    parser = argparse.ArgumentParser(
        description="查询迈博业务、模拟排期、提交待确认提案，或启动本地 MCP 接口。"
    )
    commands = parser.add_subparsers(dest="command", required=True)
    for name, tool in TOOLS.items():
        command = commands.add_parser(name, help=tool.description)
        for key, field in tool.fields.items():
            if key in tool.path_args:
                command.add_argument(key)
            elif field.get("type") == "boolean":
                command.add_argument(
                    f"--{key.replace('_', '-')}",
                    action=argparse.BooleanOptionalAction,
                    required=key in tool.required,
                )
            else:
                kind = field.get("type")
                parser_type = (
                    int
                    if kind == "integer"
                    else json.loads
                    if kind in {"object", "array"} or "oneOf" in field
                    else str
                )
                command.add_argument(
                    f"--{key.replace('_', '-')}",
                    type=parser_type,
                    required=key in tool.required,
                )
    commands.add_parser("mcp", help="启动 MCP stdio 工具服务。")
    args = vars(parser.parse_args())
    command = args.pop("command")

    try:
        client = Client(os.environ.get(BASE_URL_ENV, ""), os.environ.get(TOKEN_ENV, ""))
        if command == "mcp":
            serve_mcp(client, sys.stdin.buffer, sys.stdout.buffer)
        else:
            payload = client.call(
                TOOLS[command],
                {key: value for key, value in args.items() if value is not None},
            )
            write_json(sys.stdout.buffer, payload)
        return 0
    except AgentError as exc:
        write_json(sys.stderr.buffer, exc.as_json())
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
