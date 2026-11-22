"""Private report model settings and a pinned, non-redirecting compatible transport."""

import http.client
import ipaddress
import json
import re
import socket
import ssl
import time
from urllib.parse import urlsplit

from cryptography.fernet import InvalidToken
from fastapi import HTTPException

from app.core.security import unseal
from app.models.solution_ai import SolutionAISettings
from app.schemas.model_network import internal_approved
from app.schemas.solution_ai import ModelSettingsInput, allowed_address, model_url
from app.services import assistant_diagnostics as diagnostics

CONFIG_ERROR = "个人模型配置暂不可读取，请联系管理员检查加密配置"
CONFLICT = "模型配置已有新修改，请重新加载后编辑；未覆盖已保存设置"


class AIError(Exception):
    def __init__(self, message, *, code="model_error", upstream_status=None):
        super().__init__(message)
        self.code = code
        self.upstream_status = upstream_status


class NetworkError(AIError):
    def __init__(self, message, *, code="model_network"):
        super().__init__(message, code=code)


def _load_personal(db, claims):
    row = db.get(SolutionAISettings, (claims["iss"], claims["sub"]))
    if row is None:
        return None, {"profiles": [], "default_profile_id": None}
    try:
        data = unseal(row.encrypted_payload)
        # Validate decrypted records too; malformed storage never produces a key-bearing
        # traceback or bypasses endpoint validation during the next request.
        checked = ModelSettingsInput.model_validate({**data, "revision": row.revision})
        return row, {
            "profiles": [_resolve(profile, []) for profile in checked.profiles],
            "default_profile_id": checked.default_profile_id,
        }
    except (InvalidToken, ValueError, TypeError, HTTPException):
        raise HTTPException(503, CONFIG_ERROR) from None


def _public(data, revision):
    return {
        "profiles": [
            {
                **{
                    field: profile[field]
                    for field in ("id", "name", "provider", "base_url", "model")
                },
                "key_set": bool(profile.get("api_key")),
            }
            for profile in data["profiles"]
        ],
        "default_profile_id": data["default_profile_id"],
        "revision": revision,
    }


def _load(db, claims):
    from app.services import organization_ai

    return organization_ai.load(db, claims)


def settings(db, claims):
    from app.services import organization_ai

    row, data = _load(db, claims)
    return organization_ai.public(data, row.revision if row else 0)


def _resolve(draft, old_profiles):
    old = next((p for p in old_profiles if p["id"] == draft.id), None)
    value = draft.model_dump(exclude={"api_key", "clear_key"})
    entered = draft.api_key.get_secret_value() if draft.api_key is not None else ""
    unchanged_endpoint = (
        old and old["provider"] == draft.provider and old["base_url"] == draft.base_url
    )
    value["api_key"] = (
        "" if draft.clear_key else entered or (old.get("api_key", "") if unchanged_endpoint else "")
    )
    return value


def save_settings(db, claims, draft):
    from app.services import organization_ai

    return organization_ai.save(db, claims, draft)


def is_configured(profile):
    return bool(profile.get("model")) and (
        profile["provider"] in {"custom", "ollama"} or bool(profile.get("api_key"))
    )


def _ready(profile):
    if not is_configured(profile):
        raise HTTPException(422, "所选模型尚未填写密钥，请先完善该模型配置")
    return profile


def select_model(db, claims, profile_id):
    """Shared IDs never collide with the preserved private IDs on existing tasks."""
    from app.services import organization_ai

    if profile_id == "retrieval":
        return {"kind": "retrieval"}
    _, shared = _load(db, claims)
    if profile_id is None or profile_id == "system":
        selected = shared["default_profile_id"]
    elif profile_id.startswith(organization_ai.PREFIX):
        selected = organization_ai.raw_id(profile_id)
    else:
        # Existing task references retain their caller's private profile only.
        _, personal = _load_personal(db, claims)
        profile = next((p for p in personal["profiles"] if p["id"] == profile_id), None)
        if profile is None:
            raise HTTPException(404, "历史个人模型不存在或不属于当前账号")
        return {"kind": "private", "config": _ready(profile)}
    profile = next((p for p in shared["profiles"] if p["id"] == selected), None)
    if profile_id is None and (profile is None or not is_configured(profile)):
        # Automatic report mode may still return retrieval-only evidence; it must
        # not silently select a different configured provider.
        return {"kind": "retrieval"}
    if profile is None:
        raise HTTPException(422, "尚未选择共享默认模型，请先在 AI 设置中选择模型")
    return {
        "kind": "private",
        "config": {**_ready(profile), "_scope": "organization"},
        "scope": "organization",
    }


