"""Feedback workflow invariants, safe source context and append-only subscriptions."""

import re
from datetime import UTC, datetime
from urllib.parse import quote, unquote, urlsplit
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from app.api.v1 import portal
from app.models.feedback import (
    Feedback,
    FeedbackCounter,
    FeedbackNotice,
    FeedbackRead,
    FeedbackVote,
    FeedbackWatch,
)
from app.services import accounts
from app.services.iam_admin import IAMError

STRUCTURED = (
    "steps_to_reproduce",
    "expected_result",
    "actual_result",
    "problem_to_solve",
    "expected_benefit",
)
STATUSES = ("open", "in_progress", "ready", "released", "fixed")


def utc(value):
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def now():
    return datetime.now(UTC)


def safe_context(value, applications):
    if value is None:
        return {}
    if not isinstance(value, dict) or set(value) - {
        "application",
        "path",
        "browser",
        "captured_at",
    }:
        raise HTTPException(422, "来源信息格式不正确")
    out = {}
    if value.get("application") is not None:
        if not isinstance(value["application"], str) or value["application"] not in applications:
            raise HTTPException(422, "来源应用不正确")
        out["application"] = value["application"]
    if value.get("path"):
        path = value["path"]
        if (
            not isinstance(path, str)
            or len(path) > 1000
            or not path.startswith("/")
            or path.startswith("//")
            or "\\" in path
            or any(ord(c) < 32 or ord(c) == 127 for c in unquote(path))
        ):
            raise HTTPException(422, "来源页面必须是安全的站内路径")
        parsed = urlsplit(path)
        fragment = parsed.fragment.split("?", 1)[0]
        if fragment not in {"notes", "research", "settings", "library"} and not fragment.startswith(
            "/"
        ):
            fragment = ""
        forbidden = r"/(?:api|auth|oauth|oidc|login|logout|callback|register)(?:/|$)"
        if (
            re.search(forbidden, unquote(parsed.path), re.I)
            or re.search(forbidden, unquote(fragment), re.I)
            or fragment.startswith("//")
        ):
            raise HTTPException(422, "登录或接口地址不能作为反馈来源")
        out["path"] = (parsed.path + ("#" + fragment if fragment else ""))[:500]
    if value.get("browser"):
        browser = value["browser"]
        if not isinstance(browser, str) or len(browser) > 300 or any(ord(c) < 32 for c in browser):
            raise HTTPException(422, "浏览器信息格式不正确")
        out["browser"] = browser
    if value.get("captured_at"):
        try:
            out["captured_at"] = utc(
                datetime.fromisoformat(value["captured_at"].replace("Z", "+00:00"))
            ).isoformat()
        except (ValueError, TypeError, AttributeError):
            raise HTTPException(422, "来源时间格式不正确") from None
    return out


def allocate_number(db, issuer):
    insert = pg_insert if db.bind.dialect.name == "postgresql" else sqlite_insert
    first = (
        select(func.coalesce(func.max(Feedback.issue_number), 0) + 1)
        .where(Feedback.issuer == issuer)
        .scalar_subquery()
    )
    query = insert(FeedbackCounter).values(issuer=issuer, value=first)
    query = query.on_conflict_do_update(
        index_elements=[FeedbackCounter.issuer], set_={"value": FeedbackCounter.value + 1}
    ).returning(FeedbackCounter.value)
    return db.scalar(query)


def ensure_numbers(engine):
    """Called only by the explicit schema-owner upgrade, never by normal reads."""
    from sqlalchemy.orm import Session

    with Session(engine) as db:
        rows = db.scalars(
            select(Feedback)
            .where(Feedback.issue_number.is_(None))
            .order_by(Feedback.issuer, Feedback.created_at, Feedback.id)
            .with_for_update()
        ).all()
        for row in rows:
            row.issue_number = allocate_number(db, row.issuer)
        db.commit()


def admin(claims):
    return "admin" in portal.enabled_roles(claims)


def live_admin(claims):
    if not admin(claims):
        return False
    try:
        return "admin" in accounts.live_roles(claims["sub"])
    except IAMError:
        raise HTTPException(503, "暂时无法确认管理员权限，请稍后重试") from None


