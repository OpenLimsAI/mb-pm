"""门户「账号管理」：IAM 的简化版。账号、身份与项目管理成员档案在一处维护。

IAM 是账号与角色的唯一来源：列表每次直接读 Casdoor，修改直接写回 Casdoor，所以与 IAM 管理台始终一致，
不在本系统另存账号。项目管理成员（users 表）只是业务档案（专业组、周工时、任务负责人），随账号维护；
项目管理里不能再自行增删成员，在 IAM 管理台直接建的账号第一次进入项目管理时自动建成员。

平台身份与应用角色分别维护：
    系统管理员   admin       独立平台身份；账号管理可写，项目管理继承全部权限
    项目负责人   cmc_lead    编辑项目（项目信息、预算与 WBS 结构）、删除项目等重要编辑（管理全部项目）；账号管理只能查看
    员工         不分配      项目管理默认 rd：更新本人任务等日常录入；看不到账号管理
    知识库       kb_editor   新建默认编辑；历史阅读者保留，编辑授权须明确选择
旧角色 project_lead 保留本人项目范围，production / qa_qc 保留实际角色；未修改 PM 业务角色时不改写。
管理工作台（dikw-admin）等其他角色不在账号管理里维护，保持原样（删除账号时一并移出）。

生效时机：角色写入 IAM 后，对方下次登录时生效（登录令牌带角色）；停用对项目管理立即生效（成员同时停用）。
每次请求都向 IAM 实时核对操作人的角色，操作人还须有有效的项目管理成员（用于审计）。
"""

import hashlib
import json
import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from functools import wraps
from uuid import uuid4

from cryptography.fernet import InvalidToken
from fastapi import HTTPException, status
from jose import JWTError, jwt
from sqlalchemy import func, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import DEFAULT_ROLE, ROLE_PRIORITY, ROLES, seal, unseal
from app.models import AuditLog, IAMIdentity, PortalSession, User
from app.schemas.accounts import (
    AccountCreate,
    AccountOut,
    AccountsOut,
    AccountUpdate,
    IssueOut,
    PMMemberOut,
)
from app.services import iam_admin, members, password_policy
from app.services.iam_admin import IAMError
from app.services.members import create_member, username_taken

log = logging.getLogger(__name__)

ADMIN_ROLE = "admin"
PM_ROLES = ROLES - {ADMIN_ROLE}
LEAD_ROLES = {"cmc_lead", "project_lead"}
IDENTITY_ROLE = {"admin": ADMIN_ROLE, "lead": "cmc_lead"}
KB_ROLES = {"kb_manager", "kb_viewer", "kb_editor"}
KB_DEFAULT = "kb_editor"
KB_ROLE_MAPPING = {"manager": "kb_manager", "editor": "kb_editor"}
MANAGED_ROLES = ROLES | KB_ROLES
SELF_PASSWORD_HINT = "修改自己的密码请到工作台「我的设置」"
ORG_ADMIN_HINT = "该账号是 IAM 组织管理员，只能在 IAM 管理台{}"


@dataclass
class Actor:
    subject: str
    username: str
    user: User
    tier: str  # "admin" 系统管理员 / "lead" 项目负责人（只能查看）


def _identity(pm_roles: set[str]) -> str:
    if ADMIN_ROLE in pm_roles:
        return "admin"
    return "lead" if pm_roles & LEAD_ROLES else "staff"


def _member_role(identity: str) -> str:
    """成员表里 role 列的值（仅用于组织名单显示与负责人候选，授权以 IAM 为准）。"""
    return IDENTITY_ROLE.get(identity, DEFAULT_ROLE)


def _enabled_role_names(account: dict) -> set[str]:
    return {
        r["name"]
        for r in account.get("roles") or []
        if isinstance(r, dict)
        and r.get("owner") == settings.CASDOOR_ORG
        and r.get("isEnabled", True) is True
        and isinstance(r.get("name"), str)
    }


def _bad_request(exc: IAMError) -> HTTPException:
    return HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))


def live_roles(subject: str) -> set[str]:
    """实时核对账号仍启用，返回其当前在本组织启用的角色（不信任登录时令牌里的状态与角色）。"""
    account = iam_admin.get_user_by_sub(subject)
    if account.get("isForbidden") or account.get("isDeleted"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "IAM 账号已停用")
    return _enabled_role_names(account)


