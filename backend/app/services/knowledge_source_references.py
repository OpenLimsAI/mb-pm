"""Transfer only saved, owner-authorized public citations into the shared catalogue."""

import time

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.models.assistant import AssistantMessage, AssistantTask
from app.models.information import InformationEntry
from app.models.solution import KnowledgeSolution, SolutionAnswer, SolutionTopic
from app.services.information.store import iso
from app.services.reference_download import reference_url

CATEGORIES = {"solutions": "研究报告参考资料", "assistant": "个人AI助手参考资料"}
LEGACY_CATEGORIES = {"solutions": "研究报告参考论文", "assistant": "个人AI助手参考论文"}


def saved_reference(db, claims, body):
    if body.origin_app == "solutions":
        report = db.scalar(
            select(KnowledgeSolution).where(
                KnowledgeSolution.id == body.origin_id,
                KnowledgeSolution.issuer == claims["iss"],
                KnowledgeSolution.owner_id == claims["sub"],
                KnowledgeSolution.deleted_at.is_(None),
            )
        )
        answer = (
            db.scalar(
                select(SolutionAnswer).where(
                    SolutionAnswer.id == body.answer_id,
                    SolutionAnswer.solution_id == body.origin_id,
                    SolutionAnswer.issuer == claims["iss"],
                    SolutionAnswer.owner_id == claims["sub"],
                )
            )
            if report
            else None
        )
        if answer and answer.conversation_id:
            topic = db.get(SolutionTopic, (report.id, answer.conversation_id))
            if topic and topic.deleted:
                answer = None
    else:
        task = db.scalar(
            select(AssistantTask).where(
                AssistantTask.id == body.origin_id,
                AssistantTask.issuer == claims["iss"],
                AssistantTask.owner_id == claims["sub"],
                AssistantTask.deleted_at.is_(None),
            )
        )
        answer = (
            db.scalar(
                select(AssistantMessage).where(
                    AssistantMessage.id == body.answer_id,
                    AssistantMessage.task_id == body.origin_id,
                    AssistantMessage.role == "assistant",
                )
            )
            if task
            else None
        )
    if answer is None:
        raise HTTPException(404, "原回答不存在或无权访问，请从本人已保存的回答选择参考资料")
    ref = next(
        (
            item
            for item in answer.web_references
            if isinstance(item, dict) and item.get("id") == body.reference_id
        ),
        None,
    )
    if not ref or not isinstance(ref.get("title"), str) or not ref["title"].strip():
        raise HTTPException(404, "参考资料来源不存在，请重新选择")
    try:
        url = reference_url(ref.get("url"))
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None
    return {
        "title": ref["title"].strip()[:1000],
        "url": url,
        "publishedAt": str(ref.get("published_at") or "")[:40],
    }


def ensure_reference(store, body, ref):
    source_id = store.key("source", "references:" + body.origin_app)
    source = store.get("source", source_id, required=False)
    if source is None:
        source = {
            "id": source_id,
            "name": CATEGORIES[body.origin_app],
            "adapter": "reference",
            "url": "/solutions" if body.origin_app == "solutions" else "/assistant",
            "scopes": [],
            "folderId": None,
            "enabled": False,
            "status": "ok",
            "scopeStatus": {},
            "baselineScopes": [],
            "frequency": "manual",
            "knowledgeSourceAutoIndex": True,
            "originApp": body.origin_app,
        }
        try:
            with store.db.begin_nested():
                # Insert, never upsert: a concurrent first import may already have
                # assigned this category a folder, which must not be reset to null.
                store.db.add(
                    InformationEntry(
                        id=source_id,
                        tenant=store.tenant,
                        kind="source",
                        data=source,
                        updated_at=time.time(),
                    )
                )
                store.db.flush()
        except IntegrityError:
            source = store.get("source", source_id)
    # Serialize concurrent imports within each category before creating a document/job.
    source = store.lock("source", source_id)
    ident = store.key("document", "reference:" + body.origin_app + ":" + ref["url"])
    document = store.get("document", ident, required=False)
    existing = document is not None
    if document is None:
        document = {
            "id": ident,
            "key": ident,
            "sourceId": source_id,
            "title": ref["title"],
            "url": ref["url"],
            "scopes": [],
            "format": "待核验",
            "language": "来源未标注",
            "documentType": "参考资料",
            "officialStatus": "",
            "officialDate": ref["publishedAt"],
            "description": "",
            "status": "discovered",
            "error": None,
            "downloadStatus": "not_requested",
            "discoveredAt": iso(),
            "firstNewAt": iso(),
            "newInScopes": [],
            "originApp": body.origin_app,
        }
        store.put("document", document)
    return source, document, existing
