#!/usr/bin/env python3
"""Maibo's read-only business API client and local MCP stdio server."""

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
PAGING = {
    "page": {"type": "integer", "minimum": 1, "maximum": 10_000, "default": 1},
    "page_size": {"type": "integer", "minimum": 1, "maximum": 50, "default": 20},
}


@dataclass(frozen=True)
class Tool:
    description: str
    path: str
    fields: dict
    path_arg: str | None = None

    def schema(self) -> dict:
        return {
            "type": "object",
            "properties": self.fields,
            "required": [self.path_arg] if self.path_arg else [],
            "additionalProperties": False,
        }

    def endpoint(self, arguments: dict) -> str:
        if not isinstance(arguments, dict) or arguments.keys() - self.fields.keys():
            raise AgentError("invalid_arguments", "请提供工具声明的参数。")
        query = {}
        path = self.path
        for key, value in arguments.items():
            schema = self.fields[key]
            valid = False
            if schema["type"] == "integer":
                valid = type(value) is int and schema["minimum"] <= value <= schema["maximum"]
            elif schema["type"] == "boolean":
                valid = type(value) is bool
            elif isinstance(value, str):
                valid = schema["minLength"] <= len(value) <= schema["maxLength"] and not re.search(
                    r"[\x00-\x1f\x7f\ud800-\udfff]", value
                )
            if not valid:
                raise AgentError("invalid_arguments", f"参数 {key} 不符合工具声明。")
            if key == self.path_arg:
                if value in {".", ".."} or any(ch in value for ch in "/\\%"):
                    raise AgentError("invalid_arguments", f"参数 {key} 不能包含路径分隔符。")
                path = path.replace("{" + key + "}", quote(value, safe=""))
            else:
                query[key] = str(value).lower() if type(value) is bool else value
        if self.path_arg is not None and self.path_arg not in arguments:
            raise AgentError("invalid_arguments", f"缺少参数 {self.path_arg}。")
        return API_ROOT + path + ("?" + urlencode(query) if query else "")


TOOLS = {
    "projects": Tool("分页列出当前用户可见的项目。", "/projects", PAGING),
    "tasks": Tool(
        "分页列出当前用户可见的任务，可按项目和逾期状态筛选。",
        "/tasks",
        {
            "project_id": ID,
            "overdue": {"type": "boolean", "description": "为 true 时仅返回逾期任务。"},
            **PAGING,
        },
    ),
    "task": Tool("读取一项可见任务的详细信息。", "/tasks/{task_id}", {"task_id": ID}, "task_id"),
    "baseline": Tool(
        "比较当前任务计划与项目基线。省略基线编号时使用最新基线。",
        "/tasks/{task_id}/baseline",
        {"task_id": ID, "baseline_id": ID},
        "task_id",
    ),
    "risk-report": Tool(
        "生成项目逾期风险报告。返回审核链接时，可由用户在迈博中查看并保存。",
        "/projects/{project_id}/risk-report",
        {"project_id": ID},
        "project_id",
    ),
}

HTTP_ERRORS = {
    401: ("authentication_failed", "请检查委托令牌是否有效或已过期。"),
    403: ("forbidden", "当前用户无权执行该查询。"),
    404: ("not_found", "记录不存在或当前用户不可见。"),
    422: ("invalid_arguments", "查询参数无效。"),
    429: ("rate_limited", "请求过于频繁，请稍后重试。"),
    503: ("unavailable", "迈博 Agent 接口或身份服务暂不可用。"),
}


class Client:
    def __init__(self, base_url: str, token: str):
        try:
            url = urlsplit(base_url)
            self.port = url.port
        except ValueError:
            raise AgentError("configuration_error", f"{BASE_URL_ENV} 格式无效。") from None
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
        if url.scheme == "http" and url.hostname not in {"localhost", "127.0.0.1", "::1"}:
            raise AgentError("configuration_error", "远程迈博地址必须使用 HTTPS。")
        if len(token) > 32768 or not re.fullmatch(r"[A-Za-z0-9._~+/\-]+=*", token):
            raise AgentError("configuration_error", f"请在 {TOKEN_ENV} 中设置有效的用户委托令牌。")
        self.connection = (
            http.client.HTTPSConnection if url.scheme == "https" else http.client.HTTPConnection
        )
        self.host = url.hostname
        self.token = token

    def call(self, tool: Tool, arguments: dict) -> dict:
        endpoint = tool.endpoint(arguments)
        conn = self.connection(self.host, self.port, timeout=HTTP_TIMEOUT)
        try:
            # A single direct request keeps the delegated token on its configured origin.
            conn.request(
                "GET",
                endpoint,
                headers={"Authorization": f"Bearer {self.token}", "Accept": "application/json"},
            )
            with conn.getresponse() as response:
                if 300 <= response.status < 400:
                    raise AgentError(
                        "unexpected_redirect", "迈博接口返回了重定向。", response.status
                    )
                if response.status != 200:
                    code, message = HTTP_ERRORS.get(
                        response.status, ("http_error", "迈博查询失败。")
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
        json.dumps(value, ensure_ascii=False).encode("utf-8", errors="backslashreplace") + b"\n"
    )
    stream.flush()


def rpc_error(request_id, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


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
                write_json(outgoing, rpc_error(request_id, -32602, "Invalid initialize"))
                continue
            protocol = version if version in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0]
            result = {
                "protocolVersion": protocol,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "maibo-agent", "version": "1.0.0"},
            }
        elif not ready:
            write_json(outgoing, rpc_error(request_id, -32002, "Server not initialized"))
            continue
        elif method == "tools/list":
            result = {
                "tools": [
                    {
                        "name": name.replace("-", "_"),
                        "description": tool.description,
                        "inputSchema": tool.schema(),
                        "annotations": {"readOnlyHint": True, "openWorldHint": False},
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
                        {"type": "text", "text": json.dumps(exc.as_json(), ensure_ascii=False)}
                    ],
                }
            else:
                result = {
                    "content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False)}],
                    "structuredContent": payload,
                }
        else:
            write_json(outgoing, rpc_error(request_id, -32601, "Method not found"))
            continue
        write_json(outgoing, {"jsonrpc": "2.0", "id": request_id, "result": result})


def main() -> int:
    parser = argparse.ArgumentParser(
        description="查询迈博项目、任务和进度风险，或启动本地 MCP 接口。"
    )
    commands = parser.add_subparsers(dest="command", required=True)
    for name, tool in TOOLS.items():
        command = commands.add_parser(name, help=tool.description)
        for key, field in tool.fields.items():
            if key == tool.path_arg:
                command.add_argument(key)
            elif field["type"] == "boolean":
                command.add_argument(f"--{key}", action=argparse.BooleanOptionalAction)
            else:
                command.add_argument(
                    f"--{key.replace('_', '-')}", type=int if field["type"] == "integer" else str
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
                TOOLS[command], {key: value for key, value in args.items() if value is not None}
            )
            write_json(sys.stdout.buffer, payload)
        return 0
    except AgentError as exc:
        write_json(sys.stderr.buffer, exc.as_json())
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
