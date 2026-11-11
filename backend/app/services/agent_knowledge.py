"""Read-only Agent adapter for the subject-bound Knowledge Source bridge."""

import re
from urllib.parse import urlsplit

from fastapi import HTTPException

from app.api.v1.knowledge_sources import connected
from app.core.config import settings
from app.services import accounts
from app.services.iam_admin import IAMError
from app.services.solution_knowledge import _valid_path

HASH_PATTERN = r"^[a-f0-9]{64}$"


def check_access(subject: str) -> None:
    if not settings.KNOWLEDGE_SOURCE_APP_ENABLED:
        raise HTTPException(503, "知识库来源接口尚未启用")
    if not isinstance(subject, str) or not subject:
        raise HTTPException(403, "当前项目账号缺少已核验的统一身份")
    try:
        roles = accounts.live_roles(subject)
    except IAMError:
        raise HTTPException(503, "暂时无法确认知识库阅读权限，请稍后重试") from None
    if not roles & accounts.KB_ROLES:
        raise HTTPException(403, "当前账号没有知识库阅读权限")


def _text(value, limit):
    return value[:limit] if isinstance(value, str) else None


def _version(record):
    value = record.get("hash")
    return value if isinstance(value, str) and re.fullmatch(HASH_PATTERN, value) else None


def _link(value):
    if not isinstance(value, str) or len(value) > 4096 or "\\" in value:
        return None
    if any(c.isspace() or ord(c) < 32 for c in value):
        return None
    try:
        url = urlsplit(value)
        if (
            url.scheme in {"http", "https"}
            and url.hostname
            and url.username is None
            and url.password is None
        ):
            return value
    except ValueError:
        pass
    return None


def _source(record):
    path = record["path"]
    metadata = record.get("metadata")
    metadata = metadata if isinstance(metadata, dict) else {}
    source = record.get("source")
    source = source if isinstance(source, dict) else {}
    scopes = source.get("scopes")
    matches = record.get("matches")
    excerpt = None
    if isinstance(matches, list):
        excerpt = next(
            (
                item["text"][:600]
                for item in matches
                if isinstance(item, dict) and isinstance(item.get("text"), str)
            ),
            None,
        )
    return {
        "source_id": path,
        "title": _text(record.get("title"), 1000) or path.rsplit("/", 1)[-1][:-3],
        "version": _version(record),
        "url": _link(record.get("url")),
        "source_url": _link(metadata.get("sourceUrl") or source.get("sourceUrl")),
        "document_type": _text(metadata.get("documentType"), 100),
        "applicability": [item[:100] for item in scopes[:20] if isinstance(item, str)]
        if isinstance(scopes, list)
        else [],
        "updated_at": _text(record.get("updatedAt") or record.get("createdAt"), 80),
        "excerpt": excerpt or _text(metadata.get("abstract"), 600),
    }


def search(subject: str, query: str, offset: int, limit: int) -> dict:
    if not query.strip():
        raise HTTPException(422, "请输入知识库检索词")
    result = connected(
        "queryLibrary", subject, query=query.strip(), searchMode="all", offset=offset, limit=limit
    )
    papers = result.get("papers")
    if not isinstance(papers, list) or len(papers) > limit:
        raise HTTPException(502, "知识库检索结果格式异常")
    next_offset = result.get("nextOffset")
    if next_offset is not None and (type(next_offset) is not int or next_offset <= offset):
        raise HTTPException(502, "知识库分页结果格式异常")
    return {
        "items": [
            _source(paper)
            for paper in papers
            if isinstance(paper, dict) and _valid_path(paper.get("path"))
        ],
        "next_offset": next_offset,
        "incomplete": result.get("incomplete") is True,
    }


def read(subject: str, source_id: str, version: str | None, offset: int, limit: int) -> dict:
    if not _valid_path(source_id):
        raise HTTPException(422, "知识库来源标识无效")
    if offset > 0 and version is None:
        raise HTTPException(422, "继续读取时请带上首次返回的正文版本")
    result = connected("readPaper", subject, path=source_id, offset=offset, limit=limit)
    body, actual_offset, total = (result.get(key) for key in ("body", "offset", "totalLength"))
    current_version = _version(result)
    if (
        result.get("path") != source_id
        or not current_version
        or not isinstance(body, str)
        or type(actual_offset) is not int
        or type(total) is not int
        or not 0 <= actual_offset <= total
    ):
        raise HTTPException(502, "知识库原文结果格式异常")
    if version and current_version != version:
        raise HTTPException(409, "知识库原文版本已变化，请重新检索或从首段读取")
    # The bridge uses JavaScript offsets, keeping both ends on character boundaries.
    try:
        size = len(body.encode("utf-16-le")) // 2
    except UnicodeError:
        raise HTTPException(502, "知识库原文字码异常") from None
    end = actual_offset + size
    if size > limit + 1 or end > total or (end == actual_offset and end < total):
        raise HTTPException(502, "知识库原文分页结果格式异常")
    return {
        "source": _source(result),
        "text": body,
        "offset": actual_offset,
        "next_offset": end if end < total else None,
        "total_characters": total,
        "position_unit": "utf16",
    }
