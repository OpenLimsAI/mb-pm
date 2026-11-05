"""Explicit server-side import of the legacy service-shared MiniMax profile."""

import hashlib
import json

from fastapi import HTTPException

from app.schemas.solution_ai import SharedModelSettingsInput
from app.services import organization_ai

CHINA_OPENAI_BASE = "https://api.minimaxi.com/v1"
CHINA_ANTHROPIC_BASE = "https://api.minimaxi.com/anthropic"


def preflight(db, claims, source, *, destination_url=None):
    organization_ai.identity(claims)
    if source.get("scope") != "service_shared" or source.get("owner") is not None:
        raise HTTPException(422, "仅迁移明确标记的原服务共享配置；个人模型不会自动公开")
    if source.get("provider") != "minimax" or source.get("base_url", "").rstrip("/") not in {
        CHINA_OPENAI_BASE,
        CHINA_ANTHROPIC_BASE,
    }:
        raise HTTPException(422, "仅支持明确标识为中国区 MiniMax 的旧共享配置")
    if not isinstance(source.get("api_key"), str) or not source["api_key"].strip():
        raise HTTPException(422, "旧共享配置没有服务器密钥，未执行迁移")
    source_url = source["base_url"].rstrip("/")
    if source_url == CHINA_ANTHROPIC_BASE and destination_url is None:
        return {
            "action": "protocol_confirmation_required",
            "can_apply": False,
            "source_protocol": "anthropic",
            "key_present": True,
            "credential_verified": False,
        }
    destination = (destination_url or source_url).rstrip("/")
    if destination != CHINA_OPENAI_BASE:
        raise HTTPException(
            422, "迁移目标必须显式保持中国区 OpenAI 兼容端点，不自动转换区域或服务商别名"
        )
    model = source.get("model", "")
    SharedModelSettingsInput.model_validate(
        {
            "profiles": [
                {
                    "id": "legacy-minimax",
                    "name": "旧知识库 MiniMax",
                    "provider": "minimax",
                    "base_url": destination,
                    "model": model,
                    "api_key": source["api_key"],
                }
            ],
            "default_profile_id": None,
            "revision": 0,
        }
    )
    basis = json.dumps(
        [source["provider"], source_url, model], ensure_ascii=False, separators=(",", ":")
    )
    identifier = "legacy-minimax-" + hashlib.sha256(basis.encode()).hexdigest()[:16]
    row, saved = organization_ai.load(db, claims)
    existing = next((p for p in saved["profiles"] if p["id"] == identifier), None)
    if existing:
        unchanged = all(
            existing.get(key) == value
            for key, value in {
                "provider": "minimax",
                "base_url": destination,
                "model": model,
                "api_key": source["api_key"].strip(),
            }.items()
        )
        action = "already_imported" if unchanged else "conflict"
    else:
        action = "append"
    return {
        "action": action,
        "can_apply": action in {"append", "already_imported"},
        "profile_id": organization_ai.public_id(identifier),
        "revision": row.revision if row else 0,
        "source_protocol": "anthropic" if source_url == CHINA_ANTHROPIC_BASE else "openai",
        "destination_protocol": "openai",
        "key_present": True,
        "credential_verified": False,
        "default_will_change": False,
        "source_will_change": False,
    }


def import_profile(db, claims, source, *, destination_url=None, expected_revision):
    result = preflight(db, claims, source, destination_url=destination_url)
    if not result["can_apply"]:
        raise HTTPException(409, "旧配置需要协议确认或与已有配置冲突，未覆盖任何共享设置")
    if result["revision"] != expected_revision:
        raise HTTPException(409, organization_ai.CONFLICT)
    if result["action"] == "already_imported":
        return result
    _, saved = organization_ai.load(db, claims)
    profiles = [dict(p) for p in saved["profiles"]]
    profiles.append(
        {
            "id": organization_ai.raw_id(result["profile_id"]),
            "name": "旧知识库 MiniMax",
            "provider": "minimax",
            "base_url": destination_url or source["base_url"],
            "model": source["model"],
            "api_key": source["api_key"],
        }
    )
    payload = SharedModelSettingsInput.model_validate(
        {
            "profiles": profiles,
            "default_profile_id": saved["default_profile_id"],
            "revision": expected_revision,
        }
    )
    written = organization_ai.save(db, claims, payload)
    return {**result, "action": "imported", "revision": written["revision"]}
