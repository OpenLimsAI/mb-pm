"""知识报告的只读论文适配；门户验证身份后，每次向 IAM 核对 KB 角色。

只调用固定 Core 的论文目录、原文和检索，不接受调用者指定服务地址或通用代理路径。
原文与元数据都是资料，不应被调用方当作系统指令。配置和响应中均不暴露服务令牌。
"""

import hashlib
import json
import os
import unicodedata
from datetime import UTC, datetime
from urllib.parse import quote, unquote, urlsplit

import httpx
from fastapi import HTTPException

from app.services import accounts
from app.services.iam_admin import IAMError

KB_ROLES = {"kb_manager", "kb_editor", "kb_viewer"}
MAX_RESULTS = 30
RETRIEVE_LIMIT = 12
MAX_CONTENT_CHARS = 500_000
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
CONFIG_MESSAGE = "论文知识库连接尚未配置，请联系管理员配置知识报告的知识库连接"


def _origin(value: str) -> str:
    try:
        parsed = urlsplit(value)
        valid = (
            parsed.scheme in {"http", "https"}
            and bool(parsed.hostname)
            and parsed.username is None
            and parsed.password is None
            and parsed.path in {"", "/"}
            and not parsed.query
            and not parsed.fragment
            and not any(c.isspace() or unicodedata.category(c) == "Cc" for c in value)
            and "\\" not in value
        )
        _ = parsed.port
    except ValueError:
        valid = False
    if not valid:
        raise HTTPException(503, CONFIG_MESSAGE)
    return value.rstrip("/")


def _configuration() -> tuple[str, str, str]:
    core = os.environ.get("SOLUTION_KB_CORE_URL", "").strip()
    token = os.environ.get("SOLUTION_KB_TOKEN", "").strip()
    public = os.environ.get("SOLUTION_KB_PUBLIC_URL", "").strip()
    if not core or not token or not public or any(c.isspace() for c in token):
        raise HTTPException(503, CONFIG_MESSAGE)
    return _origin(core), token, _origin(public)


def configured() -> bool:
    try:
        _configuration()
    except HTTPException:
        return False
    return True


def check_access(claims: dict) -> None:
    subject = claims.get("sub")
    if not isinstance(subject, str) or not subject.strip():
        raise HTTPException(401, "请先登录迈博工作台")
    # No use of login-time role claims, directory caches or implicit admin access.
    try:
        roles = accounts.live_roles(subject)
    except IAMError as exc:
        raise HTTPException(503, "暂时无法确认论文知识库权限，请稍后重试") from exc
    if not roles & KB_ROLES:
        raise HTTPException(403, "当前账号未开通知识库权限，请联系系统管理员")
    _configuration()


def _valid_path(path: object) -> bool:
    if not isinstance(path, str) or len(path) > 1024:
        return False
    # Match the KB paper boundary and reject encoded separators/dot segments too.
    # Reject '%' instead of decoding repeatedly: a raw path must never become a
    # different routing path after a proxy or Core performs another decode.
    return (
        path.startswith("sources/")
        and path.endswith(".md")
        and all(part not in {"", ".", ".."} for part in path.split("/"))
        and not any(unicodedata.category(c) in {"Cc", "Cs"} for c in path)
        and "\\" not in path
        and "%" not in path
        and unquote(path) == path
    )


def _path(source_id: str) -> str:
    if not isinstance(source_id, str) or not source_id.startswith("kb:"):
        raise HTTPException(400, "请选择有效的论文知识库来源")
    path = source_id[3:]
    if not _valid_path(path):
        raise HTTPException(400, "论文来源路径无效")
    return path


def _request(method: str, path: str, *, params=None, payload=None) -> bytes:
    core, token, _public = _configuration()
    try:
        with httpx.stream(
            method,
            core + path,
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
            params=params,
            json=payload,
            timeout=httpx.Timeout(30.0, connect=5.0),
            follow_redirects=False,
            trust_env=False,
        ) as response:
            if response.status_code == 404:
                raise HTTPException(404, "论文来源已不存在或暂不可访问")
            if response.status_code in {401, 403}:
                raise HTTPException(503, "论文知识库服务连接认证失败，请联系管理员")
            if not 200 <= response.status_code < 300:
                raise HTTPException(502, "论文知识库暂时无法完成请求，请稍后重试")
            chunks = []
            size = 0
            for chunk in response.iter_bytes():
                size += len(chunk)
                if size > MAX_RESPONSE_BYTES:
                    raise HTTPException(502, "论文知识库返回内容过大，请缩小检索范围")
                chunks.append(chunk)
            return b"".join(chunks)
    except httpx.TimeoutException as exc:
        raise HTTPException(504, "论文知识库响应超时，请稍后重试") from exc
    except httpx.HTTPError as exc:
        raise HTTPException(502, "暂时无法连接论文知识库，请稍后重试") from exc