def require_manager(claims: dict, db: Session) -> Actor:
    """实时核对：门户会话里的账号当前仍启用，且是系统管理员或项目负责人（不信任登录时令牌里的旧角色）。"""
    subject = claims["sub"]
    account = iam_admin.get_user_by_sub(subject)
    if account.get("isForbidden") or account.get("isDeleted"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "IAM 账号已停用")
    roles = _enabled_role_names(account)
    tier = "admin" if ADMIN_ROLE in roles else "lead" if roles & LEAD_ROLES else None
    if tier is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "只有系统管理员和项目负责人可以使用账号管理")
    member, _ = _member_for(db, subject, account["name"])
    if member is None or not member.is_active:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "请先登录一次项目管理（用于记录操作人），再使用账号管理"
        )
    if password_policy.change_required(db, subject):
        raise HTTPException(status.HTTP_403_FORBIDDEN, password_policy.CHANGE_FIRST)
    return Actor(subject=subject, username=account["name"], user=member, tier=tier)


def _admin_only(actor: Actor) -> None:
    if actor.tier != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "项目负责人只能查看，修改请联系系统管理员")


def _member_for(db: Session, subject: str, name: str) -> tuple[User | None, bool]:
    """账号对应的项目管理成员：(成员, 是否已绑定本账号)。未绑定时按同名且未绑定其他 IAM 的成员匹配。"""
    identity = db.get(IAMIdentity, (settings.casdoor_issuer, subject))
    if identity:
        return db.get(User, identity.user_id), True
    candidate = db.query(User).filter(func.lower(User.username) == name.lower()).first()
    if candidate is None or _bound_subject(db, candidate.id):
        return None, False
    return candidate, False


def _bound_subject(db: Session, user_id: str) -> str | None:
    row = db.query(IAMIdentity).filter_by(issuer=settings.casdoor_issuer, user_id=user_id).first()
    return row.subject if row else None


def _ensure_member(db: Session, account: dict, role: str) -> User:
    """把账号与项目管理成员对上：已有同名未绑定成员则绑定，没有就新建（项目管理默认对所有人开放）。"""
    subject, name = account["id"], account["name"]
    member, bound = _member_for(db, subject, name)
    if member is None:
        if username_taken(db, name):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"项目管理中的同名成员 {name} 已关联其他 IAM 账号，请先核对",
            )
        return create_member(
            db, subject, name, account.get("displayName") or name, account.get("email"), role
        )
    if not bound:
        db.add(IAMIdentity(issuer=settings.casdoor_issuer, subject=subject, user_id=member.id))
        db.flush()
    return member


def _target(subject: str) -> dict:
    try:
        account = iam_admin.get_user_by_sub(subject)
    except HTTPException as exc:
        if exc.status_code != status.HTTP_409_CONFLICT:
            raise
        account = None
    if not account or account.get("isDeleted"):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "IAM 中没有这个账号，请刷新后重试")
    return account


def _memberships(roles: list[dict], name: str, *, enabled_only: bool) -> set[str]:
    member = f"{settings.CASDOOR_ORG}/{name}"
    return {
        r["name"]
        for r in roles
        if member in (r.get("users") or []) and (not enabled_only or r.get("isEnabled", True))
    }


def _require_roles_exist(roles: set[str], existing: list[dict]) -> None:
    """先确认要分配的角色都在 IAM 中（如测试环境可能没有知识库角色），避免建了一半再撤销。"""
    missing = sorted(roles - {r["name"] for r in existing if r.get("isEnabled", True)})
    if missing:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"IAM 中缺少已启用的角色 {'、'.join(missing)}，请先在 IAM 管理台配置",
        )


# ---------- 列表与一致性检查 ----------


