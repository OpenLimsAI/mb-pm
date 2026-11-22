"""One encrypted model/default registry per verified issuer and organization."""

import json
import threading
from pathlib import Path

from cryptography.fernet import InvalidToken
from fastapi import HTTPException
from sqlalchemy import update
from sqlalchemy.exc import IntegrityError, SQLAlchemyError

from app.core.config import settings
from app.core.security import seal, unseal
from app.models.organization_ai import OrganizationAISettings
from app.schemas.ai import AIAnalysisPreferences
from app.schemas.solution_ai import RESERVED_IDS, SharedModelSettingsInput

PREFIX = "shared:"
CONFLICT = "共享模型配置已有新修改，请重新加载后编辑；未覆盖已保存设置"
UNAVAILABLE = "共享模型配置暂不可读取，请联系管理员检查加密配置"

DEFAULTS = {
    "deepseek": {"base_url": "https://api.deepseek.com", "model": "deepseek-v4-pro"},
    "minimax": {"base_url": "https://api.minimaxi.com/v1", "model": "MiniMax-M3"},
    "kimi": {"base_url": "https://api.moonshot.cn/v1", "model": "kimi-k3.1-pro"},
    "ollama": {"base_url": "http://127.0.0.1:11434", "model": ""},
}

DEFAULT_ANALYSIS_PROMPT = """请按以下章节输出：
1. 管理摘要
2. 进度与里程碑
3. 风险与依赖（优先级、依据、影响）
4. 预算与资源
5. 建议行动（事项、建议负责人、建议时限，明确为建议）
6. 数据缺口"""

DEFAULT_FINANCE_ANALYSIS_PROMPT = """请按以下章节输出：
1. 财务摘要（组合预算执行的总体判断）
2. 预算执行与超支风险（按项目，结合进度判断花费节奏是否匹配）
3. 任务成本偏差（实际花费超出任务预算的任务、预算分配是否合理）
4. 已承诺与剩余预算（能否支撑后续计划）
5. 建议行动（事项、建议负责人、建议时限，明确为建议）
6. 数据缺口（未设置预算、已开始但未录入实际花费等）"""

KINDS = {
    "project": ("analysis_prompt", DEFAULT_ANALYSIS_PROMPT, "项目数据快照"),
    "finance": ("finance_analysis_prompt", DEFAULT_FINANCE_ANALYSIS_PROMPT, "项目组合财务数据快照"),
}
_lock = threading.RLock()


def load_legacy_settings() -> dict:
    with _lock:
        path = Path(settings.AI_SETTINGS_PATH)
        saved = json.loads(path.read_text()) if path.exists() else {}
        provider = saved.get("provider")
        return {
            "provider": provider if provider in DEFAULTS else "deepseek",
            "offline_fallback": saved.get("offline_fallback", False),
            "providers": {
                p: dict(v, **saved.get("providers", {}).get(p, {})) for p, v in DEFAULTS.items()
            },
            **{
                key: (saved.get(key) or "").strip() or default for key, default, _ in KINDS.values()
            },
        }


def identity(claims):
    values = claims.get("iss"), claims.get("owner")
    if any(not isinstance(v, str) or not v or len(v) > 255 for v in values):
        raise HTTPException(403, "缺少已验证的组织身份，无法访问共享模型")
    return values


def raw_id(value):
    return value.removeprefix(PREFIX) if value is not None else None


def public_id(value):
    return PREFIX + value if value is not None else None


def legacy_bootstrap():
    legacy = load_legacy_settings()
    profiles = []
    for provider, cfg in legacy["providers"].items():
        if not cfg.get("model"):
            continue
        profiles.append(
            {
                "id": "system_" + provider,
                "name": "系统 " + provider,
                "provider": provider,
                "base_url": cfg.get("base_url") or DEFAULTS[provider]["base_url"],
                "model": cfg["model"],
                "api_key": cfg.get("api_key", ""),
            }
        )
    selected = "system_" + legacy["provider"]
    return {
        "profiles": profiles,
        "default_profile_id": selected if any(p["id"] == selected for p in profiles) else None,
        "preferences": AIAnalysisPreferences.model_validate(legacy).model_dump(),
    }


