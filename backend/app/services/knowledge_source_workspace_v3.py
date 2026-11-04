"""Personal research workspace; dynamic collections never duplicate library files."""

import hashlib
import json
import re
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError

from app.services.information.store import identity_key, iso
from app.services.knowledge_source_folders import organize_papers

READING_STATES = {"unread", "reading", "done", "later"}
QUERY_KEYS = {
    "text",
    "sourceIds",
    "folderIds",
    "scopes",
    "types",
    "readingStates",
    "updatedOnly",
    "tags",
}


def _owner_key(store, subject):
    return store.key("ks_workspace", identity_key(subject))


def workspace(store, subject):
    return store.get("ks_workspace", _owner_key(store, subject), required=False) or {
        "id": _owner_key(store, subject),
        "subject": subject,
        "revision": 0,
        "collections": [],
        "rules": [],
        "location": {},
    }


def public_workspace(store, subject):
    value = workspace(store, subject)
    readings = {}
    for row in store.records("ks_reading"):
        if row.get("subject") != subject:
            continue
        item = {key: val for key, val in row.items() if key not in {"id", "subject", "paperId"}}
        readings[row["paperId"]] = item
        if row.get("versionId"):
            readings["archive:" + row["versionId"]] = item
    return {
        "revision": value["revision"],
        "collections": value["collections"],
        "rules": value["rules"],
        "location": (
            store.get(
                "ks_location", store.key("ks_location", identity_key(subject)), required=False
            )
            or {}
        ).get("location", value["location"]),
        "reading": readings,
    }


def _save(store, subject, value, expected=None):
    ident = _owner_key(store, subject)
    old = store.get("ks_workspace", ident, required=False)
    if old:
        old = store.lock("ks_workspace", ident)
    expected = value["revision"] if expected is None else expected
    if (old or {"revision": 0})["revision"] != expected:
        raise HTTPException(409, "个人工作区已在其他窗口更新，请刷新后重试")
    value = {
        **value,
        "id": ident,
        "subject": subject,
        "revision": (old or {"revision": 0})["revision"] + 1,
        "updatedAt": iso(),
    }
    try:
        with store.db.begin_nested():
            store.put("ks_workspace", value)
    except IntegrityError:
        raise HTTPException(409, "个人工作区同时发生修改，请刷新后重试") from None
    store.db.commit()
    return public_workspace(store, subject)


def validate_query(query):
    if not isinstance(query, dict) or not set(query) <= QUERY_KEYS:
        raise HTTPException(422, "筛选条件格式不正确")
    result = {}
    for key, value in query.items():
        if key == "text":
            if not isinstance(value, str) or len(value) > 500:
                raise HTTPException(422, "关键词最多 500 字")
            if value.strip():
                result[key] = value.strip()
        elif key == "updatedOnly":
            if not isinstance(value, bool):
                raise HTTPException(422, "更新筛选须为布尔值")
            result[key] = value
        else:
            if (
                not isinstance(value, list)
                or len(value) > 100
                or any(not isinstance(item, str) or not 0 < len(item) <= 1100 for item in value)
            ):
                raise HTTPException(422, "筛选项超出范围")
            if key == "readingStates" and not set(value) <= READING_STATES:
                raise HTTPException(422, "阅读状态不正确")
            if value:
                result[key] = sorted(set(value))
    return result


def save_collection(store, subject, body):
    state = workspace(store, subject)
    ident = body.get("id") or uuid4().hex
    if body.get("id") and not any(item["id"] == ident for item in state["collections"]):
        raise HTTPException(404, "智能集合不存在")
    items = [item for item in state["collections"] if item["id"] != ident]
    if not body.get("deleted"):
        if len(items) >= 100:
            raise HTTPException(422, "最多保存 100 个智能集合")
        items.append(
            {
                "id": ident,
                "name": body["name"].strip(),
                "query": validate_query(body.get("query", {})),
                "updatedAt": iso(),
            }
        )
    state["collections"] = items
    return _save(store, subject, state, body.get("revision"))