def snapshot(db: Session, actor: Actor) -> AccountsOut:
    members.reconcile_with_iam(db, force=True)
    users = iam_admin.list_users()
    roles = iam_admin.list_roles()
    identities = {
        i.subject: i.user_id
        for i in db.query(IAMIdentity).filter_by(issuer=settings.casdoor_issuer).all()
    }
    bound_users = set(identities.values())
    flagged = password_policy.flagged_subjects(db)
    pm_users = {u.id: u for u in db.query(User).all()}
    by_name = {u.username.lower(): u for u in pm_users.values()}
    accounts: list[AccountOut] = []
    issues: list[IssueOut] = []
    linked: set[str] = set()

    def issue(kind: str, sub: str, name: str, display: str, message: str) -> None:
        issues.append(
            IssueOut(
                kind=kind, account_id=sub, username=name, display_name=display, message=message
            )
        )

    for account in sorted(users, key=lambda u: str(u.get("createdTime") or "")):
        sub, name = account.get("id"), account.get("name")
        if not isinstance(sub, str) or not isinstance(name, str):
            continue
        display = account.get("displayName") or name
        held = _memberships(roles, name, enabled_only=True)
        member, bound, conflict = None, False, False
        if sub in identities:
            member, bound = pm_users.get(identities[sub]), True
        elif (candidate := by_name.get(name.lower())) is not None:
            if candidate.id in bound_users:
                conflict = True
            else:
                member = candidate
        if member:
            linked.add(member.id)
        enabled = not account.get("isForbidden")
        kb_enabled = bool(held & KB_ROLES)
        accounts.append(
            AccountOut(
                id=sub,
                username=name,
                display_name=display,
                email=account.get("email") or "",
                created_at=str(account.get("createdTime") or ""),
                enabled=enabled,
                must_change_password=sub in flagged,
                org_admin=bool(account.get("isAdmin")),
                platform_admin=ADMIN_ROLE in held,
                pm_identity="lead" if held & LEAD_ROLES else "staff",
                pm_effective_role=next((r for r in ROLE_PRIORITY if r in held), DEFAULT_ROLE),
                kb_role="manager"
                if "kb_manager" in held
                else "editor"
                if "kb_editor" in held
                else "viewer"
                if "kb_viewer" in held
                else "unassigned",
                kb_roles=sorted(held & KB_ROLES),
                identity=_identity(held & ROLES),
                kb_enabled=kb_enabled,
                pm_roles=sorted(held & PM_ROLES),
                other_roles=sorted(held - MANAGED_ROLES),
                pm_member=PMMemberOut(
                    id=member.id,
                    username=member.username,
                    active=member.is_active,
                    bound=bound,
                    specialty_group=member.specialty_group,
                    weekly_hours=member.weekly_available_hours,
                )
                if member
                else None,
                is_self=sub == actor.subject,
            )
        )

        here = (sub, name, display)
        if name.startswith("user_") and str(display).startswith("New User"):
            issue("default_account", *here, "IAM「添加」时留下的默认账号（默认密码 123），建议删除")
            continue
        if not enabled:
            continue
        if account.get("needUpdatePassword"):
            issue(
                "iam_password_flag",
                *here,
                "IAM 中打开了「需要更新密码」：登录会被带到 IAM 页面、回不到应用；点修复改为在工作台内改密",
            )
        if not kb_enabled:
            issue("kb_missing", *here, "知识库待分配；请选择可编辑权限后保存")
        if conflict:
            issue(
                "pm_member_conflict", *here, f"同名项目管理成员 {name} 已关联其他 IAM 账号，需核对"
            )
        elif member and not member.is_active:
            issue("pm_member_inactive", *here, "账号已启用，但项目管理成员是停用状态，无法进入")

    for member in pm_users.values():
        # 已停用的成员保留历史即可；绑定的 IAM 账号已不存在（如在 IAM 管理台删除）也算未关联
        if not member.is_active or member.id in linked:
            continue
        issues.append(
            IssueOut(
                kind="pm_only_member",
                member_id=member.id,
                username=member.username,
                display_name=member.display_name,
                message="项目管理中有这个成员，但 IAM 里没有对应账号（历史数据），请为其建账号",
            )
        )
    available = sorted(
        r["name"] for r in roles if r["name"] in MANAGED_ROLES and r.get("isEnabled", True)
    )
    return AccountsOut(
        accounts=accounts,
        issues=issues if actor.tier == "admin" else [],
        roles=available,
        actor=actor.tier,
    )


# ---------- 写操作（仅系统管理员） ----------


def _audit(db: Session, actor: Actor, action: str, subject: str, detail: dict) -> None:
    db.add(
        AuditLog(
            id=f"log-{uuid4().hex[:12]}",
            actor_id=actor.user.id,
            action=action,
            target="账号",
            target_id=subject[:40],
            detail=json.dumps(detail, ensure_ascii=False),
            created_at=datetime.now(UTC),
        )
    )


