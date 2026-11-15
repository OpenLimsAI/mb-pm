"""Bounded project-only structured generation; never persists model text or reasoning."""

import copy
import math
import time

from fastapi import HTTPException

from app.services import ai
from app.services.assistant_generation_policy import official_deepseek, official_kimi

TOTAL_SECONDS = 240
COUNTERS = ("prompt_tokens", "completion_tokens", "total_tokens")
RECOVERABLE = {"output_limit", "model_empty_response", "model_output_format"}
SAFE_ERRORS = RECOVERABLE | {
    "model_error",
    "model_network",
    "model_timeout",
    "model_auth",
    "model_rate_limit",
    "model_rejected",
    "model_invalid_response",
    "response_too_large",
    "context_budget",
    "generation_deadline",
    "generation_cancelled",
    "authorization_changed",
    "model_configuration",
}
COMPACT = """
本轮交付应简洁完整：summary 控制在600字内，findings优先归并为最多8条，每条detail控制在350字内。
不要逐条复述全部任务、证据原文或重复列同一事实；保留关键日期、数据缺口和真实证据引用。
必须输出完整JSON对象及summary、findings、draft_actions三个顶层字段，无内容的数组写[]。
会议中的每一项明确更新仍须逐项生成草稿，不能为精简丢失更新字段或只写摘要。
draft_actions仍最多12条；若明确更新超过单次上限，不假称完整，明确说明需要拆批核对及尚未覆盖的事项。
"""
RECOVERY = """
上次未能交付完整结构，本轮是唯一一次自动恢复。基于同一完整授权资料重新生成一个独立、完整JSON对象。
不要续写、拼接或解释上一次输出；不要引用上一次输出作为证据。摘要与结论进一步精简，保留真实来源和明确数据缺口。
会议中的明确更新及同一任务的全部更新字段仍须保留，不能为了精简清空操作草稿。
"""


def number(value):
    return type(value) in {int, float} and math.isfinite(value) and value >= 0


def counters(value):
    if not isinstance(value, dict):
        return {}
    return {key: value[key] for key in COUNTERS if number(value.get(key))}


def safe_generation(value):
    if not isinstance(value, dict) or value.get("version") != 1:
        return None
    attempts = value.get("attempts")
    if not isinstance(attempts, list) or len(attempts) > 2:
        return None
    safe = []
    for index, item in enumerate(attempts):
        if not isinstance(item, dict) or item.get("number") != index + 1:
            return None
        budget, duration = item.get("output_budget"), item.get("duration_ms")
        if type(budget) is not int or not 1 <= budget <= 131072 or not number(duration):
            return None
        usage = counters(item.get("usage"))
        reasoning = (
            item.get("usage", {}).get("reasoning_tokens")
            if isinstance(item.get("usage"), dict)
            else None
        )
        if number(reasoning):
            usage["reasoning_tokens"] = reasoning
        finish, code = item.get("finish_reason"), item.get("error_code")
        safe.append(
            {
                "number": index + 1,
                "output_budget": budget,
                "duration_ms": duration,
                "usage": usage,
                "finish_reason": finish
                if isinstance(finish, str)
                and finish in {"stop", "length", "tool_calls", "content_filter", "eos", "eos_token"}
                else None,
                "error_code": code if isinstance(code, str) and code in SAFE_ERRORS else None,
            }
        )
    code = value.get("error_code")
    return {
        "version": 1,
        "attempts": safe,
        "recovery_attempted": value.get("recovery_attempted") is True,
        "recovered": value.get("recovered") is True and len(safe) == 2,
        "error_code": code if isinstance(code, str) and code in SAFE_ERRORS else None,
    }


def safe_usage(value):
    usage = counters(value)
    metadata = safe_generation(value.get("_generation")) if isinstance(value, dict) else None
    if metadata is not None:
        usage["_generation"] = metadata
    return usage


def error_code(exc):
    if isinstance(exc, HTTPException):
        return "authorization_changed"
    code = getattr(exc, "code", None)
    return code if isinstance(code, str) and code in SAFE_ERRORS else "model_error"


