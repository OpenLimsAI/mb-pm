"""Content-free diagnostics for authenticated assistant attempts and their upstream calls."""

import json
import logging
import re
import sys
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import UTC, datetime
from time import monotonic
from uuid import UUID, uuid4

from fastapi import HTTPException

LOGGER = logging.getLogger("cmc-pms.assistant")
LOGGER.setLevel(logging.INFO)
LOGGER.propagate = False
if not LOGGER.handlers:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter("%(message)s"))
    LOGGER.addHandler(handler)

CURRENT = ContextVar("assistant_diagnostic", default=None)
ERROR_HEADER = "X-Assistant-Error-Code"
ID_HEADER = "X-Assistant-Diagnostic-ID"
PUBLIC_ERRORS = {
    "web_not_configured": (503, "联网搜索尚未配置，请联系管理员配置后使用。问题已保留。"),
    "web_balance": (402, "联网搜索账户余额不足，请为当前搜索账户充值后重试。问题已保留。"),
    "web_invalid_query": (422, "请输入有效的搜索问题，问题不能为空。"),
    "web_timeout": (503, "联网搜索超时，问题已保留。请稍后重试。"),
    "web_auth": (503, "联网搜索密钥或权限不可用，请联系管理员检查搜索设置。"),
    "web_rate_limit": (503, "联网搜索请求过多，请稍后重试。"),
    "web_unavailable": (503, "联网搜索服务暂时不可用，问题已保留。请稍后重试。"),
    "web_invalid_response": (503, "联网搜索返回的资料无法读取，请稍后重试。"),
    "web_no_results": (422, "本次联网检索未找到可引用的公开资料。请调整关键词后重试。"),
    "model_timeout": (503, "模型等待超时，问题已保留。请稍后重试或分批提问。"),
    "output_limit": (422, "回答达到模型输出上限，问题已保留。请分批整理。"),
    "response_too_large": (422, "模型回复超过接收容量，问题已保留。请缩小本轮范围。"),
    "model_network": (503, "连接模型服务失败，问题已保留。请稍后重试。"),
    "model_auth": (503, "模型密钥或访问权限不可用，请检查所选模型设置。"),
    "model_rate_limit": (503, "模型服务限流或额度不足，问题已保留。请稍后重试或检查额度。"),
    "model_rejected": (503, "模型服务拒绝了请求，问题已保留。请检查所选模型设置。"),
    "model_invalid_response": (503, "模型返回的格式无法读取，问题已保留。请重试或切换模型。"),
    "model_empty_response": (503, "模型未返回回答正文，问题已保留。请重试或切换模型。"),
    "model_error": (503, "AI 回答未完成，问题已保留。请提供诊断编号以便排查。"),
}
FINISH_REASONS = {"stop", "length", "tool_calls", "function_call", "content_filter", "unload"}
PROVIDERS = {"deepseek", "minimax", "ollama", "openai", "custom"}
TOOLS = {
    "web_search",
    "dikw_health",
    "retrieve_knowledge",
    "list_pages",
    "read_page",
    "page_links",
    "list_wisdom",
}


def error_code(exc):
    code = getattr(exc, "code", None)
    if code in PUBLIC_ERRORS:
        return code
    if isinstance(exc, TimeoutError):
        return "model_timeout"
    if isinstance(exc, OSError):
        return "model_network"
    if isinstance(exc, ValueError | KeyError | TypeError):
        return "model_invalid_response"
    return "model_error"


def model_http_error(exc):
    code = error_code(exc)
    status, message = PUBLIC_ERRORS[code]
    return HTTPException(status, message, headers={ERROR_HEADER: code})


def upstream_code(status):
    return (
        "model_auth"
        if status in (401, 403)
        else "model_rate_limit"
        if status == 429
        else "model_rejected"
    )


def number(value):
    return value if type(value) is int and 0 <= value <= 1_000_000_000 else None


class Attempt:
    def __init__(self, request_id):
        self.id = uuid4().hex
        self.request_id = str(UUID(str(request_id)))
        self.started = monotonic()
        self.stage = "validation"
        self.model_rounds = 0
        self.tool_calls = 0
        self.model = {}
        self.upstream_status = None

    def emit(self, event, **fields):
        # All callers supply allowlisted metadata; never pass exception text, cfg, bodies or claims.
        record = {
            "timestamp": datetime.now(UTC).isoformat(),
            "event": event,
            "diagnostic_id": self.id,
            "request_id": self.request_id,
            "stage": self.stage,
            "elapsed_ms": round((monotonic() - self.started) * 1000),
            **self.model,
            **fields,
        }
        LOGGER.info(json.dumps(record, ensure_ascii=False, separators=(",", ":")))


def stage(name):
    trace = CURRENT.get()
    if trace:
        trace.stage = name
        trace.emit("stage_started")


def configure_model(provider, cfg):
    trace = CURRENT.get()
    if not trace:
        return
    selected = cfg.get("provider", provider)
    model = cfg.get("model", "")
    # User-defined names are untrusted. Only log bounded names, never URLs, labels or key values.
    if (
        not isinstance(model, str)
        or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:/-]{0,99}", model)
        or "://" in model
        or model.lower().startswith(("sk-", "bearer"))
        or (cfg.get("api_key") and cfg["api_key"] in model)
    ):
        model = "custom-model"
    trace.model = {"provider": selected if selected in PROVIDERS else "custom", "model": model}