def save_rule(store, subject, body, folders):
    state = workspace(store, subject)
    ident = body.get("id") or uuid4().hex
    if body.get("id") and not any(item["id"] == ident for item in state["rules"]):
        raise HTTPException(404, "归档规则不存在")
    items = [item for item in state["rules"] if item["id"] != ident]
    if not body.get("deleted"):
        target = set(body["targetFolderIds"])
        if not target or not target <= {item["id"] for item in folders}:
            raise HTTPException(409, "请选择仍存在的目标文件夹")
        query = validate_query(body.get("query", {}))
        if not any(bool(value) for value in query.values()):
            raise HTTPException(422, "自动归档须设置至少一项匹配条件")
        if len(items) >= 50:
            raise HTTPException(422, "最多保存 50 条归档规则")
        prior = next((item for item in state["rules"] if item["id"] == ident), {})
        enabled = bool(body.get("enabled", False))
        enabled_at = (
            (
                prior.get("enabledAt") or prior.get("createdAt")
                if prior.get("enabled")
                and prior.get("query") == query
                and set(prior.get("targetFolderIds", [])) == target
                else iso()
            )
            if enabled
            else None
        )
        items.append(
            {
                "id": ident,
                "name": body["name"].strip(),
                "query": query,
                "targetFolderIds": sorted(target),
                "enabled": enabled,
                "enabledAt": enabled_at,
                "createdAt": prior.get("createdAt") or iso(),
                "updatedAt": iso(),
            }
        )
    state["rules"] = items
    return _save(store, subject, state, body.get("revision"))


def save_reading(store, subject, body, papers):
    paper = next((item for item in papers if item["id"] == body["paperId"]), None)
    if paper is None:
        raise HTTPException(404, "论文已删除或无权访问")
    version = body.get("versionId") or paper.get("versionId")
    if version and version != paper.get("versionId"):
        raise HTTPException(409, "阅读版本已变化，请重新打开该版本")
    if body["state"] not in READING_STATES:
        raise HTTPException(422, "阅读状态不正确")
    identity = identity_key(subject)
    # The immutable original keeps its reading row when an archive becomes a Core
    # paper. The client still sees both its current path and archive alias.
    ident = store.key(
        "ks_reading", identity + ":" + ("version:" + version if version else body["paperId"])
    )
    legacy = [store.key("ks_reading", identity + ":" + body["paperId"])]
    if version:
        legacy.append(store.key("ks_reading", identity + ":archive:" + version))
    automatic = body.get("automatic", False)
    for attempt in range(1 if automatic else 2):
        try:
            with store.db.begin_nested():
                prior = store.get("ks_reading", ident, required=False)
                if prior:
                    prior = store.lock("ks_reading", ident)
                else:
                    older = [
                        entry
                        for key in legacy
                        if (entry := store.get("ks_reading", key, required=False))
                    ]
                    prior = max(older, key=lambda entry: entry.get("updatedAt", ""), default=None)
                    if prior:
                        prior = store.lock("ks_reading", prior["id"])
                version_changed = bool(
                    prior and version and prior.get("versionId") and prior["versionId"] != version
                )
                if automatic:
                    expected = body.get("expectedUpdatedAt")
                    if prior and not version_changed and prior.get("updatedAt") != expected:
                        raise HTTPException(
                            409, "阅读状态已在其他操作中更新，旧自动进度未覆盖当前状态"
                        )
                    if not prior and expected is not None:
                        raise HTTPException(409, "阅读状态已变化，请刷新后继续")
                value = {
                    "id": ident,
                    "subject": subject,
                    "paperId": body["paperId"],
                    "state": body["state"],
                    "position": body.get("position", {}),
                    "versionId": version,
                    "updatedAt": iso(),
                    "startedAt": (prior or {}).get("startedAt") if not version_changed else None,
                    "finishedAt": iso() if body["state"] == "done" else None,
                }
                if not value["startedAt"] and body["state"] == "reading":
                    value["startedAt"] = iso()
                store.put("ks_reading", value)
            store.db.commit()
            return {key: val for key, val in value.items() if key not in {"id", "subject"}}
        except IntegrityError:
            store.db.rollback()
            if automatic or attempt:
                raise HTTPException(409, "阅读状态同时发生修改，请刷新后重试") from None
    raise HTTPException(409, "阅读状态同时发生修改，请刷新后重试")


def save_location(store, subject, body):
    # Scroll/return history is independent of the collection revision, so a reader
    # saving progress cannot make a concurrent collection edit stale.
    store.put(
        "ks_location",
        {
            "id": store.key("ks_location", identity_key(subject)),
            "subject": subject,
            "location": {**body, "updatedAt": iso()},
        },
    )
    store.db.commit()
    return public_workspace(store, subject)


def reading_for(paper, entries):
    entry = entries.get(paper["id"])
    if paper.get("versionId") and (not entry or entry.get("versionId") != paper["versionId"]):
        entry = entries.get("archive:" + paper["versionId"]) or entry
    if (
        entry
        and entry.get("versionId")
        and paper.get("versionId")
        and entry["versionId"] != paper["versionId"]
    ):
        return {"state": "unread", "position": {}, "previousVersionRead": True}
    return entry or {"state": "unread", "position": {}}


