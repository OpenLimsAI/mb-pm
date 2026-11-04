"""Owned report versions, outline templates, and persistent conversation organization."""

from datetime import UTC, datetime, timedelta

from fastapi import HTTPException
from fastapi.encoders import jsonable_encoder
from pydantic import ValidationError
from sqlalchemy import literal, or_, select, update
from sqlalchemy.exc import IntegrityError

from app.models.solution import (
    KnowledgeSolution,
    SolutionAnswer,
    SolutionEvent,
    SolutionTemplate,
    SolutionTopic,
    SolutionVersion,
)
from app.schemas.solution import SolutionInput
from app.services import solutions as core


def version_out(row):
    return jsonable_encoder(
        {
            key: getattr(row, key)
            for key in ("id", "version", "status", "created_at", "actor_name", "note", "snapshot")
        }
    )


def automatic_snapshot(db, row, claims, values):
    if all(
        values.get(key) == getattr(row, key)
        for key in ("title", "sections", "references", "formula")
    ):
        return
    latest = db.scalar(
        select(SolutionVersion)
        .where(SolutionVersion.solution_id == row.id, SolutionVersion.note == "自动保存前快照")
        .order_by(SolutionVersion.created_at.desc())
        .limit(1)
    )
    if latest and latest.created_at.replace(tzinfo=UTC) > datetime.now(UTC) - timedelta(minutes=5):
        return
    core.snapshot(db, row, claims, "自动保存前快照")


def manual_snapshot(db, row, payload, claims):
    core.check_solution_evidence(db, row, claims)
    # CAS closes the race with an autosave from another tab; callers receive the new revision.
    core.compare_and_swap(db, row, payload.revision, {})
    version = SolutionVersion(
        id=core.uid(),
        solution_id=row.id,
        version=row.version,
        status=row.status,
        actor_name=core.actor_name(claims),
        note=payload.name,
        snapshot=core.solution_out(row),
    )
    db.add(version)
    core.event(db, row, claims, "snapshot", {"name": payload.name})
    db.commit()
    return version_out(version)


def restore_section(db, row, version_id, payload, claims):
    if row.status != "draft":
        raise HTTPException(409, "仅草稿可恢复章节")
    core.check_solution_evidence(db, row, claims)
    previous = db.get(SolutionVersion, version_id)
    if not previous or previous.solution_id != row.id:
        raise HTTPException(404, "历史版本不存在")
    selected = next(
        (s for s in previous.snapshot["sections"] if s["id"] == payload.section_id), None
    )
    if not selected:
        raise HTTPException(404, "该版本中没有此章节")
    selected = dict(selected)
    ids = {s["id"] for s in row.sections}
    if selected.get("parent_id") not in ids:
        selected["parent_id"] = None
    sections = [selected if s["id"] == selected["id"] else s for s in row.sections]
    if selected["id"] not in ids:
        sections.append(selected)
    restored_refs = [
        r for r in previous.snapshot["references"] if r["section_id"] == selected["id"]
    ]
    refs = [r for r in row.references if r["section_id"] != selected["id"]] + restored_refs
    valid_ids = {r["id"] for r in refs}
    formula = [
        {
            **f,
            "evidence_ids": [i for i in f["evidence_ids"] if i in valid_ids],
            "verification": "pending" if set(f["evidence_ids"]) - valid_ids else f["verification"],
        }
        for f in row.formula
    ]
    try:
        values = SolutionInput.model_validate(
            {
                **{key: getattr(row, key) for key in SolutionInput.model_fields},
                "sections": sections,
                "references": refs,
                "formula": formula,
            }
        ).model_dump()
    except ValidationError as exc:
        raise HTTPException(422, "恢复后的章节结构无效，请先调整父级或章节数量") from exc
    core.check_references(db, refs, claims, existing=row.references + restored_refs)
    core.snapshot(db, row, claims, "恢复章节前快照")
    values["requires_kb"] = row.requires_kb or any(r["source_id"].startswith("kb:") for r in refs)
    core.compare_and_swap(db, row, payload.revision, values)
    core.event(
        db, row, claims, "restore_section", {"version_id": version_id, "section_id": selected["id"]}
    )
    db.commit()
    return core.solution_out(row, claims)