def _commit(db: Session) -> None:
    try:
        db.commit()
    except SQLAlchemyError as exc:
        db.rollback()
        log.exception("账号管理：IAM 已修改，项目管理成员同步失败")
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "IAM 已保存，但项目管理成员同步失败；请刷新后在「需要处理」中修复",
        ) from exc


def _lock_mutations(db: Session) -> None:
    """共享数据库锁串行化本组织的 IAM 成员读改写，覆盖多个应用进程。"""
    if db.get_bind().dialect.name == "postgresql":
        key = int.from_bytes(hashlib.sha256(settings.CASDOOR_ORG.encode()).digest()[:8], "big") & (
            (1 << 63) - 1
        )
        db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": key})
    else:
        db.connection().exec_driver_sql("BEGIN IMMEDIATE")


def _serialized(operation):
    @wraps(operation)
    def run(db: Session, actor: Actor, *args, **kwargs):
        _admin_only(actor)
        try:
            _lock_mutations(db)
            if ADMIN_ROLE not in live_roles(actor.subject):
                raise HTTPException(403, "系统管理员身份已变更，请刷新后重试")
            return operation(db, actor, *args, **kwargs)
        except Exception:
            db.rollback()
            raise

    return run


@_serialized
def create(db: Session, actor: Actor, payload: AccountCreate) -> None:
    _admin_only(actor)
    name = payload.username
    if iam_admin.get_user_by_name(name):
        raise HTTPException(status.HTTP_409_CONFLICT, f"IAM 中已有用户名 {name}")
    existing = db.query(User).filter(func.lower(User.username) == name).first()
    if existing and _bound_subject(db, existing.id):
        raise HTTPException(
            status.HTTP_409_CONFLICT, f"项目管理成员 {name} 已关联其他 IAM 账号，请换一个用户名"
        )
    roles = {KB_ROLE_MAPPING[payload.kb_role]}
    if payload.platform_admin:
        roles.add(ADMIN_ROLE)
    if payload.pm_identity == "lead":
        roles.add("cmc_lead")
    _require_roles_exist(roles, iam_admin.list_roles())
    try:
        account = iam_admin.create_user(
            name, payload.display_name, payload.password, payload.email or ""
        )
    except IAMError as exc:
        raise _bad_request(exc) from exc
    try:
        for role in sorted(roles):
            iam_admin.set_role_members(role, add={name})
        _verify_saved(
            account, roles, {"displayName": payload.display_name, "email": payload.email or ""}
        )
        role = next((r for r in ROLE_PRIORITY if r in roles), DEFAULT_ROLE)
        member = _ensure_member(db, account, role)
        member.role = role
        member.display_name = payload.display_name
        member.specialty_group = payload.specialty_group
        member.weekly_available_hours = payload.weekly_hours
        member.is_active = True
        password_policy.require_change(db, account["id"], "created")
        _audit(
            db,
            actor,
            "新建账号",
            account["id"],
            {
                "username": name,
                "display_name": payload.display_name,
                "identity": _identity(roles),
                "platform_admin": payload.platform_admin,
                "pm_identity": payload.pm_identity,
                "kb_role": payload.kb_role,
                "roles": sorted(roles),
            },
        )
        db.commit()
    except Exception as exc:
        db.rollback()
        _undo_create(name, roles)
        if isinstance(exc, IAMError):
            raise _bad_request(exc) from exc
        if isinstance(exc, SQLAlchemyError):
            raise HTTPException(
                status.HTTP_409_CONFLICT, "项目管理成员保存失败，已撤销新建"
            ) from exc
        raise


def _undo_create(name: str, roles: set[str]) -> None:
    # 每一步单独尽力而为：某个角色撤不掉也要继续删除账号
    for role in sorted(roles):
        try:
            iam_admin.set_role_members(role, remove={name})
        except Exception:
            log.exception("账号管理：撤销新建时未能把 %s 移出角色 %s", name, role)
    try:
        iam_admin.delete_user(name)
    except Exception:
        log.exception("账号管理：新建失败且未能撤销 IAM 账号 %s，请在 IAM 管理台删除", name)