def _http_code(exc):
    supplied = (exc.headers or {}).get(ERROR_HEADER)
    if supplied in PUBLIC_ERRORS or supplied in {"query_timeout", "query_limit"}:
        return supplied
    return {
        403: "permission_denied",
        404: "not_found",
        409: "task_conflict",
        422: "invalid_request",
        502: "dependency_failed",
        503: "dependency_unavailable",
        504: "dependency_timeout",
    }.get(exc.status_code, "request_failed")


@contextmanager
def request_scope(request_id):
    trace = Attempt(request_id)
    token = CURRENT.set(trace)
    trace.emit("request_started")
    try:
        yield trace
    except HTTPException as exc:
        # 502/504 can be replaced by an edge proxy, losing the diagnostic response.
        # These are handled dependency failures; preserve their category and original status.
        status = 503 if exc.status_code in (502, 504) else exc.status_code
        trace.emit(
            "request_failed",
            code=_http_code(exc),
            status=status,
            dependency_status=exc.status_code if status != exc.status_code else None,
            model_rounds=trace.model_rounds,
            tool_calls=trace.tool_calls,
        )
        detail = exc.detail if isinstance(exc.detail, str) else "请求未完成，问题已保留。"
        raise HTTPException(
            status,
            f"{detail}（诊断编号：{trace.id}）",
            headers={**(exc.headers or {}), ID_HEADER: trace.id},
        ) from None
    except Exception:
        # Raw exceptions may contain tokens/URLs/data. Record only a fixed failure category.
        trace.emit(
            "request_failed",
            code="unexpected_error",
            status=500,
            model_rounds=trace.model_rounds,
            tool_calls=trace.tool_calls,
        )
        raise HTTPException(
            500,
            f"系统处理失败，问题已保留。请提供诊断编号以便排查。（诊断编号：{trace.id}）",
            headers={ID_HEADER: trace.id},
        ) from None
    else:
        trace.emit(
            "request_completed",
            status=200,
            model_rounds=trace.model_rounds,
            tool_calls=trace.tool_calls,
        )
    finally:
        CURRENT.reset(token)


def model_call(request_fn, provider, cfg, path, body, *, timeout):
    trace = CURRENT.get()
    if not trace:
        return request_fn(provider, cfg, path, body, timeout=timeout)
    trace.model_rounds += 1
    trace.upstream_status = None
    trace.stage = "model"
    started = monotonic()
    budget = body.get(
        "max_completion_tokens", body.get("max_tokens", body.get("options", {}).get("num_predict"))
    )
    trace.emit(
        "model_started",
        round=trace.model_rounds,
        timeout_seconds=timeout,
        output_budget=number(budget),
    )
    try:
        result = request_fn(provider, cfg, path, body, timeout=timeout)
    except Exception as exc:
        trace.emit(
            "model_failed",
            round=trace.model_rounds,
            duration_ms=round((monotonic() - started) * 1000),
            code=error_code(exc),
            upstream_status=number(getattr(exc, "upstream_status", None)) or trace.upstream_status,
        )
        raise
    finish = None
    usage = {}
    if isinstance(result, dict):
        choices = result.get("choices")
        if isinstance(choices, list) and choices and isinstance(choices[0], dict):
            finish = choices[0].get("finish_reason")
        else:
            finish = result.get("done_reason")
        usage = result.get("usage")
        usage = usage if isinstance(usage, dict) else {}
        if provider == "ollama":
            usage = {
                "prompt_tokens": result.get("prompt_eval_count"),
                "completion_tokens": result.get("eval_count"),
            }
    details = usage.get("completion_tokens_details")
    trace.emit(
        "model_completed",
        upstream_status=trace.upstream_status,
        round=trace.model_rounds,
        duration_ms=round((monotonic() - started) * 1000),
        finish_reason=(
            finish
            if isinstance(finish, str) and finish in FINISH_REASONS
            else None
            if finish is None
            else "other"
        ),
        prompt_tokens=number(usage.get("prompt_tokens")),
        completion_tokens=number(usage.get("completion_tokens")),
        reasoning_tokens=number(details.get("reasoning_tokens"))
        if isinstance(details, dict)
        else None,
    )
    return result


def transport_status(status):
    trace = CURRENT.get()
    if trace and type(status) is int and 100 <= status <= 599:
        trace.upstream_status = status


@contextmanager
def tool_call(name):
    trace = CURRENT.get()
    if not trace:
        yield
        return
    trace.stage = "web_search" if name == "web_search" else "knowledge_tool"
    trace.tool_calls += 1
    tool = name if name in TOOLS else "unknown"
    started = monotonic()
    trace.emit("tool_started", tool=tool)
    try:
        yield
    except HTTPException as exc:
        trace.emit(
            "tool_failed",
            tool=tool,
            status=exc.status_code,
            duration_ms=round((monotonic() - started) * 1000),
        )
        raise
    except Exception:
        trace.emit(
            "tool_failed",
            tool=tool,
            code="tool_error",
            duration_ms=round((monotonic() - started) * 1000),
        )
        raise
    else:
        trace.emit("tool_completed", tool=tool, duration_ms=round((monotonic() - started) * 1000))