def template_sharing(db, template_id, claims):
    return db.scalar(
        select(SolutionEvent)
        .join(KnowledgeSolution, KnowledgeSolution.id == SolutionEvent.solution_id)
        .where(
            SolutionEvent.id == "template-share-" + template_id,
            SolutionEvent.action == "template_shared",
            KnowledgeSolution.issuer == claims["iss"],
            KnowledgeSolution.deleted_at.is_(None),
            SolutionEvent.actor_id == KnowledgeSolution.owner_id,
        )
    )


def template_out(db, row, claims, sharing=None):
    sharing = sharing or template_sharing(db, row.id, claims)
    return jsonable_encoder(
        {
            **{key: getattr(row, key) for key in ("id", "name", "sections", "created_at")},
            "shared": bool(sharing and sharing.details.get("shared")),
            "source_solution_id": sharing.solution_id if sharing else None,
            "can_delete": row.owner_id == claims["sub"],
        }
    )


def templates(db, claims):
    result = []
    visible_share = (
        select(SolutionEvent.id)
        .join(KnowledgeSolution, KnowledgeSolution.id == SolutionEvent.solution_id)
        .where(
            SolutionEvent.id == literal("template-share-") + SolutionTemplate.id,
            SolutionEvent.action == "template_shared",
            SolutionEvent.actor_id == SolutionTemplate.owner_id,
            SolutionEvent.details["shared"].as_boolean().is_(True),
            KnowledgeSolution.owner_id == SolutionTemplate.owner_id,
            KnowledgeSolution.issuer == claims["iss"],
            KnowledgeSolution.deleted_at.is_(None),
        )
        .exists()
    )
    for row in db.scalars(
        select(SolutionTemplate)
        .where(
            SolutionTemplate.issuer == claims["iss"],
            or_(SolutionTemplate.owner_id == claims["sub"], visible_share),
        )
        .order_by(SolutionTemplate.created_at.desc())
    ):
        sharing = template_sharing(db, row.id, claims)
        if row.owner_id == claims["sub"] or (
            sharing and sharing.actor_id == row.owner_id and sharing.details.get("shared") is True
        ):
            result.append(template_out(db, row, claims, sharing))
    return result


def set_template_sharing(db, row, payload, claims):
    existing = db.get(SolutionEvent, "template-share-" + row.id)
    source_id = payload.source_solution_id or (existing.solution_id if existing else None)
    if payload.shared and not source_id:
        raise HTTPException(422, "请选择作者自己的来源报告后共享模板")
    if source_id:
        source = core.get_solution(db, source_id, claims, owner=True)
        details = {"template_id": row.id, "shared": payload.shared}
        if existing:
            existing.solution_id = source.id
            existing.details = details
        else:
            db.add(
                SolutionEvent(
                    id="template-share-" + row.id,
                    solution_id=source.id,
                    actor_id=claims["sub"],
                    action="template_shared",
                    revision=source.revision,
                    version=source.version,
                    details=details,
                )
            )


def create_template(db, payload, claims):
    own = list(
        db.scalars(
            select(SolutionTemplate).where(
                SolutionTemplate.issuer == claims["iss"], SolutionTemplate.owner_id == claims["sub"]
            )
        )
    )
    if len(own) >= 100:
        raise HTTPException(422, "最多保存100份模板，请先删除不再使用的模板")
    row = SolutionTemplate(
        id=core.uid(),
        issuer=claims["iss"],
        owner_id=claims["sub"],
        **payload.model_dump(exclude={"shared", "source_solution_id"}),
    )
    set_template_sharing(db, row, payload, claims)
    db.add(row)
    db.commit()
    return template_out(db, row, claims)