def tune(provider, config, body, scenario, recovering):
    """Tune this PM call only; vendor switches require a recognized official endpoint."""
    body = copy.deepcopy(body)
    budget = 16384 if recovering or scenario == "explain" else 8192
    if provider == "ollama":
        # Reserve from UTF-8 bytes so Chinese and emoji cannot hide input capacity.
        size = sum(len(message.get("content", "").encode("utf-8")) for message in body["messages"])
        required = ((size + budget + 8191) // 8192) * 8192
        if required > 131072:
            raise ai.AIError(
                "分析资料与输出空间超过本地模型容量，请分批整理", code="context_budget"
            )
        body["options"] = {
            **body.get("options", {}),
            "temperature": 0,
            "num_predict": budget,
            "num_ctx": max(8192, required),
        }
    elif provider == "kimi" and official_kimi(config):
        body.pop("max_tokens", None)
        body["max_completion_tokens"] = 16384
        body["reasoning_effort"] = "low"
        budget = 16384
    else:
        # Existing compatible Kimi calls may use max_completion_tokens. Preserve its
        # wire contract, but never send new vendor switches to an unknown endpoint.
        key = "max_completion_tokens" if "max_completion_tokens" in body else "max_tokens"
        body[key] = budget
        if official_deepseek(config) and provider in {"deepseek", "custom"}:
            body["response_format"] = {"type": "json_object"}
            if scenario == "explain" and not recovering:
                body["thinking"] = {"type": "enabled"}
                body["reasoning_effort"] = "low"
            else:
                body.pop("reasoning_effort", None)
                body["thinking"] = {"type": "disabled"}
    return body, budget


def observed_usage(provider, result):
    if provider == "ollama":
        raw = {
            "prompt_tokens": result.get("prompt_eval_count"),
            "completion_tokens": result.get("eval_count"),
        }
    else:
        raw = result.get("usage")
        raw = raw if isinstance(raw, dict) else {}
    usage = counters(raw)
    details = raw.get("completion_tokens_details")
    if isinstance(details, dict) and number(details.get("reasoning_tokens")):
        usage["reasoning_tokens"] = details["reasoning_tokens"]
    return usage


def totals(attempts):
    # A sum is only known when every call reported that counter. Missing is not zero.
    return {
        key: sum(item["usage"][key] for item in attempts)
        for key in COUNTERS
        if attempts and all(key in item["usage"] for item in attempts)
    }


def generate(
    provider,
    config,
    messages,
    scenario,
    schema,
    validate,
    *,
    before_attempt=None,
    on_progress=None,
    max_attempts=2,
    total_seconds=TOTAL_SECONDS,
):
    deadline = time.monotonic() + min(TOTAL_SECONDS, total_seconds)
    metadata = {
        "version": 1,
        "attempts": [],
        "recovery_attempted": False,
        "recovered": False,
        "error_code": None,
    }

    def publish():
        if on_progress:
            on_progress(copy.deepcopy(metadata), totals(metadata["attempts"]))

    def remaining():
        value = deadline - time.monotonic()
        if value <= 0:
            raise ai.AIError("本轮整理已达到总等待时限，请稍后重试", code="generation_deadline")
        return value

    try:
        if not config.get("model"):
            raise ai.AIError("请先填写或选择模型名称", code="model_configuration")
        for index in range(min(2, max_attempts)):
            remaining()
            if before_attempt:
                before_attempt()
            timeout = min(120, remaining())
            recovering = bool(index)
            attempt_messages = copy.deepcopy(messages)
            attempt_messages[0]["content"] += COMPACT + (RECOVERY if recovering else "")
            attempt = {
                "number": index + 1,
                "output_budget": 16384 if recovering or scenario == "explain" else 8192,
                "finish_reason": None,
                "error_code": None,
                "usage": {},
                "duration_ms": 0,
            }
            metadata["attempts"].append(attempt)
            metadata["recovery_attempted"] = recovering
            started = time.monotonic()
            observed = False

            def request_model(
                p, cfg, path, body=None, timeout=25, *, _attempt=attempt, _recovering=recovering
            ):
                nonlocal observed
                body, _attempt["output_budget"] = tune(p, cfg, body, scenario, _recovering)
                if p == "ollama":
                    body["format"] = schema
                publish()
                result = ai.request(p, cfg, path, body, min(timeout, remaining()))
                observed = True
                _attempt["usage"] = observed_usage(p, result)
                choices = result.get("choices")
                finish = (
                    choices[0].get("finish_reason")
                    if isinstance(choices, list) and choices and isinstance(choices[0], dict)
                    else result.get("done_reason")
                )
                _attempt["finish_reason"] = (
                    finish
                    if isinstance(finish, str)
                    and finish
                    in {"stop", "length", "tool_calls", "content_filter", "eos", "eos_token"}
                    else None
                )
                if finish in ("content_filter", "tool_calls"):
                    raise ai.AIError("模型未交付可用的完整分析", code="model_rejected")
                return result

            try:
                content, usage = ai.chat(
                    provider, config, attempt_messages, timeout=timeout, request_fn=request_model
                )
                remaining()
                if not observed:
                    attempt["usage"] = counters(usage)
                validate(content)
                remaining()
                attempt["duration_ms"] = max(0, round((time.monotonic() - started) * 1000))
                metadata["recovered"] = recovering
                metadata["error_code"] = None
                publish()
                return content, {**totals(metadata["attempts"]), "_generation": metadata}
            except Exception as exc:
                attempt["duration_ms"] = max(0, round((time.monotonic() - started) * 1000))
                attempt["error_code"] = error_code(exc)
                metadata["error_code"] = attempt["error_code"]
                if not observed and attempt["error_code"] in {
                    "context_budget",
                    "model_configuration",
                }:
                    metadata["attempts"].pop()
                publish()
                if recovering or attempt["error_code"] not in RECOVERABLE:
                    raise
    except Exception as exc:
        metadata["error_code"] = error_code(exc)
        exc.pm_generation = copy.deepcopy(metadata)
        exc.pm_usage = totals(metadata["attempts"])
        raise