def resolved_addresses(host, port, *, allow_private=False):
    try:
        try:
            candidates = [str(ipaddress.ip_address(host))]
        except ValueError:
            candidates = list(
                dict.fromkeys(
                    item[4][0] for item in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
                )
            )
        if not candidates or any(
            not allowed_address(address)
            or (not allow_private and not ipaddress.ip_address(address).is_global)
            for address in candidates
        ):
            raise AIError("模型地址解析到禁止访问的网络地址", code="model_network")
        return candidates
    except (socket.gaierror, ValueError):
        raise AIError("模型地址无法解析，请检查地址与网络", code="model_network") from None


class PinnedHTTPConnection(http.client.HTTPConnection):
    def __init__(self, host, port, address, *, timeout):
        super().__init__(host, port, timeout=timeout)
        self.address = address

    def connect(self):
        self.sock = socket.create_connection((self.address, self.port), self.timeout)


class PinnedHTTPSConnection(PinnedHTTPConnection):
    def connect(self):
        super().connect()
        try:
            # Verify against the original hostname, never against the pinned DNS address.
            self.sock = ssl.create_default_context().wrap_socket(
                self.sock, server_hostname=self.host
            )
        except Exception:
            self.close()
            raise


def pinned_request(provider, cfg, path, body=None, timeout=60):
    del provider  # All private profiles use the same compatible HTTP protocol.
    connection = None
    try:
        endpoint = model_url(cfg["base_url"])
        parts = urlsplit(endpoint)
        port = parts.port or (443 if parts.scheme == "https" else 80)
        addresses = resolved_addresses(
            parts.hostname, port, allow_private=internal_approved(endpoint)
        )
        connection_type = PinnedHTTPSConnection if parts.scheme == "https" else PinnedHTTPConnection
        deadline = time.monotonic() + timeout
        connection = connection_type(parts.hostname, port, addresses[0], timeout=timeout)
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if cfg.get("api_key"):
            headers["Authorization"] = "Bearer " + cfg["api_key"]
        # HTTPConnection creates Host from the original host; no proxy or redirect is used.
        connection.request(
            "POST" if body is not None else "GET",
            parts.path.rstrip("/") + path,
            json.dumps(body).encode() if body is not None else None,
            headers,
        )
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError()
        connection.sock.settimeout(remaining)
        response = connection.getresponse()
        diagnostics.transport_status(response.status)
        if response.status < 200 or response.status >= 300:
            raise AIError(
                "模型服务拒绝请求，请核对地址、模型、密钥与账户状态",
                code=diagnostics.upstream_code(response.status),
                upstream_status=response.status,
            )
        chunks, length = [], 0
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError()
            if connection.sock:
                connection.sock.settimeout(remaining)
            chunk = response.read1(min(65536, 2_000_001 - length))
            if not chunk:
                break
            chunks.append(chunk)
            length += len(chunk)
            if length > 2_000_000:
                raise AIError("模型回复过长，请缩小问题范围", code="response_too_large")
        result = json.loads(b"".join(chunks))
        if not isinstance(result, dict):
            raise AIError("模型服务未返回有效的对话结果", code="model_invalid_response")
        base = result.get("base_resp") or {}
        if (
            result.get("error")
            or not isinstance(base, dict)
            or base.get("status_code") not in (None, 0)
        ):
            raise AIError("模型服务拒绝请求，请检查个人模型设置", code="model_rejected")
        return result
    except AIError:
        raise
    except TimeoutError:
        raise AIError(
            "模型连接失败或响应无效，请检查个人模型地址与网络", code="model_timeout"
        ) from None
    except (OSError, http.client.HTTPException):
        raise AIError(
            "模型连接失败或响应无效，请检查个人模型地址与网络", code="model_network"
        ) from None
    except (ValueError, TypeError):
        raise AIError(
            "模型连接失败或响应无效，请检查个人模型地址与网络", code="model_invalid_response"
        ) from None
    finally:
        if connection is not None:
            connection.close()


