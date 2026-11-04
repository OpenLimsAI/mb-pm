"""Explicit report grants and durable comments, using the existing event store.

Presence is a best-effort heartbeat, not a document lock. Report writes always
use the existing revision compare-and-swap, including writes by an invited editor.
Personal note snapshots are private to the actor who linked the note.
"""

import hashlib
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException
from fastapi.encoders import jsonable_encoder
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError

from app.models.note import PersonalNote
from app.models.solution import SolutionEvent
from app.services import solutions as core


def state_id(solution_id, action, subject):
    return hashlib.sha256(f"{solution_id}|{action}|{subject}".encode()).hexdigest()


def member(db, row, claims):
    event = db.get(SolutionEvent, state_id(row.id, "report_member", claims["sub"]))
    return event.details.get("role") if event else None


def can_edit(db, row, claims):
    return row.owner_id == claims["sub"] or member(db, row, claims) == "editor"


def check_edit(db, row, claims):
    if not can_edit(db, row, claims):
        raise HTTPException(403, "需要作者或受邀编辑权限")


def records(db, row, action):
    return list(
        db.scalars(
            select(SolutionEvent)
            .where(SolutionEvent.solution_id == row.id, SolutionEvent.action == action)
            .order_by(SolutionEvent.created_at, SolutionEvent.id)
        )
    )


def collaboration(db, row, claims):
    core.check_solution_evidence(db, row, claims)
    members = [{"id": row.owner_id, "name": row.owner_name, "role": "owner"}]
    members += [
        {"id": e.actor_id, "name": e.details["name"], "role": e.details["role"]}
        for e in records(db, row, "report_member")
        if e.details.get("role") in ("editor", "commenter")
    ]
    comments = [
        {
            "id": e.id,
            "actor_id": e.actor_id,
            "created_at": e.created_at,
            "revision": e.revision,
            **e.details,
        }
        for e in records(db, row, "report_comment")
    ]
    cutoff = datetime.now(UTC) - timedelta(seconds=75)
    presence = [
        {
            "actor_id": e.actor_id,
            "actor_name": e.details["actor_name"],
            "section_id": e.details["section_id"],
            "seen_at": e.created_at,
        }
        for e in records(db, row, "report_presence")
        if e.created_at.replace(tzinfo=UTC) > cutoff and any(m["id"] == e.actor_id for m in members)
    ]
    return jsonable_encoder(
        {
            "revision": row.revision,
            "can_manage": row.owner_id == claims["sub"],
            "members": members,
            "comments": comments,
            "presence": presence,
        }
    )


def upsert_state(db, row, claims, action, subject, details):
    ident = state_id(row.id, action, subject)
    existing = db.get(SolutionEvent, ident)
    if existing:
        existing.details = details
        existing.revision += 1
        existing.created_at = core.utcnow()
    else:
        try:
            with db.begin_nested():
                db.add(
                    SolutionEvent(
                        id=ident,
                        solution_id=row.id,
                        actor_id=subject,
                        action=action,
                        revision=1,
                        version=row.version,
                        details=details,
                        created_at=core.utcnow(),
                    )
                )
                db.flush()
        except IntegrityError as exc:
            raise HTTPException(409, "协作状态已更新，请重试") from exc
    db.commit()


def save_member(db, row, subject, payload, claims):
    if row.owner_id != claims["sub"]:
        raise HTTPException(403, "只有作者可以管理协作者")
    if subject == row.owner_id:
        raise HTTPException(422, "作者权限不可修改")
    known = next((m for m in core.reviewers(db, claims) if m["id"] == subject), None)
    if not known:
        raise HTTPException(422, "请选择同一组织中已登记的账号")
    upsert_state(
        db, row, claims, "report_member", subject, {"name": known["name"], "role": payload.role}
    )
    # Grants share report text and saved excerpts, never private AI conversations/library browsing.
    core.event(db, row, claims, "report_member_changed", {"subject": subject, "role": payload.role})
    db.commit()


