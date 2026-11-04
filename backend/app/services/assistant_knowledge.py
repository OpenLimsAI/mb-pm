"""Read-only DIKW Agent tools, using the existing server-only Core connection.

Contract: OpenDIKW/dikw-web b415100, packages/web-server/src/agent/adkTools.ts.
No shell, user-supplied origin, maintenance or external web tools are exposed.
"""

import json
import unicodedata
from typing import Literal
from urllib.parse import quote

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.services import solution_knowledge as kb
from app.services.assistant_retrieval import rank_result


class Arguments(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Health(Arguments):
    pass


class Retrieve(Arguments):
    q: str = Field(min_length=1, max_length=1000)
    limit: int = Field(default=10, ge=1, le=20)


class ListPages(Arguments):
    layer: Literal["source", "knowledge", "wisdom", "all"] = "all"
    offset: int = Field(default=0, ge=0, le=100000)
    limit: int = Field(default=30, ge=1, le=50)


class ReadPage(Arguments):
    path: str = Field(min_length=1, max_length=1024)
    offset: int = Field(default=0, ge=0, le=500000)
    length: int = Field(default=8000, ge=1, le=12000)


class PageLinks(Arguments):
    path: str = Field(min_length=1, max_length=1024)
    direction: Literal["in", "out", "both"] = "both"
    limit: int = Field(default=30, ge=1, le=100)


class ListWisdom(Arguments):
    status: Literal["draft", "published", "favorite", "archived"] | None = None
    offset: int = Field(default=0, ge=0, le=100000)
    limit: int = Field(default=30, ge=1, le=50)


REGISTRY = {
    "dikw_health": (Health, "检查知识库 Core 是否可用，返回基本状态。"),
    "retrieve_knowledge": (
        Retrieve,
        "按问题检索知识库，返回相关段落和页面引用。可换关键词继续检索。",
    ),
    "list_pages": (
        ListPages,
        "按层列出有效页面并返回真实总数；offset/limit 分页，不将一页数量当成总数。",
    ),
    "read_page": (
        ReadPage,
        "读取指定页面原文。path 必须来自目录或检索结果；正文可用 offset/length 分段读取。",
    ),
    "page_links": (PageLinks, "查询页面的入链和出链，用于进一步阅读关联知识。"),
    "list_wisdom": (ListWisdom, "按 status 筛选智慧条目，分页查看。"),
}


def definitions():
    return [
        {
            "type": "function",
            "function": {
                "name": name,
                "description": description,
                "parameters": model.model_json_schema(),
            },
        }
        for name, (model, description) in REGISTRY.items()
    ]


def valid_path(path):
    return (
        isinstance(path, str)
        and len(path) <= 1024
        and path.startswith(("sources/", "knowledge/", "wisdom/"))
        and path.endswith(".md")
        and all(part not in {"", ".", ".."} for part in path.split("/"))
        and not any(unicodedata.category(c) in {"Cc", "Cs"} for c in path)
        and not any(c in path for c in ("%", "\\", "?", "#"))
    )


def metadata(row):
    if not isinstance(row, dict) or not valid_path(row.get("path")):
        return None
    layer = row.get("layer")
    if layer not in {"source", "knowledge", "wisdom"} or row.get("active") is False:
        return None
    expected = {"source": "sources", "knowledge": "knowledge", "wisdom": "wisdom"}[layer]
    if row["path"].split("/", 1)[0] != expected:
        return None
    return {
        "path": row["path"],
        "title": kb._string(row.get("title")) or row["path"],
        "layer": layer,
        "url": kb._configuration()[2] + "/",
    }


def page_slice(rows, offset, limit):
    return {
        "items": rows[offset : offset + limit],
        "total": len(rows),
        "offset": offset,
        "truncated": offset + limit < len(rows),
        "next_offset": offset + limit if offset + limit < len(rows) else None,
    }


def core_json(path, *, params=None):
    return kb._json(kb._request("GET", path, params=params))


def malformed():
    raise HTTPException(502, "知识库工具返回格式异常，请稍后重试")


def execute(claims, name, arguments):
    # Recheck live IAM for EVERY tool invocation, even within the same question.
    kb.check_access(claims)
    if name not in REGISTRY:
        return {"error": "未知或未授权的知识库查询工具"}
    try:
        data = REGISTRY[name][0].model_validate(arguments).model_dump()
    except ValidationError:
        return {"error": "工具参数无效，请按参数定义重试"}
    path = data.get("path")
    if path is not None and not valid_path(path):
        return {"error": "页面路径无效，只能读取知识库内的 Markdown 页面"}
    if name == "dikw_health":
        result = core_json("/v1/health")
        if not isinstance(result, dict):
            malformed()
        # Health responses can contain internal provider configuration. Never forward it.
        return {"reachable": True, "status": kb._string(result.get("status"), 80)}
    if name == "list_pages":
        params = {"active": "true"}
        if data["layer"] != "all":
            params["layer"] = data["layer"]
        records = core_json("/v1/base/pages", params=params)
        if not isinstance(records, list):
            malformed()
        by_path = {}
        for row in records:
            item = metadata(row)
            if item and row.get("active") is True and data["layer"] in {"all", item["layer"]}:
                by_path[item["path"]] = item
        return page_slice(
            sorted(by_path.values(), key=lambda x: x["path"]), data["offset"], data["limit"]
        )
    if name == "retrieve_knowledge":
        if not data["q"].strip():
            return {"error": "检索问题不能为空"}
        raw = kb._request("POST", "/v1/retrieve", payload={"q": data["q"], "limit": data["limit"]})
        final = None
        finished = False
        for line in raw.splitlines():
            if not line.strip():
                continue
            event = kb._json(line)
            if not isinstance(event, dict):
                malformed()
            if event.get("type") == "final":
                if finished or event.get("status") != "succeeded":
                    raise HTTPException(502, "知识库检索未完成，请稍后重试")
                finished = True
                final = event.get("result")
        if not isinstance(final, dict) or not all(
            isinstance(final.get(k), list) for k in ("chunks", "page_refs")
        ):
            malformed()
        refs = [item for row in final["page_refs"] if (item := metadata(row))]
        chunks = []
        for row in final["chunks"][: data["limit"]]:
            item = metadata(row)
            if item:
                text = row.get("text") or row.get("snippet") or ""
                if not isinstance(text, str):
                    malformed()
                chunk = {**item, "text": text[:2000], "truncated": len(text) > 2000}
                # Offset is a character position only when Core explicitly says so.
                # Chunk indices, token positions and guessed snippet locations are not offsets.
                if type(row.get("offset")) is int and 0 <= row["offset"] <= 500000:
                    chunk["offset"] = row["offset"]
                chunks.append(chunk)
        return rank_result(
            data["q"],
            {
                "page_refs": refs[: data["limit"]],
                "chunks": chunks,
                "truncated": len(refs) > data["limit"]
                or len(final["chunks"]) > data["limit"]
                or any(x["truncated"] for x in chunks),
            },
        )
    if name == "read_page":
        record = core_json("/v1/base/pages/" + quote(path, safe="/"))
        item = metadata(record)
        if not item or item["path"] != path or not isinstance(record.get("body"), str):
            malformed()
        body = record["body"]
        frontmatter = record.get("frontmatter")
        safe_metadata = {}
        if isinstance(frontmatter, dict):
            for key in ("author", "authors", "date", "tags", "sources", "status", "kind"):
                value = frontmatter.get(key)
                if isinstance(value, str):
                    safe_metadata[key] = value[:1000]
                elif isinstance(value, list):
                    safe_metadata[key] = [x[:1000] for x in value[:20] if isinstance(x, str)]
        end = data["offset"] + data["length"]
        return {
            **item,
            "body": body[data["offset"] : end],
            "metadata": safe_metadata,
            "offset": data["offset"],
            "total_chars": len(body),
            "truncated": end < len(body),
            "next_offset": end if end < len(body) else None,
        }
    if name == "page_links":
        result = core_json(
            "/v1/base/pages/" + quote(path, safe="/") + "/links",
            params={"direction": data["direction"], "limit": data["limit"]},
        )
        if (
            not isinstance(result, dict)
            or result.get("path") != path
            or not all(isinstance(result.get(k), list) for k in ("incoming", "outgoing"))
        ):
            malformed()
        output = {"path": path, "truncated": False}
        for key, field in (("incoming", "src_path"), ("outgoing", "dst_path")):
            rows = result[key]
            output[key] = [
                {
                    field: row[field],
                    "title": kb._string(row.get("title")),
                    "link_type": kb._string(row.get("link_type"), 80),
                }
                for row in rows[: data["limit"]]
                if isinstance(row, dict) and valid_path(row.get(field))
            ]
            # Core caps each direction; a full page means there may be more links.
            output["truncated"] |= len(rows) >= data["limit"]
        return output
    # Core 0.6.10 exposes wisdom documents through the cross-layer pages API;
    # the original Agent's legacy /v1/wisdom route is absent in this version.
    records = core_json("/v1/base/pages", params={"active": "true", "layer": "wisdom"})
    if not isinstance(records, list):
        malformed()
    rows = []
    for row in records:
        if (
            not isinstance(row, dict)
            or not valid_path(row.get("path"))
            or not row["path"].startswith("wisdom/")
            or row.get("active") is False
        ):
            continue
        if (
            row.get("active") is not True
            or row.get("layer") != "wisdom"
            or (data["status"] is not None and row.get("status") != data["status"])
        ):
            continue
        rows.append(
            {
                **{key: kb._string(row.get(key), 1000) for key in ("path", "title", "status")},
                "url": kb._configuration()[2] + "/",
            }
        )
    return page_slice(sorted(rows, key=lambda x: x["path"]), data["offset"], data["limit"])


def encoded_result(result, budget=24000):
    """Never cut serialized JSON in half or hide that content has been omitted."""
    encoded = json.dumps(result, ensure_ascii=False)
    if len(encoded) <= budget:
        return encoded
    # Trim list payloads while retaining counts, pagination and explicit truncation.
    result = dict(result, truncated=True)
    for key in ("chunks", "page_refs", "items", "incoming", "outgoing"):
        if isinstance(result.get(key), list):
            result[key] = list(result[key])
    while len(json.dumps(result, ensure_ascii=False)) > budget:
        lists = [
            key
            for key in ("chunks", "page_refs", "items", "incoming", "outgoing")
            if result.get(key)
        ]
        if not lists:
            return json.dumps(
                {"error": "工具结果超出本轮容量，请缩小查询范围", "truncated": True},
                ensure_ascii=False,
            )
        key = max(lists, key=lambda k: len(json.dumps(result[k], ensure_ascii=False)))
        result[key].pop()
        if key == "items" and "offset" in result:
            result["next_offset"] = result["offset"] + len(result["items"])
    return json.dumps(result, ensure_ascii=False)