def kimi_parameters(provider: str, cfg: dict, body: dict, *, probe=False, kind=None) -> None:
    """Preserve shared-call defaults; lower effort only for probes/explicit general use."""
    if provider != "kimi" and cfg.get("provider") != "kimi":
        return
    for key in ("temperature", "top_p", "presence_penalty", "frequency_penalty"):
        body.pop(key, None)
    limit = 4096 if probe else 16384
    if cfg["model"].startswith("kimi-k3"):
        body.pop("max_tokens", None)
        body["max_completion_tokens"] = limit
        body["reasoning_effort"] = "low" if probe or kind == "general" else "high"
    else:
        body["max_tokens"] = limit


def _chat_transport(
    provider: str, cfg: dict, messages: list, *, probe=False, timeout=None, request_fn
):
    if not cfg["model"]:
        raise AIError("请先填写或选择模型名称")
    body = {"model": cfg["model"], "messages": messages, "stream": False}
    if provider == "ollama":
        size = sum(len(m["content"]) for m in messages)
        body.update(
            options={
                "temperature": 0.3,
                "num_ctx": min(131072, max(8192, ((size + 8191 + 4096) // 8192) * 8192)),
                "num_predict": 64 if probe else 4096,
            }
        )
        result = diagnostics.model_call(
            request_fn,
            provider,
            cfg,
            "/api/chat",
            body,
            timeout=timeout if timeout is not None else (120 if probe else 300),
        )
        message = result.get("message") or {}
        content = message.get("content", "") if isinstance(message, dict) else ""
        if not probe and result.get("done_reason") == "length":
            raise AIError(
                "本地模型输出被截断，请减少分析要求或选择更合适的模型", code="output_limit"
            )
        usage = {
            "prompt_tokens": result.get("prompt_eval_count", 0),
            "completion_tokens": result.get("eval_count", 0),
        }
    else:
        if provider == "minimax":
            body.update(temperature=1.0, max_tokens=8192)
        kimi_parameters(provider, cfg, body, probe=probe)
        result = diagnostics.model_call(
            request_fn,
            provider,
            cfg,
            "/chat/completions",
            body,
            timeout=timeout if timeout is not None else 120,
        )
        choices = result.get("choices")
        if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
            raise AIError(
                "模型没有返回有效回答，请检查模型是否支持对话", code="model_invalid_response"
            )
        message = choices[0].get("message") or {}
        content = message.get("content", "") if isinstance(message, dict) else ""
        usage = result.get("usage") or {}
        if not isinstance(usage, dict):
            usage = {}
        if choices[0].get("finish_reason") == "length":
            raise AIError(
                "模型输出被截断，请减少分析要求或选择输出容量更大的模型", code="output_limit"
            )
    if not isinstance(content, str):
        raise AIError("模型返回的回答格式不正确", code="model_invalid_response")
    content = re.sub(r"<think>.*?</think>", "", content, flags=re.S).strip()
    if not content:
        raise AIError("模型没有返回正文，请重试或切换模型", code="model_empty_response")
    return content, usage


_chat_dispatcher = _chat_transport


def register_chat_dispatcher(fn) -> None:
    global _chat_dispatcher
    _chat_dispatcher = fn


def transport_provider(profile):
    return (
        profile["provider"]
        if profile.get("_scope") == "organization" or profile["provider"] == "ollama"
        else "custom"
    )


def chat(profile, messages, *, timeout=60):
    # Use only model/messages/stream. In particular do not inherit global vendor tuning.
    provider = transport_provider(profile)
    return _chat_dispatcher(provider, profile, messages, timeout=timeout, request_fn=pinned_request)


def test_connection(db, claims, draft):
    _, stored = _load(db, claims)
    from app.services.organization_ai import raw_id

    normalized = draft.profile.model_copy(update={"id": raw_id(draft.profile.id)})
    profile = _ready(_resolve(normalized, stored["profiles"]))
    start = time.monotonic()
    try:
        chat(profile, [{"role": "user", "content": "连接测试。请只回复：连接成功。"}], timeout=25)
    except (AIError, OSError, ValueError, KeyError, TypeError):
        raise HTTPException(503, "连接测试失败，请核对个人模型地址、名称、密钥和服务状态") from None
    return {"ok": True, "model": profile["model"], "ms": round((time.monotonic() - start) * 1000)}