def _json(raw: bytes):
    try:
        return json.loads(raw)
    except (ValueError, UnicodeDecodeError) as exc:
        raise HTTPException(502, "论文知识库返回格式异常，请稍后重试") from exc


def _string(value: object, limit: int = 1000) -> str:
    return value.strip()[:limit] if isinstance(value, str) else ""


def _timestamp(value: object) -> str:
    if isinstance(value, int | float) and not isinstance(value, bool):
        try:
            return datetime.fromtimestamp(value, UTC).isoformat()
        except (ValueError, OverflowError, OSError):
            return ""
    return _string(value, 80)


def _source(record: dict, *, content: str = "", full: bool = False) -> dict:
    path = record["path"]
    _, _, public = _configuration()
    frontmatter = record.get("frontmatter")
    metadata = frontmatter if isinstance(frontmatter, dict) else record
    authors = metadata.get("authors", metadata.get("author", ""))
    if isinstance(authors, list):
        authors = "、".join(
            _string(author, 150) for author in authors[:20] if isinstance(author, str)
        )
    tags = metadata.get("tags", [])
    return {
        "id": "kb:" + path,
        "title": _string(record.get("title")) or path.rsplit("/", 1)[-1][:-3],
        "kind": "paper",
        "authors": _string(authors),
        "date": _string(metadata.get("date", metadata.get("published_at")), 80),
        "project_name": _string(metadata.get("project_name"), 200),
        "tags": [_string(tag, 100) for tag in tags[:20] if _string(tag, 100)]
        if isinstance(tags, list)
        else [],
        "content": content,
        "locator": path,
        "version": hashlib.sha256(content.encode("utf-8")).hexdigest() if full else "",
        # The KB has no paper deep link. The application reads originals through
        # get_source; its external link opens the real knowledge-library homepage.
        "url": public + "/",
        "updated_at": _timestamp(record.get("mtime", metadata.get("updated_at"))),
    }


def _retrieve(query: str) -> list[dict]:
    raw = _request("POST", "/v1/retrieve", payload={"q": query, "limit": RETRIEVE_LIMIT})
    final = None
    finished = False
    for line in raw.splitlines():
        if not line.strip():
            continue
        event = _json(line)
        if not isinstance(event, dict):
            raise HTTPException(502, "知识库检索返回格式异常")
        if event.get("type") == "final":
            if finished or event.get("status") != "succeeded":
                raise HTTPException(502, "知识库检索未完成，请稍后重试")
            finished = True
            final = event.get("result")
    if (
        not isinstance(final, dict)
        or not isinstance(final.get("page_refs"), list)
        or not isinstance(final.get("chunks"), list)
    ):
        raise HTTPException(502, "知识库检索未返回完整结果，请稍后重试")
    return final["page_refs"]


def list_sources(claims: dict, query: str = "", project_name: str = "") -> list[dict]:
    check_access(claims)
    query = query.strip()
    if len(query) > 1000 or len(project_name) > 200:
        raise HTTPException(400, "检索条件过长，请缩短后重试")
    records = (
        _retrieve(query)
        if query
        else _json(_request("GET", "/v1/base/pages", params={"active": "true", "layer": "source"}))
    )
    if not isinstance(records, list):
        raise HTTPException(502, "论文知识库目录格式异常")
    results = []
    seen = set()
    for record in records:
        if (
            not isinstance(record, dict)
            or not _valid_path(record.get("path"))
            or record.get("layer") != "source"
            or record.get("active") is False
            or record["path"] in seen
        ):
            continue
        source = _source(record)
        # Do not relabel unclassified external papers as belonging to the current project.
        if project_name.strip() and source["project_name"] != project_name.strip():
            continue
        results.append(source)
        seen.add(record["path"])
        if len(results) >= MAX_RESULTS:
            break
    return results


def get_source(claims: dict, source_id: str) -> dict:
    check_access(claims)
    path = _path(source_id)
    record = _json(_request("GET", "/v1/base/pages/" + quote(path, safe="/")))
    if (
        not isinstance(record, dict)
        or record.get("path") != path
        or record.get("layer") != "source"
        or record.get("active") is False
    ):
        raise HTTPException(502, "知识库返回的论文身份不匹配，请重新选择来源")
    content = record.get("body")
    if not isinstance(content, str):
        raise HTTPException(502, "论文正文格式异常")
    if len(content) > MAX_CONTENT_CHARS:
        raise HTTPException(413, "论文正文过长，请在论文知识库中阅读并选择较短的资料")
    if any(unicodedata.category(char) == "Cs" for char in content):
        raise HTTPException(502, "论文正文字符编码异常")
    return _source(record, content=content, full=True)