def create_comment(db, row, payload, claims):
    core.check_solution_evidence(db, row, claims)
    if len(records(db, row, "report_comment")) >= 2000:
        raise HTTPException(422, "本报告批注数量已达上限")
    section = next((s for s in row.sections if s["id"] == payload.section_id), None)
    if not section:
        raise HTTPException(422, "章节不存在，请刷新后重新选择")
    if payload.quote and payload.quote not in section["content"]:
        # Rich text selections are rendered text; strip formatting before comparing.
        if core.visible_source_text(payload.quote) not in core.visible_source_text(
            section["content"]
        ):
            raise HTTPException(409, "选中文字已更新，请重新选择后批注")
    if payload.parent_id:
        parent = db.get(SolutionEvent, payload.parent_id)
        if (
            not parent
            or parent.solution_id != row.id
            or parent.action != "report_comment"
            or parent.details.get("parent_id")
            or parent.details["section_id"] != payload.section_id
        ):
            raise HTTPException(422, "批注线程不存在")
    core.event(
        db,
        row,
        claims,
        "report_comment",
        {
            "actor_name": core.actor_name(claims),
            "section_id": payload.section_id,
            "quote": payload.quote,
            "content": payload.content.strip(),
            "parent_id": payload.parent_id,
            "resolved": False,
        },
    )
    # Comment revision is independent of the report's content revision.
    db.flush()
    db.commit()


def resolve_comment(db, row, comment_id, payload, claims):
    core.check_solution_evidence(db, row, claims)
    comment = db.get(SolutionEvent, comment_id)
    if (
        not comment
        or comment.solution_id != row.id
        or comment.action != "report_comment"
        or comment.details.get("parent_id")
    ):
        raise HTTPException(404, "批注不存在")
    if (
        row.owner_id != claims["sub"]
        and comment.actor_id != claims["sub"]
        and not can_edit(db, row, claims)
    ):
        raise HTTPException(403, "只有作者、编辑或批注发起人可以处理此批注")
    result = db.execute(
        update(SolutionEvent)
        .where(SolutionEvent.id == comment.id, SolutionEvent.revision == payload.revision)
        .values(
            details={**comment.details, "resolved": payload.resolved}, revision=payload.revision + 1
        ),
        execution_options={"synchronize_session": False},
    )
    if result.rowcount != 1:
        db.rollback()
        raise HTTPException(409, "批注已更新，请刷新")
    db.commit()


def heartbeat(db, row, payload, claims):
    core.check_solution_evidence(db, row, claims)
    if payload.section_id not in {s["id"] for s in row.sections}:
        raise HTTPException(422, "章节不存在")
    upsert_state(
        db,
        row,
        claims,
        "report_presence",
        claims["sub"],
        {"actor_name": core.actor_name(claims), "section_id": payload.section_id},
    )
    return collaboration(db, row, claims)


def note_links(db, row, claims):
    core.check_solution_evidence(db, row, claims)
    return [
        {"id": e.id, **e.details}
        for e in records(db, row, "report_note_link")
        if e.actor_id == claims["sub"]
    ]


def link_note(db, row, payload, claims):
    if row.status != "draft":
        raise HTTPException(409, "仅草稿可更新笔记关联")
    check_edit(db, row, claims)
    note = db.scalar(
        select(PersonalNote)
        .where(
            PersonalNote.id == payload.note_id,
            PersonalNote.issuer == claims["iss"],
            PersonalNote.owner_id == claims["sub"],
            PersonalNote.deleted_at.is_(None),
        )
        .with_for_update()
    )
    if not note:
        raise HTTPException(404, "笔记不存在或无权访问")
    if payload.expected_revision is not None and note.revision != payload.expected_revision:
        raise HTTPException(409, "笔记已在其他页面更新，请重新比较后重试")
    section = next((s for s in row.sections if s["id"] == payload.section_id), None)
    if not section:
        raise HTTPException(422, "章节不存在")
    if note.content not in section["content"] and core.visible_source_text(
        note.content
    ) not in core.visible_source_text(section["content"]):
        raise HTTPException(409, "请先将笔记内容成功保存到报告，再更新来源关联")
    subject = f"{claims['sub']}|{payload.section_id}|{note.id}"
    ident = state_id(row.id, "report_note_link", subject)
    existing = db.get(SolutionEvent, ident)
    details = {
        "note_id": note.id,
        "section_id": payload.section_id,
        "note_title": note.title,
        "note_revision": note.revision,
        "content": note.content,
    }
    if existing:
        existing.details = details
        existing.revision += 1
    else:
        db.add(
            SolutionEvent(
                id=ident,
                solution_id=row.id,
                actor_id=claims["sub"],
                action="report_note_link",
                revision=1,
                version=row.version,
                details=details,
            )
        )
    db.commit()
    return {"id": ident, **details}
