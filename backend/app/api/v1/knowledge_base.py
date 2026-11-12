"""Local, fixed-destination mount for the independent knowledge application.

The KB still authenticates each request. Portal/PM cookies and bearer credentials
must never be sent to it merely because both applications share an origin.
"""

from http.cookies import SimpleCookie
from urllib.parse import unquote, urlsplit

import httpx
from fastapi import APIRouter, HTTPException, Request
from starlette.background import BackgroundTask
from starlette.responses import RedirectResponse, StreamingResponse

from app.core.config import settings

router = APIRouter(include_in_schema=False)
PREFIX = "/knowledge-base"
COOKIE_NAMES = frozenset({"dikw_mbweb_session", "dikw_mbweb_login"})
METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
REQUEST_HEADERS = frozenset(
    {
        "accept",
        "accept-language",
        "content-type",
        "content-length",
        "origin",
        "referer",
        "cache-control",
        "if-none-match",
        "if-modified-since",
        "range",
        "if-range",
        "x-dikw-model",
        "x-dikw-expected-identity",
    }
)
HOP_HEADERS = frozenset(
    {
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    }
)


def upstream_origin():
    value = settings.KNOWLEDGE_BASE_UPSTREAM
    if not value:
        raise HTTPException(404, "知识库入口尚未启用")
    try:
        url = urlsplit(value)
        valid = (
            url.scheme == "http"
            and url.hostname in {"127.0.0.1", "localhost"}
            and url.port == 4322
            and url.path in {"", "/"}
            and not url.query
            and not url.fragment
            and url.username is None
            and url.password is None
        )
    except ValueError:
        valid = False
    if not valid:
        raise HTTPException(503, "本机知识库连接配置无效")
    return value.rstrip("/")


def knowledge_cookies(value):
    # Browsers send the longest cookie Path first. Old localhost:4322 cookies
    # were host-wide, so never let a later legacy root cookie replace the new
    # /knowledge-base session or OAuth transaction with the same name.
    seen = set()
    selected = []
    for part in value.split(";"):
        part = part.strip()
        name, separator, _ = part.partition("=")
        if not separator or name not in COOKIE_NAMES or name in seen:
            continue
        seen.add(name)
        cookies = SimpleCookie()
        try:
            cookies.load(part)
        except Exception:
            continue
        if list(cookies) != [name] or any(ord(char) < 32 or ord(char) == 127 for char in part):
            continue
        selected.append(f"{name}={cookies[name].coded_value}")
    return "; ".join(selected)


def request_path(request):
    raw = request.scope.get("raw_path", request.url.path.encode()).decode("ascii", errors="strict")
    decoded = raw
    for _ in range(3):
        next_value = unquote(decoded)
        if next_value == decoded:
            break
        decoded = next_value
    if (
        not raw.startswith(PREFIX + "/")
        or not decoded.startswith(PREFIX + "/")
        or "\\" in decoded
        or any(ord(char) < 32 or ord(char) == 127 for char in decoded)
        or any(part in {".", ".."} for part in decoded.split("/"))
    ):
        raise HTTPException(400, "知识库请求路径无效")
    return raw


def upstream_client():
    return httpx.AsyncClient(
        trust_env=False,
        follow_redirects=False,
        timeout=httpx.Timeout(connect=5, read=150, write=60, pool=5),
    )


@router.api_route(PREFIX, methods=METHODS)
async def knowledge_root(request: Request):
    upstream_origin()
    query = request.scope.get("query_string", b"").decode("ascii")
    return RedirectResponse(PREFIX + "/" + ("?" + query if query else ""), status_code=307)


@router.api_route(PREFIX + "/{path:path}", methods=METHODS)
async def knowledge_proxy(request: Request):
    origin = upstream_origin()
    try:
        path = request_path(request)
    except (UnicodeError, ValueError):
        raise HTTPException(400, "知识库请求路径无效") from None
    query = request.scope.get("query_string", b"")
    target = httpx.URL(origin + path).copy_with(query=query)
    headers = {
        key: value for key, value in request.headers.items() if key.lower() in REQUEST_HEADERS
    }
    cookies = knowledge_cookies(request.headers.get("cookie", ""))
    if cookies:
        headers["cookie"] = cookies
    headers["accept-encoding"] = "identity"
    # These values come from the configured portal, never a forwarded client header.
    public = urlsplit(settings.portal_origin)
    headers["x-forwarded-host"] = public.netloc
    headers["x-forwarded-proto"] = public.scheme
    headers["x-forwarded-prefix"] = PREFIX
    headers["host"] = public.netloc
    client = upstream_client()
    upstream = None
    try:
        body = None if request.method in {"GET", "HEAD"} else request.stream()
        message = client.build_request(request.method, target, headers=headers, content=body)
        upstream = await client.send(message, stream=True)
    except (httpx.HTTPError, OSError):
        await client.aclose()
        raise HTTPException(503, "本机知识库暂未连接，请检查资料服务后重试") from None
    except BaseException:
        await client.aclose()
        raise

    async def close():
        await upstream.aclose()
        await client.aclose()

    async def chunks():
        try:
            async for chunk in upstream.aiter_raw():
                yield chunk
        finally:
            await close()

    response = StreamingResponse(
        chunks(), status_code=upstream.status_code, background=BackgroundTask(close)
    )
    blocked = HOP_HEADERS | {
        part.strip()
        for part in upstream.headers.get("connection", "").lower().split(",")
        if part.strip()
    }
    response.raw_headers = [
        (key.lower(), value)
        for key, value in upstream.headers.raw
        if key.decode("latin1").lower() not in blocked | {"set-cookie"}
    ]
    for value in upstream.headers.get_list("set-cookie"):
        if value.split("=", 1)[0].strip() in COOKIE_NAMES:
            response.headers.append("set-cookie", value)
    request.state.knowledge_base_response = True
    return response