def matches(paper, query, reading=None, documents=None):
    query = validate_query(query)
    doc = (documents or {}).get(paper.get("documentId"), {})
    metadata = paper.get("metadata") or {}
    tags = {
        str(tag.get("id") or tag.get("name")) if isinstance(tag, dict) else str(tag)
        for tag in paper.get("tags", [])
    }
    if query.get("text"):
        text = " ".join(
            str(value)
            for value in [
                paper.get("title", ""),
                paper.get("code", ""),
                paper.get("sourceName", ""),
                metadata.get("abstract", ""),
                metadata.get("doi", ""),
                " ".join(tags),
            ]
        ).casefold()
        if not all(word.casefold() in text for word in query["text"].split()):
            return False
    if query.get("sourceIds") and paper.get("sourceId") not in query["sourceIds"]:
        return False
    if query.get("folderIds") and not set(query["folderIds"]) & set(paper.get("folderIds", [])):
        return False
    if query.get("scopes") and not set(query["scopes"]) & set(
        doc.get("scopes", paper.get("scopes", []))
    ):
        return False
    if query.get("types") and paper.get("type") not in query["types"]:
        return False
    if query.get("tags") and not set(query["tags"]) <= tags:
        return False
    if (
        query.get("readingStates")
        and reading_for(paper, reading or {}).get("state", "unread") not in query["readingStates"]
    ):
        return False
    return not query.get("updatedOnly") or paper.get("versionStatus") == "update_available"


def matched_papers(store, subject, query, papers):
    reading = public_workspace(store, subject)["reading"]
    docs = {item["id"]: item for item in store.documents()}
    return [paper for paper in papers if matches(paper, query, reading, docs)]


def rule_preview(store, subject, rule_id, papers):
    rule = next(
        (item for item in workspace(store, subject)["rules"] if item["id"] == rule_id), None
    )
    if not rule:
        raise HTTPException(404, "归档规则不存在")
    found = matched_papers(store, subject, rule["query"], papers)
    changes = [
        item for item in found if not set(rule["targetFolderIds"]) <= set(item.get("folderIds", []))
    ]
    return {
        "rule": rule,
        "total": len(found),
        "changeCount": len(changes),
        "papers": [{"id": item["id"], "title": item["title"]} for item in changes[:100]],
        "paperIds": [item["id"] for item in changes],
        "previewDigest": hashlib.sha256(
            json.dumps(
                {
                    "rule": {key: rule[key] for key in ("id", "query", "targetFolderIds")},
                    "papers": [(item["id"], item.get("folderIds", [])) for item in changes],
                },
                sort_keys=True,
            ).encode()
        ).hexdigest(),
    }


def apply_rule(
    store, actor, rule_id, *, catalogue, papers, connect, preview_digest=None, paper_ids=None
):
    preview = rule_preview(store, actor["subject"], rule_id, papers)
    if preview_digest and preview_digest != preview["previewDigest"]:
        raise HTTPException(409, "匹配结果已变化，请重新预览")
    ids = preview["paperIds"]
    if paper_ids is not None:
        ids = [ident for ident in ids if ident in set(paper_ids)]
    if not ids:
        return {"saved": True, "count": 0, "revision": catalogue["revision"], "undoToken": None}
    tokens = []
    processed = 0
    revision = catalogue["revision"]
    for offset in range(0, len(ids), 500):
        try:
            result = organize_papers(
                store,
                actor,
                {
                    "paperIds": ids[offset : offset + 500],
                    "folderIds": preview["rule"]["targetFolderIds"],
                    "mode": "add",
                    "revision": revision,
                },
                catalogue={**catalogue, "revision": revision},
                papers=papers,
                connect=connect,
            )
        except Exception as exc:
            if not processed:
                raise
            return {
                "saved": False,
                "partial": True,
                "count": processed,
                "total": len(ids),
                "revision": revision,
                "undoTokens": tokens,
                "error": str(exc.detail)
                if isinstance(exc, HTTPException)
                else "归档服务暂不可用，请刷新后重试",
            }
        processed += len(ids[offset : offset + 500])
        revision = result["revision"]
        tokens.append(result["undoToken"])
    return {
        "saved": True,
        "partial": False,
        "count": processed,
        "revision": revision,
        "undoTokens": tokens,
    }