def require_manage(row, claims):
    if claims["sub"] in {row.author_id, row.assignee_id}:
        return
    if not live_admin(claims):
        raise HTTPException(403, "只有提交人、当前处理人或管理员可以管理此反馈")


def require_edit(row, claims):
    if row.author_id != claims["sub"] and not live_admin(claims):
        raise HTTPException(403, "只有提交人或管理员可以编辑原反馈")


def metadata_rows(db, rows, claims):
    ids = [row.id for row in rows]
    if not ids:
        return {}
    votes = dict(
        db.execute(
            select(FeedbackVote.feedback_id, func.count())
            .where(FeedbackVote.feedback_id.in_(ids))
            .group_by(FeedbackVote.feedback_id)
        ).all()
    )
    own_votes = set(
        db.scalars(
            select(FeedbackVote.feedback_id).where(
                FeedbackVote.feedback_id.in_(ids), FeedbackVote.subject == claims["sub"]
            )
        )
    )
    watches = dict(
        db.execute(
            select(FeedbackWatch.feedback_id, FeedbackWatch.enabled).where(
                FeedbackWatch.feedback_id.in_(ids), FeedbackWatch.subject == claims["sub"]
            )
        ).all()
    )
    unread = dict(
        db.execute(
            select(FeedbackNotice.feedback_id, func.count())
            .where(
                FeedbackNotice.feedback_id.in_(ids),
                FeedbackNotice.issuer == claims["iss"],
                FeedbackNotice.subject == claims["sub"],
                FeedbackNotice.read_at.is_(None),
            )
            .group_by(FeedbackNotice.feedback_id)
        ).all()
    )
    # Capabilities describe current privileges, including revocation after login.
    # A directory outage must not prevent viewing feedback; writes still fail closed.
    verified_admin = False
    if admin(claims):
        try:
            verified_admin = live_admin(claims)
        except HTTPException:
            pass
    result = {}
    for row in rows:
        mine = row.author_id == claims["sub"]
        manages = mine or row.assignee_id == claims["sub"] or verified_admin
        follows = watches.get(row.id, mine or row.assignee_id == claims["sub"])
        result[row.id] = {
            "issue_number": row.issue_number,
            "number": f"FB-{row.issue_number:04d}" if row.issue_number is not None else None,
            "permalink": "/feedback?feedback=" + quote(row.id, safe=""),
            "source_context": row.source_context or {},
            "workflow_version": row.workflow_version,
            "revision": row.revision,
            "assignee_id": row.assignee_id,
            "assignee_name": row.assignee_name,
            "priority": row.priority,
            "due_at": utc(row.due_at).isoformat() if row.due_at else None,
            "resolution": row.resolution,
            "verification_steps": row.verification_steps,
            "release_version": row.release_version,
            "can_edit": mine or verified_admin,
            "can_manage": manages,
            "can_assign": verified_admin,
            "can_unclaim": row.assignee_id == claims["sub"],
            "can_reopen": row.status == "fixed" and manages,
            "can_verify": mine and row.status == "released",
            "can_claim": (row.status != "fixed" or manages)
            and (row.assignee_id in (None, claims["sub"]) or verified_admin),
            "can_remind": mine or follows or verified_admin,
            "vote_count": votes.get(row.id, 0),
            "has_voted": row.id in own_votes,
            "is_following": follows,
            "unread_count": unread.get(row.id, 0),
            "is_overdue": bool(row.due_at and utc(row.due_at) < now() and row.status != "fixed"),
            **{field: getattr(row, field) for field in STRUCTURED},
        }
    return result


def watch(db, row, subject, enabled=True, *, explicit=True):
    # SessionLocal disables autoflush. An explicit claim and the activity recorder
    # can subscribe the same actor before either watch has been persisted.
    state = next(
        (
            pending
            for pending in db.new
            if isinstance(pending, FeedbackWatch)
            and pending.feedback_id == row.id
            and pending.subject == subject
        ),
        None,
    )
    if state is None:
        state = db.get(FeedbackWatch, (row.id, subject))
    if state is None:
        db.add(FeedbackWatch(feedback_id=row.id, subject=subject, enabled=enabled))
    elif explicit:
        state.enabled = enabled