def load(db, claims):
    scope = identity(claims)
    row = db.get(OrganizationAISettings, scope)
    if row is None:
        try:
            if scope == (settings.casdoor_issuer, settings.CASDOOR_ORG):
                return None, legacy_bootstrap()
            return None, {"profiles": [], "default_profile_id": None}
        except (OSError, ValueError, KeyError, TypeError):
            raise HTTPException(503, UNAVAILABLE) from None
    try:
        stored = unseal(row.encrypted_payload)
        checked = SharedModelSettingsInput.model_validate(
            {
                "profiles": stored["profiles"],
                "default_profile_id": stored["default_profile_id"],
                "revision": row.revision,
            }
        )
        from app.services.solution_ai import _resolve

        data = {
            "profiles": [_resolve(p, []) for p in checked.profiles],
            "default_profile_id": checked.default_profile_id,
        }
        if "imports" in stored:
            data["imports"] = stored["imports"]
        if "preferences" in stored:
            data["preferences"] = AIAnalysisPreferences.model_validate(
                stored["preferences"]
            ).model_dump()
        return row, data
    except (InvalidToken, ValueError, TypeError, KeyError, HTTPException):
        raise HTTPException(503, UNAVAILABLE) from None


def public(data, revision):
    return {
        "profiles": [
            {
                "id": public_id(p["id"]),
                "name": p["name"],
                "provider": p["provider"],
                "base_url": p["base_url"],
                "model": p["model"],
                "key_set": bool(p.get("api_key")),
            }
            for p in data["profiles"]
        ],
        "default_profile_id": public_id(data["default_profile_id"]),
        "revision": revision,
    }


def save(db, claims, draft, *, preferences=None):
    from app.services.solution_ai import _resolve

    row, previous = load(db, claims)
    if draft.revision != (row.revision if row else 0):
        raise HTTPException(409, CONFLICT)
    normalized = [
        profile.model_copy(update={"id": raw_id(profile.id)}) for profile in draft.profiles
    ]
    if any(profile.id in RESERVED_IDS for profile in normalized):
        raise HTTPException(422, "共享模型标识已保留")
    if len({profile.id for profile in normalized}) != len(normalized):
        raise HTTPException(422, "共享模型标识不可重复")
    data = {
        "profiles": [_resolve(profile, previous["profiles"]) for profile in normalized],
        "default_profile_id": raw_id(draft.default_profile_id),
    }
    if data["default_profile_id"] is not None and not any(
        p["id"] == data["default_profile_id"] for p in data["profiles"]
    ):
        raise HTTPException(422, "默认模型必须在共享配置中")
    if "imports" in previous:
        data["imports"] = previous["imports"]
    if preferences is not None:
        data["preferences"] = AIAnalysisPreferences.model_validate(preferences).model_dump()
    elif "preferences" in previous:
        data["preferences"] = previous["preferences"]
    revision = draft.revision + 1
    issuer, organization = identity(claims)
    try:
        try:
            payload = seal(data)
        except HTTPException:
            raise HTTPException(503, UNAVAILABLE) from None
        if row is None:
            db.add(
                OrganizationAISettings(
                    issuer=issuer,
                    organization=organization,
                    revision=revision,
                    encrypted_payload=payload,
                )
            )
        else:
            result = db.execute(
                update(OrganizationAISettings)
                .where(
                    OrganizationAISettings.issuer == issuer,
                    OrganizationAISettings.organization == organization,
                    OrganizationAISettings.revision == draft.revision,
                )
                .values(revision=revision, encrypted_payload=payload),
                execution_options={"synchronize_session": False},
            )
            if result.rowcount != 1:
                db.rollback()
                raise HTTPException(409, CONFLICT)
        db.commit()
        if row is not None:
            db.expire(row)
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, CONFLICT) from None
    except SQLAlchemyError:
        db.rollback()
        raise HTTPException(503, UNAVAILABLE) from None
    return public(data, revision)