def apply_enabled_rules(store, actor, *, catalogue, papers, connect, paper_ids):
    """Worker hook: only the initiating user's opted-in rules and just-saved files."""
    aliases = set(paper_ids)
    paper_ids = [
        paper["id"]
        for paper in papers
        if paper["id"] in aliases
        or paper.get("versionId")
        and "archive:" + paper["versionId"] in aliases
    ]
    results = []
    for rule in workspace(store, actor["subject"])["rules"]:
        if not rule.get("enabled"):
            continue
        cutoff = rule.get("enabledAt") or rule.get("createdAt", "")
        fresh_ids = [
            paper["id"]
            for paper in papers
            if paper["id"] in paper_ids and paper.get("createdAt", "") >= cutoff
        ]
        try:
            result = apply_rule(
                store,
                actor,
                rule["id"],
                catalogue=catalogue,
                papers=papers,
                connect=connect,
                paper_ids=fresh_ids,
            )
        except Exception as exc:
            result = {
                "saved": False,
                "count": 0,
                "revision": catalogue["revision"],
                "undoTokens": [],
                "error": str(exc.detail)
                if isinstance(exc, HTTPException)
                else "归档服务暂不可用，请刷新后重试",
            }
        results.append({"ruleId": rule["id"], **result})
        if not result["saved"]:
            break
        catalogue = {**catalogue, "revision": result["revision"]}
        # Later rules see additions from earlier rules without discarding other folders.
        targets = set(rule["targetFolderIds"])
        selected = set(fresh_ids)
        papers = [
            {**paper, "folderIds": sorted(set(paper.get("folderIds", [])) | targets)}
            if paper["id"] in selected
            and matches(
                paper,
                rule["query"],
                public_workspace(store, actor["subject"])["reading"],
                {item["id"]: item for item in store.documents()},
            )
            else paper
            for paper in papers
        ]
    return results


def duplicate_candidates(papers):
    groups = {}
    for paper in papers:
        metadata = paper.get("metadata") or {}
        doi = re.sub(
            r"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)",
            "",
            str(metadata.get("doi", "")).strip(),
            flags=re.I,
        ).casefold()
        fingerprint = paper.get("sha256") or paper.get("hash")
        title = re.sub(r"[^\w]", "", str(paper.get("title", "")).casefold())
        for reason, value in [
            ("同一 DOI", doi),
            ("相同原件摘要" if paper.get("sha256") else "相同正文摘要", fingerprint),
            ("相似标题，需人工核对", title if len(title) >= 12 else ""),
        ]:
            if value:
                groups.setdefault((reason, value), []).append(paper)
    result = []
    seen = set()
    for (reason, _), rows in groups.items():
        ids = tuple(sorted({row["id"] for row in rows}))
        if len(ids) < 2 or ids in seen:
            continue
        seen.add(ids)
        documents = {row.get("documentId") for row in rows if row.get("documentId")}
        result.append(
            {
                "id": hashlib.sha256("|".join(ids).encode()).hexdigest()[:24],
                "reason": reason,
                "sameDocumentVersions": len(documents) == 1
                and all(row.get("documentId") for row in rows),
                "papers": [
                    {
                        key: row.get(key)
                        for key in (
                            "id",
                            "title",
                            "versionId",
                            "documentId",
                            "createdAt",
                            "folderIds",
                            "sourceName",
                        )
                    }
                    for row in rows
                ],
                "automaticMerge": False,
            }
        )
    return {"groups": result[:100], "total": len(result), "generatedAt": iso()}


def query_constraints(store, actor, collection_id=None, reading_status=None):
    """Return the criteria; the library applies residual filters before pagination."""
    query = {}
    if collection_id:
        collection = next(
            (
                item
                for item in workspace(store, actor["subject"])["collections"]
                if item["id"] == collection_id
            ),
            None,
        )
        if collection is None:
            raise HTTPException(404, "智能集合不存在")
        query = collection["query"]
    if reading_status and reading_status not in READING_STATES:
        raise HTTPException(422, "阅读状态不正确")
    result = {"workspaceQuery": query, "readingStatus": reading_status}
    for source, target in (("text", "query"), ("folderIds", "folderIds"), ("tags", "tags")):
        if query.get(source):
            result[target] = query[source]
    if len(query.get("types", [])) == 1:
        result["type"] = query["types"][0]
    return result


def filter_workspace_papers(
    store, actor, papers, collection_id=None, reading_status=None, *, text_already_matched=False
):
    constraints = query_constraints(store, actor, collection_id, reading_status)
    query = dict(constraints["workspaceQuery"])
    if text_already_matched:
        query.pop("text", None)
    if reading_status:
        query["readingStates"] = [reading_status]
    return matched_papers(store, actor["subject"], query, papers)