def _undo_update(account: dict, current: set[str], wanted: set[str], changes: dict) -> None:
    """仅撤销本次触碰的成员关系与资料，不覆盖其他账号或其他应用角色。"""
    name = account["name"]
    touched = current ^ wanted
    held = _memberships(iam_admin.list_roles(), name, enabled_only=False) & touched
    for role in sorted((current & touched) - held):
        iam_admin.set_role_members(role, add={name})
    for role in sorted(held - current):
        iam_admin.set_role_members(role, remove={name})
    if changes:
        latest = _target(account["id"])
        restore = {}
        for key, value in changes.items():
            old = account.get(key, False if key == "isForbidden" else "")
            if latest.get(key) == old:
                continue
            if latest.get(key) != value:
                raise IAMError("资料已被其他操作修改，无法自动撤销")
            restore[key] = old
        if restore:
            iam_admin.update_user(account["id"], name, restore)
    restored = _memberships(iam_admin.list_roles(), name, enabled_only=False) & touched
    if restored != current & touched:
        raise IAMError("IAM 角色撤销结果不一致")
    if changes:
        latest = _target(account["id"])
        if any(
            latest.get(key) != account.get(key, False if key == "isForbidden" else "")
            for key in changes
        ):
            raise IAMError("IAM 资料撤销结果不一致")


def _verify_saved(account: dict, wanted: set[str], changes: dict) -> None:
    held = _memberships(iam_admin.list_roles(), account["name"], enabled_only=False) & MANAGED_ROLES
    latest = _target(account["id"])
    if held != wanted or any(latest.get(key) != value for key, value in changes.items()):
        raise HTTPException(409, "IAM 保存结果与预期不一致，已尝试撤销，请刷新后重试")


def _refresh_catalogue(db: Session, subject: str, roles: set[str]) -> None:
    """仅更新门户入口缓存；业务权限仍验签并由各应用校验，不改签发的令牌。"""
    with db.no_autoflush:
        for session in (
            db.query(PortalSession).order_by(PortalSession.id).populate_existing().with_for_update()
        ):
            try:
                data = unseal(session.tokens)
                # 这里只定位待更新的服务端会话，不用未验签声明授权。
                if jwt.get_unverified_claims(data["access_token"]).get("sub") != subject:
                    continue
            except (InvalidToken, JWTError, ValueError, KeyError, TypeError):
                continue
            data["catalogue_roles"] = [
                {"owner": settings.CASDOOR_ORG, "name": role, "isEnabled": True}
                for role in sorted(roles)
            ]
            session.tokens = seal(data)


