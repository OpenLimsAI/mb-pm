"""Narrow authenticated transport to the private host backup agent.

Only fixed endpoints and typed bodies are forwarded. Agent diagnostics and errors are
never passed through; no command, host, filesystem path or credential reaches the browser.
"""

import hashlib
import hmac
import ipaddress
import json
import re
import time
from urllib.parse import urlsplit
from uuid import uuid4

import httpx
from fastapi import HTTPException
from pydantic import ValidationError

from app.core.config import settings
from app.schemas.data_backup import (
    DeletePreview,
    DeletePreviewInput,
    Deletion,
    DeletionInput,
    Plan,
    PlanInput,
    Snapshot,
)

MAX_RESPONSE_BYTES = 2 * 1024 * 1024
TIMEOUT_SECONDS = 12.0
OPERATIONS = {
    ("GET", "/v1/snapshot"),
    ("POST", "/v1/delete-preview"),
    ("POST", "/v1/deletions"),
    ("POST", "/v1/plan"),
}
ERRORS = {
    "plan_readonly": (409, "当前备份计划暂不可编辑，请刷新并查看计划说明"),
    "plan_changed": (409, "备份计划已变化，请重新读取后再保存"),
    "plan_write_failed": (503, "备份计划保存未确认，请刷新实际计划并联系管理员检查"),
    "archive_changed": (409, "备份文件已变化，请刷新列表后重新选择"),
    "protected": (409, "所选备份受到保护，不能删除"),
    "backup_busy": (409, "备份或发布操作正在进行，请稍后重试"),
    "selection_changed": (409, "所选备份已变化，请重新确认删除清单"),
    "expired_request": (409, "删除确认已过期，请重新选择备份"),
    "revision_conflict": (409, "备份列表已更新，请刷新后重新选择"),
    "request_conflict": (409, "此请求已用于其他删除操作，请刷新后重试"),
    "invalid_request": (422, "备份操作参数无效，请检查后重新提交"),
    "rate_limited": (429, "请求过于频繁，请稍后重试"),
    "replay": (409, "请求已使用，请刷新后重试"),
    "operation_failed": (503, "删除操作未完成，请刷新备份记录并联系管理员检查"),
}
UNKNOWN_DELETION_ERROR = "删除未全部完成，请刷新备份列表并联系管理员检查记录"


def configured_url():
    raw = settings.DATA_BACKUP_AGENT_URL
    secret = settings.DATA_BACKUP_AGENT_SECRET
    if not raw or len(secret) < 32:
        raise HTTPException(503, "数据备份服务尚未配置，请联系管理员完成服务器备份代理连接")
    try:
        parts = urlsplit(raw)
        host = parts.hostname or ""
        port = parts.port
        valid = (
            parts.scheme in {"http", "https"}
            and host
            and not parts.username
            and not parts.password
            and parts.path in {"", "/"}
            and not parts.query
            and not parts.fragment
            and not any(c.isspace() or ord(c) < 32 for c in raw)
            and "\\" not in raw
            and (port is None or 1 <= port <= 65535)
        )
        if parts.scheme == "http":
            try:
                address = ipaddress.ip_address(host)
                private = address.is_private or address.is_loopback
                private = private and not (address.is_unspecified or address.is_multicast)
            except ValueError:
                # Docker service names and explicitly local hostnames. No browser URL input.
                private = bool(re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]*", host)) or host.endswith(
                    ".internal"
                )
            valid = valid and private
        if not valid:
            raise ValueError("invalid agent URL")
    except ValueError:
        raise HTTPException(503, "数据备份服务连接配置无效，请联系管理员检查") from None
    return raw.rstrip("/"), secret


