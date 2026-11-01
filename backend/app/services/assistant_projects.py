"""Bounded PM directory snapshots using current IAM and existing row permissions."""

import hashlib
import json
from dataclasses import dataclass

from fastapi import HTTPException
from sqlalchemy import func, select

from app.core import security
from app.core.config import settings
from app.models import IAMIdentity, Project, User
from app.services import accounts, rollup, scope
from app.services.iam_admin import IAMError

MAX_PROJECTS = 50
ACCESS_CHANGED = (
    "项目管理权限或可见项目已变化，历史仍保留；请重新确认权限，或新建任务按当前范围提问"
)
LEGACY_SCOPE = "这份旧回答缺少可验证的项目范围，历史仍保留；请新建任务重新提问"


@dataclass(frozen=True)
class Access:
    user_id: str
    project_ids: frozenset[str]


def fingerprint(permitted):
    canonical = json.dumps(sorted(permitted.project_ids), ensure_ascii=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


def access(db, claims):
    # resolve_identity intentionally uses the configured issuer: guard it before
    # resolving, so an identically named subject from another issuer cannot bind.
    if claims.get("iss") != settings.casdoor_issuer:
        raise HTTPException(403, "当前身份不能读取此项目管理系统的数据")
    if claims.get("owner") != settings.CASDOOR_ORG or not isinstance(claims.get("sub"), str):
        raise HTTPException(403, "当前身份不能读取此项目管理系统的数据")
    db.expire_all()
    identity = db.get(IAMIdentity, (settings.casdoor_issuer, claims["sub"]))
    member = db.get(User, identity.user_id) if identity else None
    if member is None or not member.is_active:
        raise HTTPException(403, "请先登录项目管理并关联有效账号，再使用项目管理数据")
    try:
        roles = accounts.live_roles(claims["sub"])
    except IAMError:
        raise HTTPException(503, "暂时无法确认项目管理权限，请稍后重试") from None
    # An empty role set retains the PM application's ordinary employee policy.
    # Never trust login-time admin roles or create a missing PM identity here.
    fresh = {
        **claims,
        "roles": [
            {"name": name, "owner": settings.CASDOOR_ORG, "isEnabled": True} for name in roles
        ],
    }
    db.expire_all()
    user = security.resolve_identity(fresh, db, bind=False)
    return Access(user.id, frozenset(scope.visible_project_ids_for(user, db)))


def catalogue(db, claims, permitted=None):
    permitted = permitted or access(db, claims)
    base = select(Project).where(Project.id.in_(permitted.project_ids))
    total = db.scalar(select(func.count()).select_from(base.subquery()))
    rows = db.execute(
        select(
            Project.id,
            Project.owner_id,
            Project.code,
            Project.name,
            Project.status,
            Project.progress,
            Project.planned_start,
            Project.planned_end,
            User.display_name,
        )
        .join(User, User.id == Project.owner_id)
        .where(Project.id.in_(permitted.project_ids))
        .order_by(Project.code, Project.id)
        .limit(MAX_PROJECTS)
    ).all()
    spans = rollup.live_span(db, rows)
    evidence = {
        "total": total,
        "returned": len(rows),
        "truncated": total > len(rows),
        "limit": MAX_PROJECTS,
        "items": [
            {
                "code": row.code,
                "name": row.name,
                "status": row.status,
                "owner": row.display_name,
                "owned_by_current_user": row.owner_id == permitted.user_id,
                "progress": row.progress,
                "planned_start": spans[row.id][0].isoformat(),
                "planned_end": spans[row.id][1].isoformat(),
            }
            for row in rows
        ],
        "note": "仅为当前账号可见的项目目录快照；不含任务、财务、联系方式或业务写入能力。",
    }
    return evidence, permitted, [row.id for row in rows]


def recheck(db, claims, before):
    current = access(db, claims)
    if before.user_id != current.user_id or not before.project_ids <= current.project_ids:
        raise HTTPException(403, ACCESS_CHANGED)
    return current


def check_saved(db, claims, scopes):
    ids, hashes = set(), set()
    for metadata in scopes:
        selected = metadata.get("project_ids")
        visible_count = metadata.get("visible_count")
        if (
            metadata.get("version") != 1
            or not isinstance(selected, list)
            or len(selected) > MAX_PROJECTS
            or any(not isinstance(value, str) for value in selected)
            or type(visible_count) is not int
            or visible_count < len(set(selected))
        ):
            raise HTTPException(403, LEGACY_SCOPE)
        ids.update(selected)
        if visible_count > len(selected):
            saved_hash = metadata.get("scope_hash")
            if not isinstance(saved_hash, str) or len(saved_hash) != 64:
                raise HTTPException(403, LEGACY_SCOPE)
            hashes.add(saved_hash)
    current = access(db, claims)
    if not ids <= current.project_ids or (hashes and hashes != {fingerprint(current)}):
        raise HTTPException(403, ACCESS_CHANGED)
    return current