@_serialized
def update(db: Session, actor: Actor, subject: str, payload: AccountUpdate) -> None:
    _admin_only(actor)
    account = _target(subject)
    name = account["name"]
    is_self = subject == actor.subject
    roles = iam_admin.list_roles()
    current = _memberships(roles, name, enabled_only=False) & MANAGED_ROLES
    cur_identity = _identity(current & ROLES)
    new_identity = cur_identity
    wanted = set(current)
    if payload.platform_admin is not None:
        wanted.discard(ADMIN_ROLE)
        if payload.platform_admin:
            wanted.add(ADMIN_ROLE)
        new_identity = _identity(wanted & ROLES)
    if payload.pm_identity is not None and payload.pm_identity != (
        "lead" if current & LEAD_ROLES else "staff"
    ):
        wanted -= PM_ROLES
        if payload.pm_identity == "lead":
            wanted.add("cmc_lead")
        new_identity = _identity(wanted & ROLES)
    if payload.kb_role is not None:
        wanted -= KB_ROLES
        wanted.add(KB_ROLE_MAPPING[payload.kb_role])
    _require_roles_exist(
        (wanted - current) | ({KB_ROLE_MAPPING[payload.kb_role]} if payload.kb_role else set()),
        roles,
    )

    enabled = payload.enabled
    if is_self and cur_identity == "admin" and new_identity != "admin":
        raise HTTPException(status.HTTP_409_CONFLICT, "不能取消自己的系统管理员身份")
    if is_self and enabled is False:
        raise HTTPException(status.HTTP_409_CONFLICT, "不能停用自己的账号")
    if account.get("isAdmin") and enabled is False:
        raise HTTPException(status.HTTP_409_CONFLICT, ORG_ADMIN_HINT.format("停用"))

    changes: dict[str, object] = {}
    if payload.display_name is not None and payload.display_name != account.get("displayName"):
        changes["displayName"] = payload.display_name
    if payload.email is not None and payload.email != (account.get("email") or ""):
        changes["email"] = payload.email
    if enabled is not None and enabled == bool(account.get("isForbidden")):
        changes["isForbidden"] = not enabled

    # 只改 KB / 平台身份 / 公共资料不创建 PM 成员；主动维护 PM 档案才建立绑定。
    member, _ = _member_for(db, subject, name)
    if any(
        v is not None for v in (payload.pm_identity, payload.specialty_group, payload.weekly_hours)
    ):
        member = _ensure_member(db, account, _member_role(new_identity))
    profile: dict[str, object] = {}
    group = payload.specialty_group
    if member and group is not None and (group or None) != member.specialty_group:
        profile["specialty_group"] = group or None
    hours = payload.weekly_hours
    if member and hours is not None and hours != member.weekly_available_hours:
        profile["weekly_available_hours"] = hours
    if not changes and wanted == current and not profile and not db.new:
        db.rollback()
        return
    try:
        if changes:
            iam_admin.update_user(subject, name, changes)
        for role in sorted(wanted - current):
            iam_admin.set_role_members(role, add={name})
        for role in sorted(current - wanted):
            iam_admin.set_role_members(role, remove={name})
        _verify_saved(account, wanted, changes)
    except (IAMError, HTTPException) as exc:
        try:
            _undo_update(account, current, wanted, changes)
        except Exception as undo:
            log.exception("账号修改失败且 IAM 补偿失败：%s", subject)
            raise HTTPException(
                409, "部分修改可能已保存，自动撤销失败，请刷新并联系管理员核对"
            ) from undo
        finally:
            db.rollback()
        if isinstance(exc, IAMError):
            raise _bad_request(exc) from exc
        raise
    except Exception:
        db.rollback()
        raise

    try:
        if member:
            for key, value in profile.items():
                setattr(member, key, value)
            if "displayName" in changes:
                member.display_name = payload.display_name
            if current & ROLES != wanted & ROLES:
                member.role = next((r for r in ROLE_PRIORITY if r in wanted), DEFAULT_ROLE)
        if enabled is not None:
            # 停用立即影响 PM 成员，同时结束目标账号在本系统的会话。
            if member:
                member.is_active = enabled
            if enabled is False:
                password_policy.end_sessions(db, subject)
        if wanted != current:
            _refresh_catalogue(
                db, subject, wanted & {r["name"] for r in roles if r.get("isEnabled", True)}
            )
        _audit(
            db,
            actor,
            "修改账号",
            subject,
            {
                "username": name,
                "fields": sorted([k for k in changes if k != "isForbidden"] + list(profile)),
                "enabled": enabled,
                "identity": [cur_identity, new_identity],
                "platform_admin": [ADMIN_ROLE in current, ADMIN_ROLE in wanted],
                "pm_roles": [sorted(current & PM_ROLES), sorted(wanted & PM_ROLES)],
                "kb_roles": [sorted(current & KB_ROLES), sorted(wanted & KB_ROLES)],
                "added_roles": sorted(wanted - current),
                "removed_roles": sorted(current - wanted),
            },
        )
        db.commit()
    except SQLAlchemyError as exc:
        db.rollback()
        try:
            _lock_mutations(db)
            _undo_update(account, current, wanted, changes)
        except Exception as undo:
            log.exception("数据库保存失败且 IAM 补偿失败：%s", subject)
            raise HTTPException(
                409, "部分修改可能已保存，自动撤销失败，请刷新并联系管理员核对"
            ) from undo
        finally:
            db.rollback()
        raise HTTPException(409, "保存失败，已撤销本次 IAM 修改，请稍后重试") from exc


