"""Private report model settings and a pinned, non-redirecting compatible transport."""

import http.client
import ipaddress
import json
import socket
import ssl
import time
from urllib.parse import urlsplit

from cryptography.fernet import InvalidToken
from fastapi import HTTPException
from sqlalchemy import update
from sqlalchemy.exc import IntegrityError

from app.core.security import seal, unseal
from app.models.solution_ai import SolutionAISettings
from app.schemas.model_network import internal_approved
from app.schemas.solution_ai import ModelSettingsInput, allowed_address, model_url
from app.services import ai
from app.services import assistant_diagnostics as diagnostics

CONFIG_ERROR = "个人模型配置暂不可读取，请联系管理员检查加密配置"
CONFLICT = "模型配置已有新修改，请重新加载后编辑；未覆盖已保存设置"


def _load(db, claims):
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


def settings(db, claims):
    row, data = _load(db, claims)
    return _public(data, row.revision if row else 0)


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
    row, previous = _load(db, claims)
    if draft.revision != (row.revision if row else 0):
        raise HTTPException(409, CONFLICT)
    data = {
        "profiles": [_resolve(p, previous["profiles"]) for p in draft.profiles],
        "default_profile_id": draft.default_profile_id,
    }
    try:
        encrypted = seal(data)
    except HTTPException:
        raise HTTPException(503, CONFIG_ERROR) from None
    revision = draft.revision + 1
    try:
        if row is None:
            db.add(
                SolutionAISettings(
                    issuer=claims["iss"],
                    owner_id=claims["sub"],
                    revision=revision,
                    encrypted_payload=encrypted,
                )
            )
        else:
            changed = db.execute(
                update(SolutionAISettings)
                .where(
                    SolutionAISettings.issuer == claims["iss"],
                    SolutionAISettings.owner_id == claims["sub"],
                    SolutionAISettings.revision == draft.revision,
                )
                .values(revision=revision, encrypted_payload=encrypted),
                execution_options={"synchronize_session": False},
            )
            if changed.rowcount != 1:
                db.rollback()
                raise HTTPException(409, CONFLICT)
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, CONFLICT) from None
    return _public(data, revision)


def _ready(profile):
    if profile["provider"] != "custom" and not profile.get("api_key"):
        raise HTTPException(422, "所选个人模型尚未填写密钥，请先完善该模型配置")
    return profile


def select_model(db, claims, profile_id):
    """Validate even before retrieval; an explicit missing ID never falls back."""
    if profile_id == "retrieval":
        return {"kind": "retrieval"}
    if profile_id == "system":
        return {"kind": "system"}
    _, saved = _load(db, claims)
    selected = profile_id if profile_id is not None else saved["default_profile_id"]
    if selected is None:
        return {"kind": "system"}
    profile = next((p for p in saved["profiles"] if p["id"] == selected), None)
    if profile is None:
        raise HTTPException(404, "个人模型不存在或无权使用，请重新选择")
    return {"kind": "private", "config": _ready(profile)}


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
            raise ai.AIError("模型地址解析到禁止访问的网络地址", code="model_network")
        return candidates
    except (socket.gaierror, ValueError):
        raise ai.AIError("模型地址无法解析，请检查地址与网络", code="model_network") from None


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
            raise ai.AIError(
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
                raise ai.AIError("模型回复过长，请缩小问题范围", code="response_too_large")
        result = json.loads(b"".join(chunks))
        if not isinstance(result, dict):
            raise ai.AIError("模型服务未返回有效的对话结果", code="model_invalid_response")
        base = result.get("base_resp") or {}
        if (
            result.get("error")
            or not isinstance(base, dict)
            or base.get("status_code") not in (None, 0)
        ):
            raise ai.AIError("模型服务拒绝请求，请检查个人模型设置", code="model_rejected")
        return result
    except ai.AIError:
        raise
    except TimeoutError:
        raise ai.AIError(
            "模型连接失败或响应无效，请检查个人模型地址与网络", code="model_timeout"
        ) from None
    except (OSError, http.client.HTTPException):
        raise ai.AIError(
            "模型连接失败或响应无效，请检查个人模型地址与网络", code="model_network"
        ) from None
    except (ValueError, TypeError):
        raise ai.AIError(
            "模型连接失败或响应无效，请检查个人模型地址与网络", code="model_invalid_response"
        ) from None
    finally:
        if connection is not None:
            connection.close()


def chat(profile, messages, *, timeout=60):
    # Use only model/messages/stream. In particular do not inherit global vendor tuning.
    return ai.chat("custom", profile, messages, timeout=timeout, request_fn=pinned_request)


def test_connection(db, claims, draft):
    _, stored = _load(db, claims)
    profile = _ready(_resolve(draft.profile, stored["profiles"]))
    start = time.monotonic()
    try:
        chat(profile, [{"role": "user", "content": "连接测试。请只回复：连接成功。"}], timeout=25)
    except (ai.AIError, OSError, ValueError, KeyError, TypeError):
        raise HTTPException(503, "连接测试失败，请核对个人模型地址、名称、密钥和服务状态") from None
    return {"ok": True, "model": profile["model"], "ms": round((time.monotonic() - start) * 1000)}