def notify(db, row, activity, claims):
    db.flush()
    watches = {
        state.subject: state.enabled
        for state in db.scalars(select(FeedbackWatch).where(FeedbackWatch.feedback_id == row.id))
    }
    recipients = {row.author_id, row.assignee_id} | {
        subject for subject, enabled in watches.items() if enabled
    }
    for subject in recipients - {None, claims["sub"]}:
        if watches.get(subject) is False:
            continue
        db.add(
            FeedbackNotice(
                id=uuid4().hex,
                feedback_id=row.id,
                activity_id=activity.id,
                issuer=row.issuer,
                subject=subject,
                kind=activity.kind,
                body=activity.body[:500] or "处理进展已更新",
            )
        )


def record(db, row, activity, claims):
    row.revision += 1
    db.add(activity)
    watch(db, row, claims["sub"], explicit=False)
    notify(db, row, activity, claims)


def snapshot(row):
    return {
        "description": row.description,
        "application": row.application,
        "category": row.category,
        **{field: getattr(row, field) for field in STRUCTURED},
        "images": [image.id for image in row.images if not image.archived],
    }


def expected_revision(row, payload):
    if (
        getattr(payload, "expected_revision", None) is not None
        and row.revision != payload.expected_revision
    ):
        raise HTTPException(409, "反馈已被其他人更新，请刷新后重试，当前输入已保留")


def change_status(
    row,
    claims,
    target,
    *,
    note="",
    resolution=None,
    verification_steps=None,
    release_version=None,
    legacy=False,
):
    if target not in STATUSES:
        raise HTTPException(422, "无效的处理状态")
    if legacy and row.workflow_version == 1 and target in {"open", "in_progress", "fixed"}:
        return
    if target == "fixed":
        if row.author_id != claims["sub"]:
            raise HTTPException(403, "仅反馈提交人可以确认验证通过")
        if row.status != "released":
            raise HTTPException(409, "请先发布修复，再由提交人验证确认")
    else:
        require_manage(row, claims)
    if row.workflow_version == 2 and target != row.status:
        allowed = {
            "open": {"in_progress"},
            "in_progress": {"open", "ready"},
            "ready": {"in_progress", "released"},
            "released": {"in_progress", "fixed"},
            "fixed": {"in_progress"},
        }
        if target not in allowed.get(row.status, set()):
            raise HTTPException(409, "请按处理、待发布、待验证的顺序更新状态")
    if row.status in {"released", "fixed"} and target == "in_progress" and not note.strip():
        raise HTTPException(422, "请填写验证未通过或重新打开的原因")
    values = {
        "resolution": resolution,
        "verification_steps": verification_steps,
        "release_version": release_version,
    }
    resolved = {
        key: value if value is not None else getattr(row, key) for key, value in values.items()
    }
    if target in {"ready", "released"} and (
        not resolved["resolution"].strip() or not resolved["verification_steps"].strip()
    ):
        raise HTTPException(422, "请填写修复说明和验证步骤")
    if target == "released" and not resolved["release_version"].strip():
        raise HTTPException(422, "请填写发布版本")
    for key, value in resolved.items():
        setattr(row, key, value)
    if target == "fixed":
        row.resolved_at = now()
    elif target != row.status:
        row.resolved_at = None


def mark_read(db, row, claims):
    state = db.get(FeedbackRead, (row.id, claims["sub"]))
    stamp = now()
    if state is None:
        db.add(FeedbackRead(feedback_id=row.id, subject=claims["sub"], read_at=stamp))
    else:
        state.read_at = stamp
    for notice in db.scalars(
        select(FeedbackNotice).where(
            FeedbackNotice.feedback_id == row.id,
            FeedbackNotice.subject == claims["sub"],
            FeedbackNotice.issuer == claims["iss"],
            FeedbackNotice.read_at.is_(None),
        )
    ):
        notice.read_at = stamp