@_serialized
def rename(db: Session, actor: Actor, subject: str, new_name: str) -> None:
    _admin_only(actor)
    account = _target(subject)
    old_name = account["name"]
    if account.get("isAdmin"):
        raise HTTPException(status.HTTP_409_CONFLICT, ORG_ADMIN_HINT.format("改用户名"))
    if new_name == old_name:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "新用户名与当前用户名相同")
    if iam_admin.get_user_by_name(new_name):
        raise HTTPException(status.HTTP_409_CONFLICT, f"IAM 中已有用户名 {new_name}")
    member, bound = _member_for(db, subject, old_name)
    taken = db.query(User.id).filter(func.lower(User.username) == new_name)
    if member:
        taken = taken.filter(User.id != member.id)
    if taken.first():
        raise HTTPException(status.HTTP_409_CONFLICT, "项目管理中已有成员使用该用户名")
    if iam_admin.name_shared_across_orgs(old_name):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "IAM 的其他组织中有同名成员，为避免误改其角色，请在 IAM 管理台修改用户名",
        )
    try:
        iam_admin.rename_user(subject, new_name)
    except IAMError as exc:
        raise _bad_request(exc) from exc
    if member:
        member.username = new_name
        if not bound:
            db.add(IAMIdentity(issuer=settings.casdoor_issuer, subject=subject, user_id=member.id))
    _audit(db, actor, "修改用户名", subject, {"from": old_name, "to": new_name})
    try:
        db.commit()
    except SQLAlchemyError as exc:
        db.rollback()
        try:
            iam_admin.rename_user(subject, old_name)
            detail = "用户名同步失败，已撤销修改，请稍后重试"
        except Exception:
            log.exception(
                "账号管理：用户名同步失败且 IAM 改名未能撤销：%s → %s", old_name, new_name
            )
            detail = f"用户名同步失败：IAM 中已改为 {new_name}，请联系管理员核对"
        raise HTTPException(status.HTTP_409_CONFLICT, detail) from exc


@_serialized
def reset_password(db: Session, actor: Actor, subject: str, password: str) -> None:
    _admin_only(actor)
    account = _target(subject)
    if subject == actor.subject:
        raise HTTPException(status.HTTP_409_CONFLICT, SELF_PASSWORD_HINT)
    if account.get("isAdmin"):
        raise HTTPException(status.HTTP_409_CONFLICT, ORG_ADMIN_HINT.format("重置密码"))
    try:
        iam_admin.reset_password(account["name"], password)
    except IAMError as exc:
        raise _bad_request(exc) from exc
    # 对方须先用临时密码登录并改密；已登录的会话（项目管理与门户）立即失效
    password_policy.require_change(db, subject, "reset")
    ended = password_policy.end_sessions(db, subject)
    _audit(db, actor, "重置密码", subject, {"username": account["name"], "ended_sessions": ended})
    _commit(db)


@_serialized
def delete(db: Session, actor: Actor, subject: str) -> None:
    _admin_only(actor)
    account = _target(subject)
    name = account["name"]
    if subject == actor.subject:
        raise HTTPException(status.HTTP_409_CONFLICT, "不能删除自己的账号")
    if account.get("isAdmin"):
        raise HTTPException(status.HTTP_409_CONFLICT, ORG_ADMIN_HINT.format("删除"))
    member, _ = _member_for(db, subject, name)
    held = _memberships(iam_admin.list_roles(), name, enabled_only=False)
    try:
        # Casdoor 删除账号不清理角色成员；先移出所有角色，避免以后同名新账号继承旧权限
        for role in sorted(held):
            iam_admin.set_role_members(role, remove={name})
        iam_admin.delete_user(name)
    except IAMError as exc:
        raise _bad_request(exc) from exc
    if member:
        # 保留成员与其负责的项目 / 任务历史，只停用
        member.is_active = False
    db.query(IAMIdentity).filter_by(issuer=settings.casdoor_issuer, subject=subject).delete()
    password_policy.clear_change(db, subject)
    password_policy.end_sessions(db, subject)
    _audit(db, actor, "删除账号", subject, {"username": name, "removed_roles": sorted(held)})
    _commit(db)


@_serialized
def repair(db: Session, actor: Actor, subject: str) -> None:
    """只修复密码标记及 PM 成员；知识库编辑权限必须显式选择后保存。"""
    _admin_only(actor)
    account = _target(subject)
    if account.get("isForbidden"):
        raise HTTPException(status.HTTP_409_CONFLICT, "账号已停用，请先启用")
    name = account["name"]
    roles = iam_admin.list_roles()
    held = _memberships(roles, name, enabled_only=True)
    member = _ensure_member(db, account, _member_role(_identity(held & ROLES)))
    member.is_active = True
    migrated = bool(account.get("needUpdatePassword"))
    if migrated:
        password_policy.require_change(db, subject, "migrated")
        db.flush()
        try:
            iam_admin.update_user(subject, name, {"needUpdatePassword": False})
        except IAMError as exc:
            db.rollback()
            raise _bad_request(exc) from exc
    detail = {
        "username": name,
        "member_id": member.id,
        "added_roles": [],
        "migrated_password_flag": migrated,
    }
    _audit(db, actor, "修复账号", subject, detail)
    _commit(db)