def share_template(db, ident, payload, claims):
    row = db.scalar(
        select(SolutionTemplate).where(
            SolutionTemplate.id == ident,
            SolutionTemplate.issuer == claims["iss"],
            SolutionTemplate.owner_id == claims["sub"],
        )
    )
    if not row:
        raise HTTPException(404, "模板不存在或不是模板作者")
    set_template_sharing(db, row, payload, claims)
    db.commit()
    return template_out(db, row, claims)


def delete_template(db, ident, claims):
    row = db.scalar(
        select(SolutionTemplate).where(
            SolutionTemplate.id == ident,
            SolutionTemplate.issuer == claims["iss"],
            SolutionTemplate.owner_id == claims["sub"],
        )
    )
    if not row:
        raise HTTPException(404, "模板不存在")
    db.delete(row)
    db.commit()


def topic_out(row):
    return {key: getattr(row, key) for key in ("id", "title", "archived", "revision")}


def topics(db, row, claims):
    core.check_solution_evidence(db, row, claims)
    metadata = {
        t.id: t
        for t in db.scalars(select(SolutionTopic).where(SolutionTopic.solution_id == row.id))
    }
    result = {ident: topic_out(t) for ident, t in metadata.items() if not t.deleted}
    for answer in db.scalars(
        select(SolutionAnswer)
        .where(
            SolutionAnswer.solution_id == row.id,
            SolutionAnswer.issuer == claims["iss"],
            SolutionAnswer.owner_id == claims["sub"],
        )
        .order_by(SolutionAnswer.created_at)
    ):
        ident = answer.conversation_id or answer.id
        if ident not in metadata and ident not in result:
            result[ident] = {
                "id": ident,
                "title": answer.question[:200],
                "archived": False,
                "revision": 0,
            }
    return list(result.values())


def change_topic(db, row, ident, payload, claims, *, delete=False):
    if (
        len(ident) > 80
        or not ident
        or not all(c.isascii() and (c.isalnum() or c in "_-") for c in ident)
    ):
        raise HTTPException(422, "对话标识不正确")
    core.check_solution_evidence(db, row, claims)
    existing = db.get(SolutionTopic, (row.id, ident))
    if existing and existing.deleted:
        raise HTTPException(404, "对话已删除")
    values = (
        {"deleted": True}
        if delete
        else {"title": payload.title.strip(), "archived": payload.archived}
    )
    if not existing:
        if payload.revision != 0:
            raise HTTPException(409, "对话已更新，请刷新")
        existing = SolutionTopic(solution_id=row.id, id=ident, revision=1, **values)
        try:
            with db.begin_nested():
                db.add(existing)
                db.flush()
        except IntegrityError as exc:
            raise HTTPException(409, "对话已更新，请刷新") from exc
    else:
        changed = db.execute(
            update(SolutionTopic)
            .where(
                SolutionTopic.solution_id == row.id,
                SolutionTopic.id == ident,
                SolutionTopic.revision == payload.revision,
                SolutionTopic.deleted.is_(False),
            )
            .values(**values, revision=payload.revision + 1),
            execution_options={"synchronize_session": False},
        )
        if changed.rowcount != 1:
            db.rollback()
            raise HTTPException(409, "对话已更新，请刷新")
        db.refresh(existing)
    core.event(db, row, claims, "delete_topic" if delete else "organize_topic", {"topic_id": ident})
    db.commit()
    return topic_out(existing)


def check_topic(db, solution_id, ident):
    if ident:
        # Refresh from DB even when the model request started before another tab deleted the topic.
        row = db.scalar(
            select(SolutionTopic)
            .where(SolutionTopic.solution_id == solution_id, SolutionTopic.id == ident)
            .execution_options(populate_existing=True)
        )
        if row and (row.deleted or row.archived):
            raise HTTPException(409, "对话已删除或归档，请新建对话后重试")


def visible_answers(db, rows):
    hidden = {
        (t.solution_id, t.id)
        for t in db.scalars(select(SolutionTopic).where(SolutionTopic.deleted.is_(True)))
    }
    return [a for a in rows if (a.solution_id, a.conversation_id or a.id) not in hidden]
