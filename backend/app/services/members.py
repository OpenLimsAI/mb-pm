"""项目管理成员（users 表）的建立与对账规则：首次登录自动建成员、门户「账号管理」与 IAM 对账共用。

账号以 IAM 为准，项目管理成员只是业务侧的档案（专业组、周工时、任务负责人等）。
项目管理默认对组织内所有人开放，所以 IAM 账号第一次进入项目管理、或在账号管理里新建时，
按同一规则建成员并绑定 IAM sub。在 IAM 管理台直接改的姓名、用户名、启用状态由 reconcile_with_iam 同步回来。
"""

import logging
import re
import time
import zlib
from uuid import uuid4

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models import IAMIdentity, User

log = logging.getLogger(__name__)

# 项目管理不发邮件，成员邮箱仅为必填的唯一值；没有可用邮箱时用保留域名占位
PLACEHOLDER_EMAIL_DOMAIN = "mabpharm.example"
AVATAR_COLORS = ("#2563eb", "#14b8a6", "#f97316", "#a855f7", "#6366f1", "#e11d48", "#0891b2")
_EMAIL = re.compile(r"[^@\s]+@[^@\s]+\.[A-Za-z]{2,}")


def member_email(db: Session, name: str, email: object = "") -> str:
    """优先用 IAM 邮箱；为空、格式不对或已被其他成员占用时用占位邮箱。"""
    if isinstance(email, str) and _EMAIL.fullmatch(email) and len(email) <= 120:
        if not db.query(User.id).filter(User.email == email).first():
            return email
    candidate = f"{name}@{PLACEHOLDER_EMAIL_DOMAIN}"
    while db.query(User.id).filter(User.email == candidate).first():
        candidate = f"{name}.{uuid4().hex[:4]}@{PLACEHOLDER_EMAIL_DOMAIN}"
    return candidate


def username_taken(db: Session, name: str) -> bool:
    return db.query(User.id).filter(func.lower(User.username) == name.lower()).first() is not None


def create_member(
    db: Session,
    subject: str,
    name: str,
    display_name: str,
    email: object,
    role: str,
    *,
    specialty_group: str | None = None,
    weekly_hours: int = 40,
) -> User:
    """新建成员并绑定 IAM sub。调用方先确认同名成员不存在。"""
    member = User(
        id=f"u-{uuid4().hex[:10]}",
        username=name,
        display_name=(display_name or name)[:50],
        email=member_email(db, name, email),
        role=role,
        specialty_group=specialty_group,
        weekly_available_hours=weekly_hours,
        is_active=True,
        avatar_color=AVATAR_COLORS[zlib.crc32(name.encode()) % len(AVATAR_COLORS)],
    )
    db.add(member)
    db.flush()
    db.add(IAMIdentity(issuer=settings.casdoor_issuer, subject=subject, user_id=member.id))
    db.flush()
    return member


def sync_profile(db: Session, member: User, account: dict) -> bool:
    """按 IAM 账号同步已绑定成员的用户名（不与他人冲突时）和姓名。返回是否有改动。"""
    changed = False
    name = account.get("name")
    if (
        isinstance(name, str)
        and 0 < len(name) <= 50
        and name != member.username
        and not db.query(User.id).filter(User.username == name, User.id != member.id).first()
    ):
        member.username = name
        changed = True
    display = account.get("displayName")
    if isinstance(display, str) and display.strip() and display.strip()[:50] != member.display_name:
        member.display_name = display.strip()[:50]
        changed = True
    return changed


RECONCILE_INTERVAL = 60.0
_last_reconcile = float("-inf")


def reconcile_with_iam(db: Session, *, force: bool = False) -> int:
    """以 IAM 为准同步所有已绑定成员：账号被停用 / 删除 → 成员停用；启用 → 成员启用；姓名、用户名跟随。

    在 IAM 管理台直接做的修改不会经过本系统，被停用的人也不会再登录，所以在加载名单时对账。
    未强制时每分钟最多一次；IAM 暂时不可用时跳过，返回改动数。
    """
    global _last_reconcile
    now = time.monotonic()
    if not force and now - _last_reconcile < RECONCILE_INTERVAL:
        return 0
    _last_reconcile = now
    from app.services import iam_admin

    try:
        accounts = {u["id"]: u for u in iam_admin.list_users() if isinstance(u.get("id"), str)}
    except Exception as exc:  # IAM 不可用时名单照常显示，下次再对账
        log.warning("与 IAM 对账成员失败，稍后重试：%s", exc)
        return 0
    rows = (
        db.query(IAMIdentity, User)
        .join(User, User.id == IAMIdentity.user_id)
        .filter(IAMIdentity.issuer == settings.casdoor_issuer)
        .all()
    )
    changed = 0
    for identity, member in rows:
        account = accounts.get(identity.subject)
        active = bool(account) and not account.get("isForbidden") and not account.get("isDeleted")
        if member.is_active != active:
            member.is_active = active
            changed += 1
        if account and sync_profile(db, member, account):
            changed += 1
    if changed:
        db.commit()
        log.info("已按 IAM 同步 %d 处成员信息", changed)
    return changed
