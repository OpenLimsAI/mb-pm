"""Execute KB model turns with the caller's existing workbench model settings.

The gateway never retrieves documents or runs tools. KB retains authorization,
document selection, tool execution and durable task ownership.
"""

import json
import time
from uuid import uuid4

from fastapi import HTTPException
from pydantic import ValidationError

from app.core.config import settings
from app.schemas.knowledge_ai import Completion, Message
from app.services import ai, solution_ai
from app.services import assistant_diagnostics as diagnostics

TIMEOUT_SECONDS = 120
FINISH_REASONS = {"stop", "length", "tool_calls", "content_filter"}


def system_config():
    try:
        current = ai.load_settings()
        provider = current["provider"]
        return provider, dict(current["providers"][provider])
    except (OSError, ValueError, KeyError, TypeError):
        raise HTTPException(503, "工作台系统模型配置暂不可读取") from None


def models(db, claims):
    # This is the same encrypted (issuer, subject) row edited by /model-settings.
    _, saved = solution_ai._load(db, claims)
    public = solution_ai.settings(db, claims)
    try:
        provider, cfg = system_config()
    except HTTPException:
        # An unavailable enterprise file must not lock users out of their own models.
        provider, cfg = "", {}
    items = [
        {
            "id": profile["id"],
            "name": profile["name"],
            "provider": profile["provider"],
            "model": profile["model"],
            "key_set": bool(profile.get("api_key")),
            "available": profile["provider"] == "custom" or bool(profile.get("api_key")),
        }
        for profile in saved["profiles"]
    ]
    items.append(
        {
            "id": "system",
            "name": "工作台系统默认",
            "provider": provider,
            "model": cfg.get("model", ""),
            "key_set": bool(cfg.get("api_key")),
            "available": bool(cfg.get("model"))
            and (provider == "ollama" or bool(cfg.get("api_key"))),
        }
    )
    return {
        "models": items,
        "default_model_id": saved["default_profile_id"] or "system",
        "revision": public["revision"],
        "settings_url": settings.portal_origin + "/model-settings",
    }


def selected(db, claims, payload):
    if payload.settings_revision is not None:
        if solution_ai.settings(db, claims)["revision"] != payload.settings_revision:
            raise HTTPException(409, "工作台模型设置已更新，请重新选择后重试")
    choice = solution_ai.select_model(db, claims, payload.model)
    if choice["kind"] == "retrieval":
        raise HTTPException(422, "请选择可生成内容的个人模型或工作台系统默认模型")
    if choice["kind"] == "private":
        return "custom", dict(choice["config"]), solution_ai.pinned_request
    provider, cfg = system_config()
    if not cfg.get("model") or (provider != "ollama" and not cfg.get("api_key")):
        raise HTTPException(422, "工作台系统默认模型尚未配置，请在 AI 设置中选择个人模型")
    # No fallback to a different provider on failure, including offline_fallback.
    return provider, cfg, ai.request


def ollama_body(body):
    """Keep the system-default Ollama option compatible without changing its store."""
    if body.get("tool_choice") not in (None, "auto", "none"):
        raise HTTPException(422, "当前系统本地模型不支持指定工具选择策略")
    calls = {}
    messages = []
    for original in body["messages"]:
        message = dict(original)
        content = message.get("content")
        if isinstance(content, list):
            message["content"] = "".join(part["text"] for part in content)
        if message["role"] == "developer":
            message["role"] = "system"
        message.pop("reasoning_content", None)
        if message.get("tool_calls"):
            translated = []
            for call in message["tool_calls"]:
                calls[call["id"]] = call["function"]["name"]
                try:
                    arguments = json.loads(call["function"]["arguments"])
                except ValueError:
                    raise HTTPException(422, "工具参数不是有效 JSON") from None
                if not isinstance(arguments, dict):
                    raise HTTPException(422, "工具参数须为 JSON 对象")
                translated.append(
                    {"function": {"name": call["function"]["name"], "arguments": arguments}}
                )
            message["tool_calls"] = translated
        if message["role"] == "tool":
            message["tool_name"] = calls[message.pop("tool_call_id")]
        messages.append(message)
    options = {"num_predict": body.get("max_tokens", body.get("max_completion_tokens", 8192))}
    for key in ("temperature", "top_p", "stop"):
        if key in body:
            options[key] = body[key]
    result = {"model": body["model"], "messages": messages, "stream": False, "options": options}
    if body.get("tools") and body.get("tool_choice") != "none":
        result["tools"] = body["tools"]
    response_format = body.get("response_format")
    if response_format and response_format["type"] != "text":
        result["format"] = (
            response_format["json_schema"].get("schema", {})
            if response_format["type"] == "json_schema"
            else "json"
        )
    return result