def request(method, path, payload=None):
    if (method, path) not in OPERATIONS:
        raise ValueError("Unsupported backup agent operation")
    base, secret = configured_url()
    body = (
        b""
        if payload is None
        else json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    )
    timestamp, nonce = str(int(time.time())), uuid4().hex
    canonical = "\n".join((method, path, timestamp, nonce, hashlib.sha256(body).hexdigest()))
    headers = {
        "X-Backup-Time": timestamp,
        "X-Backup-Nonce": nonce,
        "X-Backup-Signature": hmac.new(
            secret.encode("utf-8"), canonical.encode("utf-8"), hashlib.sha256
        ).hexdigest(),
        "Accept": "application/json",
        "Accept-Encoding": "identity",
        "Content-Type": "application/json",
    }
    deadline = time.monotonic() + TIMEOUT_SECONDS
    try:
        with httpx.Client(
            timeout=httpx.Timeout(TIMEOUT_SECONDS, connect=3),
            trust_env=False,
            follow_redirects=False,
        ) as client:
            with client.stream(method, base + path, content=body, headers=headers) as response:
                length = response.headers.get("content-length")
                if length is not None and (
                    not length.isdigit() or int(length) > MAX_RESPONSE_BYTES
                ):
                    raise ValueError("invalid response length")
                if response.headers.get("content-encoding", "identity").lower() != "identity":
                    raise ValueError("encoded response refused")
                data = bytearray()
                for chunk in response.iter_raw():
                    if time.monotonic() > deadline:
                        raise httpx.ReadTimeout("backup agent deadline exceeded")
                    if len(data) + len(chunk) > MAX_RESPONSE_BYTES:
                        raise ValueError("response limit exceeded")
                    data.extend(chunk)
                if time.monotonic() > deadline:
                    raise httpx.ReadTimeout("backup agent deadline exceeded")
                if 300 <= response.status_code < 400:
                    raise ValueError("redirect refused")
                if response.status_code in {401, 403}:
                    raise HTTPException(503, "服务器备份代理认证失败，请联系管理员检查连接配置")
                if response.status_code >= 500:
                    raise HTTPException(503, "服务器备份代理暂时不可用，请稍后重试")
                parsed = json.loads(data)
                if not isinstance(parsed, dict):
                    raise ValueError("invalid response")
                if response.status_code >= 400:
                    error = parsed.get("error")
                    code = error.get("code") if isinstance(error, dict) else None
                    status_code, message = ERRORS.get(
                        code, (502, "服务器未接受备份操作，请刷新状态后重试")
                    )
                    detail = {"code": code, "message": message} if code in ERRORS else message
                    raise HTTPException(status_code, detail)
                return parsed
    except httpx.TimeoutException:
        raise HTTPException(
            504, "服务器备份代理响应超时，请先刷新实际状态，避免重复提交操作"
        ) from None
    except httpx.HTTPError:
        raise HTTPException(503, "无法连接服务器备份代理，请联系管理员检查服务状态") from None
    except (ValueError, UnicodeError, TypeError):
        raise HTTPException(502, "服务器备份代理返回了无效数据，请联系管理员检查") from None


def _public(model, value):
    try:
        result = model.model_validate(value)
    except ValidationError:
        raise HTTPException(502, "服务器备份代理返回了不完整的数据，请联系管理员检查") from None
    output = result.model_dump(mode="json", by_alias=True)
    receipts = (
        output.get("deletions", []) if model is Snapshot else [output] if model is Deletion else []
    )
    for receipt in receipts:
        error = receipt.get("error")
        if error:
            receipt["error"] = ERRORS.get(error, (502, UNKNOWN_DELETION_ERROR))[1]
    return output


def snapshot():
    return _public(Snapshot, request("GET", "/v1/snapshot"))


def delete_preview(body: DeletePreviewInput, subject: str):
    output = _public(
        DeletePreview,
        request(
            "POST",
            "/v1/delete-preview",
            {**body.model_dump(mode="json", by_alias=True), "actor": subject},
        ),
    )
    items = output["items"]
    if (
        output["itemCount"] != len(items)
        or len({item["id"] for item in items}) != len(items)
        or {item["id"] for item in items} != set(body.archive_ids)
        or output["sizeBytes"] != sum(item["sizeBytes"] for item in items)
        or output["diskBytes"] != sum(item["diskBytes"] for item in items)
    ):
        raise HTTPException(502, "服务器返回的删除清单不一致，请重新读取")
    return output


def delete_archives(body: DeletionInput, subject: str):
    return _public(
        Deletion,
        request(
            "POST",
            "/v1/deletions",
            {**body.model_dump(mode="json", by_alias=True), "actor": subject},
        ),
    )


def update_plan(body: PlanInput, subject: str):
    return _public(
        Plan,
        request(
            "POST",
            "/v1/plan",
            {**body.model_dump(mode="json", by_alias=True), "actor": subject},
        ),
    )
