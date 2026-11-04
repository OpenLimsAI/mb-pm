"""Personal watches, actionable grouped updates, deterministic body diff and usage links."""

import difflib
import json
import re
from collections import defaultdict
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import select

from app.models.note import PersonalNote
from app.models.solution import KnowledgeSolution
from app.services.information.store import iso


def watches(store, subject):
    return store.preferences(subject).get("knowledgeSourceWatchesV3", [])


def save_watch(store, subject, body):
    if not body.get("name", "").strip():
        raise HTTPException(400, "请填写关注名称")
    items = watches(store, subject)
    ident = body.get("id") or str(uuid4())
    current = next((w for w in items if w["id"] == ident), None)
    if body.get("delete"):
        if current is None:
            raise HTTPException(404, "关注规则不存在")
        items = [w for w in items if w["id"] != ident]
    else:
        if len(items) >= 50 and current is None:
            raise HTTPException(400, "最多保存 50 条个人关注规则")
        item = {
            "id": ident,
            "name": body["name"].strip(),
            "sourceIds": list(dict.fromkeys(body.get("sourceIds", []))),
            "keywords": body.get("keywords", "").strip(),
            "codes": body.get("codes", "").strip(),
            "kinds": list(dict.fromkeys(body.get("kinds", []))),
            "muted": body.get("muted", False),
            "updatedAt": iso(),
        }
        items = [w for w in items if w["id"] != ident] + [item]
    store.save_preferences(subject, {"knowledgeSourceWatchesV3": items})
    return {"items": items}


def matches(watch, event, document):
    if watch.get("muted"):
        return False
    if watch.get("sourceIds") and event.get("sourceId") not in watch["sourceIds"]:
        return False
    if watch.get("kinds") and event.get("kind") not in watch["kinds"]:
        return False
    text = " ".join(
        str(x or "")
        for x in [event.get("title"), document.get("code"), document.get("description")]
    ).casefold()
    if watch.get("keywords") and not all(
        token.casefold() in text for token in watch["keywords"].split()
    ):
        return False
    codes = [code.upper() for code in re.split(r"[，,;；\s]+", watch.get("codes", "")) if code]
    if codes:
        identifier = (document.get("code", "") + " " + event.get("title", "")).upper()
        patterns = [
            r"(?<![A-Z0-9])"
            + re.escape(code)
            + (r"[A-Z]?" if re.fullmatch(r"[QSEM]\d+", code) else "")
            + r"(?:\([A-Z0-9]+\))?(?![A-Z0-9])"
            for code in codes
        ]
        if not any(re.search(pattern, identifier) for pattern in patterns):
            return False
    return True


def digest(store, subject, days=7):
    rules = watches(store, subject)
    documents = {d["id"]: d for d in store.documents()}
    cutoff = (datetime.now(UTC) - timedelta(days=days)).isoformat()
    read = store.preferences(subject).get("knowledgeSourceDigestReadV3", {})
    groups = defaultdict(list)
    for event in store.records("event"):
        if event.get("createdAt", "") < cutoff:
            continue
        matched = [
            w["id"] for w in rules if matches(w, event, documents.get(event.get("documentId"), {}))
        ]
        if not matched:
            continue
        day = event.get("createdAt", "")[:10]
        # No raw body or private document text in notification previews.
        groups[(day, event.get("sourceId", ""))].append(
            {
                "id": event["id"],
                "documentId": event.get("documentId"),
                "title": event.get("title", ""),
                "kind": event.get("kind", ""),
                "createdAt": event.get("createdAt"),
                "watchIds": matched,
                "read": event["id"] in read,
            }
        )
    items = [
        {
            "day": day,
            "sourceId": source,
            "count": len(events),
            "unread": sum(not e["read"] for e in events),
            "events": sorted(events, key=lambda e: e["createdAt"] or "", reverse=True),
        }
        for (day, source), events in groups.items()
    ]
    items.sort(key=lambda g: g["day"], reverse=True)
    return {
        "groups": items[:100],
        "watchCount": len(rules),
        "days": days,
        "delivery": "in_app",
        "truncated": len(items) > 100,
    }