def ollama_result(result):
    message = dict(result.get("message") or {})
    if message.get("tool_calls"):
        message["tool_calls"] = [
            {
                "id": "call_" + uuid4().hex,
                "type": "function",
                "function": {
                    "name": call["function"]["name"],
                    "arguments": json.dumps(call["function"]["arguments"], ensure_ascii=False),
                },
            }
            for call in message["tool_calls"]
        ]
    message.setdefault("role", "assistant")
    return {
        "choices": [
            {
                "message": message,
                "finish_reason": "length"
                if result.get("done_reason") == "length"
                else "tool_calls"
                if message.get("tool_calls")
                else "stop",
            }
        ],
        "usage": {
            "prompt_tokens": result.get("prompt_eval_count"),
            "completion_tokens": result.get("eval_count"),
        },
    }


def response_data(result, cfg, payload):
    choices = result.get("choices")
    if not isinstance(choices, list) or len(choices) != 1 or not isinstance(choices[0], dict):
        raise ValueError("invalid completion")
    choice = choices[0]
    raw = choice.get("message")
    if not isinstance(raw, dict) or raw.get("role", "assistant") != "assistant":
        raise ValueError("invalid assistant turn")
    # Drop unrecognized upstream fields instead of forwarding arbitrary provider payloads.
    message = Message.model_validate(
        {
            "role": "assistant",
            **{
                key: raw[key]
                for key in ("content", "tool_calls", "reasoning_content")
                if key in raw
            },
        }
    )
    tools = {tool.function.name for tool in payload.tools or []}
    if any(call.function.name not in tools for call in message.tool_calls or []):
        raise ValueError("provider selected an undeclared tool")
    if message.tool_calls and payload.tool_choice == "none":
        raise ValueError("provider ignored disabled tools")
    reason = choice.get("finish_reason")
    if reason not in FINISH_REASONS:
        raise ValueError("missing completion finish reason")
    if (reason == "tool_calls") != bool(message.tool_calls) and reason != "length":
        raise ValueError("inconsistent tool completion")
    usage = {}
    supplied = result.get("usage")
    if isinstance(supplied, dict):
        for key in (
            "prompt_tokens",
            "completion_tokens",
            "total_tokens",
            "prompt_cache_hit_tokens",
            "prompt_cache_miss_tokens",
        ):
            value = diagnostics.number(supplied.get(key))
            if value is not None:
                usage[key] = value
        for key, fields in {
            "prompt_tokens_details": ("cached_tokens",),
            "completion_tokens_details": ("reasoning_tokens",),
        }.items():
            values = supplied.get(key)
            if isinstance(values, dict):
                detail = {field: diagnostics.number(values.get(field)) for field in fields}
                detail = {field: value for field, value in detail.items() if value is not None}
                if detail:
                    usage[key] = detail
    response = {
        "id": "chatcmpl-" + uuid4().hex,
        "object": "chat.completion",
        "created": int(time.time()),
        "model": cfg["model"],
        "choices": [
            {"index": 0, "message": message.model_dump(exclude_none=True), "finish_reason": reason}
        ],
        "usage": usage,
    }
    key = cfg.get("api_key")
    if key and key in json.dumps(response, ensure_ascii=False):
        raise ValueError("credential in provider response")
    return response


def complete(db, claims, payload: Completion):
    provider, cfg, transport = selected(db, claims, payload)
    # Do not hold a DB connection while waiting for the model. This turn uses a
    # copied snapshot; every subsequent tool/compaction turn resolves afresh.
    db.rollback()
    body = payload.model_dump(exclude={"model", "settings_revision"}, exclude_none=True)
    body["model"] = cfg["model"]
    budget = payload.max_tokens or payload.max_completion_tokens or 8192
    if "max_tokens" not in body and "max_completion_tokens" not in body:
        body["max_tokens"] = budget
    if provider == "minimax":
        body.setdefault("temperature", 1.0)
    ai.kimi_parameters(provider, cfg, body)
    if provider == "kimi" or cfg.get("provider") == "kimi":
        limit_key = "max_completion_tokens" if cfg["model"].startswith("kimi-k3") else "max_tokens"
        body[limit_key] = min(budget, 16384)
    diagnostics.configure_model(provider, cfg)
    try:
        result = diagnostics.model_call(
            transport,
            provider,
            cfg,
            "/api/chat" if provider == "ollama" else "/chat/completions",
            ollama_body(body) if provider == "ollama" else body,
            timeout=TIMEOUT_SECONDS,
        )
        return response_data(
            ollama_result(result) if provider == "ollama" else result, cfg, payload
        )
    except ai.AIError as exc:
        raise diagnostics.model_http_error(exc) from None
    except (OSError, ValueError, KeyError, TypeError, ValidationError):
        raise diagnostics.model_http_error(
            ai.AIError("模型返回格式无效", code="model_invalid_response")
        ) from None
