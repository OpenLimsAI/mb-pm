"""IAM protected reverse proxy for the existing customer DIKW installation.

No business data is stored here. Credentials and OAuth tokens never go to the SPA.
Run one worker; SQLite transactions also protect one-time OAuth state consumption.
"""
import base64
import hashlib
import html
import json
import os
from pathlib import Path
import secrets
import sqlite3
import time
from urllib.parse import urlencode, urlsplit

from cryptography.fernet import Fernet
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response, StreamingResponse
import httpx
from jose import jwt, JWTError
from starlette.background import BackgroundTask


CONFIG = json.loads(Path(os.environ.get("KB_CONFIG_FILE", "/run/secrets/config.json")).read_text())
PUBLIC = CONFIG["public_url"].rstrip("/")
ISSUER = CONFIG["issuer"].rstrip("/")
IAM = CONFIG["iam_internal_url"].rstrip("/")
CORE = CONFIG["core_url"].rstrip("/")
WEB = CONFIG["web_url"].rstrip("/")
CLIENT_ID = CONFIG["client_id"]
CLIENT_SECRET = CONFIG["client_secret"]
ORG = CONFIG["organization"]
CORE_TOKEN = CONFIG["core_token"]
FERNET = Fernet(base64.urlsafe_b64encode(hashlib.sha256(CONFIG["session_secret"].encode()).digest()))
DB = Path(os.environ.get("KB_SESSION_DB", "/data/auth.sqlite"))
COOKIE = "__Host-kb_session"
STATE_COOKIE = "__Host-kb_oauth"
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"}
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
_http = None
_jwks = (0, {})


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def db():
    conn = sqlite3.connect(DB, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def sealed(value):
    return FERNET.encrypt(json.dumps(value, ensure_ascii=False).encode()).decode()


def unsealed(value):
    return json.loads(FERNET.decrypt(value.encode()))


def safe_return(value):
    if not value or not value.startswith("/") or value.startswith("//") or "\\" in value or any(ord(c) < 32 for c in value):
        return "/"
    if urlsplit(value).netloc or value.startswith(("/auth/", "/login")):
        return "/"
    return value[:2048]


def cookie(response, name, value, max_age):
    response.set_cookie(name, value, max_age=max_age, secure=True, httponly=True, samesite="lax", path="/")


def clear_cookie(response, name):
    response.delete_cookie(name, secure=True, httponly=True, samesite="lax", path="/")


@app.on_event("startup")
async def startup():
    global _http
    DB.parent.mkdir(parents=True, exist_ok=True)
    with db() as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("CREATE TABLE IF NOT EXISTS oauth (key TEXT PRIMARY KEY, data TEXT NOT NULL, expires REAL NOT NULL)")
        conn.execute("CREATE TABLE IF NOT EXISTS sessions (key TEXT PRIMARY KEY, data TEXT NOT NULL, expires REAL NOT NULL, checked REAL NOT NULL)")
    _http = httpx.AsyncClient(trust_env=False, follow_redirects=False, timeout=httpx.Timeout(120, connect=10), limits=httpx.Limits(max_connections=100))


@app.on_event("shutdown")
async def shutdown():
    if _http:
        await _http.aclose()


@app.middleware("http")
async def headers_and_origin(request, call_next):
    if request.url.path != "/health" and request.headers.get("host") != urlsplit(PUBLIC).netloc:
        return JSONResponse({"detail": "Invalid host"}, 400)
    if request.method not in SAFE_METHODS and request.headers.get("origin") != PUBLIC:
        return JSONResponse({"detail": "同源请求验证失败"}, 403)
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Strict-Transport-Security"] = "max-age=31536000"
    return response


@app.get("/health")
async def health():
    return {"status": "ok", "service": "kb-iam-gateway"}


def login_page(message=""):
    msg = f'<p role="alert">{html.escape(message)}</p>' if message else ""
    return HTMLResponse(f'''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>迈博知识库 · IAM 登录</title>
<style>body{{margin:0;background:#edf2f5;color:#263f4e;font:16px/1.7 system-ui}}body:before{{content:"";position:absolute;inset:0 0 auto;height:32vh;background:#23486f;z-index:-1}}main{{max-width:470px;margin:15vh auto 5vh;padding:38px;background:white;border-radius:14px;border-top:5px solid #0bb3ca;box-shadow:0 6px 24px #23486f10}}h1{{margin:0 0 6px;font-size:28px}}p{{color:#597483}}a{{color:#087c97}}.button{{display:block;margin:28px 0;padding:12px;text-align:center;background:#087c97;color:white;border-radius:8px;text-decoration:none;font-weight:600}}small{{display:block;text-align:center;color:#597483}}@media(max-width:560px){{main{{margin:15vh 18px;padding:25px}}}}</style>
<main><h1>迈博知识库</h1><p>使用迈博 IAM 账号登录。账号是否可用由 IAM 平台统一管理。</p>{msg}<a class="button" href="/auth/login">使用 IAM 账号登录 →</a><small>所有用户信息在 <a href="{ISSUER}/login" target="_blank" rel="noopener noreferrer">IAM 平台</a>管理</small></main></html>''')


@app.get("/login")
async def login():
    return login_page()


@app.get("/auth/login")
async def begin_login(request: Request, return_to: str = "/"):
    state, verifier, nonce = (secrets.token_urlsafe(32) for _ in range(3))
    now = time.time()
    with db() as conn:
        conn.execute("DELETE FROM oauth WHERE expires < ?", (now,))
        conn.execute("DELETE FROM sessions WHERE expires < ?", (now,))
        conn.execute("INSERT INTO oauth VALUES (?, ?, ?)", (digest(state), sealed({"verifier": verifier, "nonce": nonce, "return": safe_return(return_to)}), now + 600))
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    url = ISSUER + "/login/oauth/authorize?" + urlencode({"client_id": CLIENT_ID, "response_type": "code", "redirect_uri": PUBLIC + "/auth/callback", "scope": "openid profile email", "state": state, "nonce": nonce, "code_challenge": challenge, "code_challenge_method": "S256"})
    response = RedirectResponse(url, 303)
    cookie(response, STATE_COOKIE, state, 600)
    return response


async def signed_claims(token, access_token=None):
    global _jwks
    header = jwt.get_unverified_header(token)
    if header.get("alg") != "RS256" or not header.get("kid"):
        raise ValueError("Unsupported JWT")
    if _jwks[0] < time.time() - 300 or not any(k.get("kid") == header["kid"] for k in _jwks[1].get("keys", [])):
        response = await _http.get(IAM + "/.well-known/jwks")
        response.raise_for_status()
        _jwks = (time.time(), response.json())
    key = next((k for k in _jwks[1].get("keys", []) if k.get("kid") == header["kid"]), None)
    if not key:
        raise ValueError("Unknown signing key")
    claims = jwt.decode(token, key, algorithms=["RS256"], issuer=ISSUER, audience=CLIENT_ID, access_token=access_token, options={"require_exp": True, "require_sub": True, "require_aud": True, "require_iss": True, "leeway": 10})
    if claims.get("azp") and claims["azp"] != CLIENT_ID:
        raise ValueError("Wrong authorized party")
    return claims


def eligible(user, subject):
    return isinstance(user, dict) and user.get("id") == subject and user.get("owner") == ORG and bool(user.get("name")) and not user.get("isForbidden") and not user.get("isDeleted")


async def live_user(subject):
    response = await _http.get(IAM + "/api/get-user", params={"owner": ORG, "userId": subject}, auth=(CLIENT_ID, CLIENT_SECRET))
    response.raise_for_status()
    payload = response.json()
    if payload.get("status") != "ok":
        raise ValueError("IAM rejected account check")
    user = payload.get("data")
    if not eligible(user, subject):
        raise PermissionError("Account not allowed")
    return {"id": subject, "name": user["name"], "displayName": user.get("displayName") or user["name"]}


@app.get("/auth/callback")
async def callback(request: Request):
    state = request.query_params.get("state", "")
    bound = request.cookies.get(STATE_COOKIE, "")
    if not state or not bound or not secrets.compare_digest(state, bound):
        return login_page("登录校验失败，请重新登录。")
    with db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute("SELECT * FROM oauth WHERE key = ?", (digest(state),)).fetchone()
        conn.execute("DELETE FROM oauth WHERE key = ?", (digest(state),))
    if not row or row["expires"] < time.time() or not request.query_params.get("code") or request.query_params.get("error"):
        return login_page("登录已失效或已取消，请重新登录。")
    try:
        transaction = unsealed(row["data"])
        result = await _http.post(IAM + "/api/login/oauth/access_token", data={"grant_type": "authorization_code", "client_id": CLIENT_ID, "client_secret": CLIENT_SECRET, "redirect_uri": PUBLIC + "/auth/callback", "code": request.query_params["code"], "code_verifier": transaction["verifier"]})
        result.raise_for_status()
        tokens = result.json()
        access = await signed_claims(tokens["access_token"])
        identity = await signed_claims(tokens["id_token"], tokens["access_token"])
        if access["sub"] != identity["sub"] or identity.get("nonce") != transaction["nonce"]:
            raise ValueError("Mismatched identity")
        if access.get("owner") != ORG or access.get("isForbidden") or access.get("isDeleted"):
            raise PermissionError("Account not allowed")
        user = await live_user(identity["sub"])
        expires = min(float(access["exp"]), float(identity["exp"]), time.time() + 3600)
        if expires <= time.time():
            raise ValueError("Expired token")
        sid = secrets.token_urlsafe(32)
        data = {"user": user, "csrf": secrets.token_urlsafe(32), "id_token": tokens["id_token"]}
        with db() as conn:
            if request.cookies.get(COOKIE):
                conn.execute("DELETE FROM sessions WHERE key = ?", (digest(request.cookies[COOKIE]),))
            conn.execute("INSERT INTO sessions VALUES (?, ?, ?, ?)", (digest(sid), sealed(data), expires, time.time()))
        response = RedirectResponse(transaction["return"], 303)
        cookie(response, COOKIE, sid, max(1, int(expires - time.time())))
        clear_cookie(response, STATE_COOKIE)
        return response
    except PermissionError:
        return login_page("当前账号无权访问，请联系 IAM 管理员检查组织和账号状态。")
    except (httpx.HTTPError, JWTError, ValueError, KeyError, TypeError):
        return login_page("IAM 登录验证未通过，请重新登录或联系管理员。")


async def session(request):
    sid = request.cookies.get(COOKIE)
    if not sid:
        raise HTTPException(401, "请使用 IAM 账号登录")
    key = digest(sid)
    with db() as conn:
        row = conn.execute("SELECT * FROM sessions WHERE key = ?", (key,)).fetchone()
    if not row or row["expires"] <= time.time():
        raise HTTPException(401, "登录已过期")
    data = unsealed(row["data"])
    if row["checked"] < time.time() - 60:
        try:
            data["user"] = await live_user(data["user"]["id"])
        except PermissionError:
            with db() as conn:
                conn.execute("DELETE FROM sessions WHERE key = ?", (key,))
            raise HTTPException(401, "账号已停用或无权访问")
        except (httpx.HTTPError, ValueError):
            raise HTTPException(503, "IAM 暂时不可用，请稍后重试")
        with db() as conn:
            conn.execute("UPDATE sessions SET checked = ?, data = ? WHERE key = ?", (time.time(), sealed(data), key))
    return data


@app.get("/auth/session")
async def identity(request: Request):
    data = await session(request)
    return {"user": data["user"], "csrf": data["csrf"]}


@app.post("/auth/logout")
async def logout(request: Request):
    data = await session(request)
    if not secrets.compare_digest(request.headers.get("x-kb-csrf", ""), data["csrf"]):
        raise HTTPException(403, "退出校验失败")
    with db() as conn:
        conn.execute("DELETE FROM sessions WHERE key = ?", (digest(request.cookies[COOKIE]),))
    response = JSONResponse({"redirect": ISSUER + "/api/logout?" + urlencode({"client_id": CLIENT_ID, "id_token_hint": data["id_token"], "post_logout_redirect_uri": PUBLIC + "/login"})})
    clear_cookie(response, COOKIE)
    return response


@app.get("/auth/bootstrap.js")
async def bootstrap(request: Request):
    await session(request)
    return Response(Path(__file__).with_name("bootstrap.js").read_text(), media_type="application/javascript")


def connection_body(body):
    """Pin sidecar tool requests to the real core, never an arbitrary browser URL."""
    data = json.loads(body)
    if not isinstance(data, dict):
        raise ValueError("Expected object")
    data.update(coreUrl=CORE, token=CORE_TOKEN)
    return json.dumps(data, ensure_ascii=False).encode()


@app.api_route("/{path:path}", methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
async def proxy(request: Request, path: str):
    try:
        await session(request)
    except HTTPException as exc:
        if exc.status_code == 401 and request.method in {"GET", "HEAD"} and not path.startswith(("v1/", "agent/", "web/", "assets/", "auth/")) and "text/html" in request.headers.get("accept", ""):
            return RedirectResponse("/auth/login?" + urlencode({"return_to": safe_return(request.url.path + ("?" + request.url.query if request.url.query else ""))}), 303)
        raise
    if path.startswith("auth/"):
        raise HTTPException(404)
    raw_path = request.scope["raw_path"].decode("ascii")
    target = (CORE if path.startswith("v1/") else WEB) + raw_path
    if request.url.query:
        target += "?" + request.url.query
    headers = {k: v for k, v in request.headers.items() if k.lower() not in HOP | {"host", "cookie", "authorization", "content-length", "accept-encoding", "forwarded", "x-forwarded-host", "x-forwarded-proto", "x-kb-csrf"}}
    headers["Accept-Encoding"] = "identity"
    if path.startswith("v1/"):
        headers["Authorization"] = "Bearer " + CORE_TOKEN
    content = request.stream()
    if path.startswith("agent/") and request.method in {"POST", "PUT", "PATCH"}:
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > 2 * 1024 * 1024:
                raise HTTPException(413, "请求过大")
        try:
            content = connection_body(body)
        except (ValueError, TypeError):
            raise HTTPException(400, "请求格式错误")
        headers["Content-Type"] = "application/json"
    try:
        upstream_request = _http.build_request(request.method, target, headers=headers, content=content)
        upstream = await _http.send(upstream_request, stream=True)
    except httpx.HTTPError:
        raise HTTPException(502, "知识库服务暂时不可用")
    response_headers = {k: v for k, v in upstream.headers.items() if k.lower() not in HOP | {"set-cookie", "content-length", "content-encoding", "server", "access-control-allow-origin", "access-control-allow-credentials"}}
    if "text/html" in upstream.headers.get("content-type", "") and request.method == "GET":
        body = await upstream.aread()
        await upstream.aclose()
        injection = b'<script src="/auth/bootstrap.js"></script>'
        body = body.replace(b"</head>", injection + b"</head>", 1)
        response_headers.pop("etag", None)
        return Response(body, status_code=upstream.status_code, headers=response_headers)
    return StreamingResponse(upstream.aiter_bytes(), status_code=upstream.status_code, headers=response_headers, background=BackgroundTask(upstream.aclose))