def mark_digest_read(store, subject, event_ids):
    available = {e["id"] for e in store.records("event")}
    if not set(event_ids) <= available:
        raise HTTPException(404, "更新记录不存在")
    read = store.preferences(subject).get("knowledgeSourceDigestReadV3", {})
    for ident in event_ids:
        read[ident] = iso()
    if len(read) > 10000:
        read = dict(sorted(read.items(), key=lambda p: p[1])[-10000:])
    store.save_preferences(subject, {"knowledgeSourceDigestReadV3": read})
    return {"saved": True}


def body_diff(before, after, max_blocks=300):
    a, b = str(before.get("text") or ""), str(after.get("text") or "")
    if not a or not b:
        return {
            "available": False,
            "reason": "至少一个版本尚未完成正文提取，可先查看历史原件。",
            "blocks": [],
            "truncated": False,
        }
    # Limit both total input and block count so very large PDFs cannot stall a request.
    input_truncated = len(a) > 400000 or len(b) > 400000
    a_lines, b_lines = a[:400000].splitlines(), b[:400000].splitlines()
    input_truncated |= len(a_lines) > 4000 or len(b_lines) > 4000
    a_lines, b_lines = a_lines[:4000], b_lines[:4000]
    matcher = difflib.SequenceMatcher(None, a_lines, b_lines, autojunk=True)
    blocks = []
    changed = 0
    for kind, i, j, k, end in matcher.get_opcodes():
        if kind == "equal":
            continue
        changed += 1
        if len(blocks) < max_blocks:
            blocks.append(
                {
                    "kind": kind,
                    "beforeLine": i + 1,
                    "afterLine": k + 1,
                    "before": "\n".join(a_lines[i:j])[:12000],
                    "after": "\n".join(b_lines[k:end])[:12000],
                    "textTruncated": sum(len(x) for x in a_lines[i:j]) > 12000
                    or sum(len(x) for x in b_lines[k:end]) > 12000,
                }
            )
    return {
        "available": True,
        "blocks": blocks,
        "changeCount": changed,
        "truncated": input_truncated or changed > max_blocks,
        "basis": "已保存版本的提取正文；行号不是 PDF 页码",
        "beforeVersion": before["id"],
        "afterVersion": after["id"],
        "beforeSha256": before.get("sha256"),
        "afterSha256": after.get("sha256"),
    }


def usage_links(db, actor, document, versions, paper_ids):
    # Structural links/identifiers only. Title similarity must not imply a citation.
    needles = set(paper_ids)
    needles.update(v["id"] for v in versions)
    needles.update("/knowledge-sources/originals/" + v["id"] for v in versions)
    if document.get("url"):
        needles.add(document["url"])
    needles.add(document["id"])
    needles = {n for n in needles if len(n) >= 12}
    found = []
    notes = db.scalars(
        select(PersonalNote).where(
            PersonalNote.issuer == actor["issuer"],
            PersonalNote.owner_id == actor["subject"],
            PersonalNote.deleted_at.is_(None),
        )
    ).all()
    reports = db.scalars(
        select(KnowledgeSolution).where(
            KnowledgeSolution.issuer == actor["issuer"],
            KnowledgeSolution.owner_id == actor["subject"],
            KnowledgeSolution.deleted_at.is_(None),
        )
    ).all()
    for kind, rows in (("note", notes), ("report", reports)):
        for row in rows:
            payload = (
                row.content + " " + row.source_url
                if kind == "note"
                else json.dumps(
                    {"references": row.references, "sections": row.sections}, ensure_ascii=False
                )
            )
            matched = [value for value in needles if value in payload]
            if not matched:
                continue
            explicit_versions = [v["id"] for v in versions if v["id"] in payload]
            verified = [
                v
                for v in versions
                if v.get("sha256") and v["sha256"] == document.get("verifiedSha256")
            ]
            latest = (verified or versions)[-1]["id"] if versions else None
            found.append(
                {
                    "id": row.id,
                    "kind": kind,
                    "title": row.title,
                    "url": "/notes?note=" + row.id
                    if kind == "note"
                    else "/solutions?report=" + row.id,
                    "versionIds": explicit_versions,
                    "olderVersion": bool(explicit_versions and latest not in explicit_versions),
                    "versionUnknown": not bool(explicit_versions),
                }
            )
    return {
        "items": found[:200],
        "truncated": len(found) > 200,
        "scope": "本人有权访问且带明确资料链接或版本标识的笔记和报告；不按标题猜测引用",
    }
