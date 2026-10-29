"""Casdoor authorization code + PKCE; tokens remain on the server."""

import base64
import hashlib
import secrets
import time
from typing import Annotated
from urllib.parse import quote, urlencode

import httpx
from cryptography.fernet import InvalidToken
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import RedirectResponse
from sqlalchemy import delete
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.iam_deps import require_same_origin
from app.core.config import settings
from app.core.iam import (
    LOGIN_COOKIE,
    SESSION_COOKIE,
    decode_access_token,
    digest,
    resolve_identity,
    seal,
    unseal,
)
from app.db.session import get_db
from app.models import IAMLogin, IAMSession

router = APIRouter(prefix="/auth", tags=["auth"])
Database = Annotated[Session, Depends(get_db)]


def set_cookie(response, name, value, age):
    response.set_cookie(
        name,
        value,
        max_age=age,
        httponly=True,
        secure=settings.IAM_COOKIE_SECURE,
        samesite="lax",
        path="/",
    )


def no_cache(response):
    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


def login_error(code: str):
    response = RedirectResponse(
        settings.PMS_PUBLIC_URL + "/login?" + urlencode({"error": code}), 303
    )
    response.delete_cookie(LOGIN_COOKIE, path="/")
    response.delete_cookie(SESSION_COOKIE, path="/")
    return no_cache(response)


@router.get("/login")
def login(db: Database, return_to: str = Query("/projects", max_length=2048)):
    if not settings.IAM_ENABLED or not settings.CASDOOR_CLIENT_SECRET:
        raise HTTPException(503, "IAM 客户端尚未配置")
    # Canonical origin also ensures the login-state cookie belongs to callback's host.
    if (
        not return_to.startswith("/")
        or return_to.startswith("//")
        or "\\" in return_to
        or any(ord(c) < 32 for c in return_to)
    ):
        return_to = "/projects"
    state, verifier, nonce = (secrets.token_urlsafe(32) for _ in range(3))
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    )
    now = int(time.time())
    db.execute(delete(IAMLogin).where(IAMLogin.expires_at < now))
    db.execute(delete(IAMSession).where(IAMSession.expires_at < now))
    db.add(
        IAMLogin(
            id=digest(state),
            expires_at=now + 600,
            data=seal({"verifier": verifier, "nonce": nonce, "return_to": return_to}),
        )
    )
    db.commit()
    params = {
        "client_id": settings.CASDOOR_CLIENT_ID,
        "response_type": "code",
        "redirect_uri": settings.iam_callback_url,
        "scope": "openid profile email",
        "state": state,
        "nonce": nonce,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    response = RedirectResponse(
        settings.CASDOOR_ENDPOINT + "/login/oauth/authorize?" + urlencode(params), 303
    )
    set_cookie(response, LOGIN_COOKIE, state, 600)
    return no_cache(response)


@router.get("/config")
def config():
    return {
        "enabled": settings.IAM_ENABLED,
        "login_url": settings.PMS_PUBLIC_URL + "/api/v1/auth/login",
        "signup_url": settings.CASDOOR_ENDPOINT
        + "/signup/"
        + quote(settings.CASDOOR_APPLICATION, safe=""),
        "account_url": settings.CASDOOR_ENDPOINT + "/account",
    }


@router.get("/callback")
def callback(
    request: Request,
    db: Database,
    code: str = "",
    state: str = "",
    error: str = "",
):
    if not settings.IAM_ENABLED:
        raise HTTPException(503, "IAM 尚未启用")
    cookie_state = request.cookies.get(LOGIN_COOKIE, "")
    if not state or not cookie_state or not secrets.compare_digest(state, cookie_state):
        return login_error("state")
    # Atomically consume the state before exchanging a code (blocks replay).
    transaction = db.execute(
        delete(IAMLogin)
        .where(IAMLogin.id == digest(state))
        .returning(IAMLogin.data, IAMLogin.expires_at)
    ).first()
    db.commit()
    if not transaction or transaction.expires_at < int(time.time()):
        return login_error("state")
    if error or not code:
        return login_error("cancelled")
    try:
        data = unseal(transaction.data)
        result = httpx.post(
            settings.CASDOOR_ENDPOINT + "/api/login/oauth/access_token",
            data={
                "grant_type": "authorization_code",
                "client_id": settings.CASDOOR_CLIENT_ID,
                "client_secret": settings.CASDOOR_CLIENT_SECRET,
                "code": code,
                "redirect_uri": settings.iam_callback_url,
                "code_verifier": data["verifier"],
            },
            timeout=10,
            trust_env=False,
        )
        result.raise_for_status()
        tokens = result.json()
        access = tokens["access_token"]
        claims = decode_access_token(access)
        identity = decode_access_token(tokens["id_token"], access_token=access)
        if identity.get("nonce") != data["nonce"] or identity["sub"] != claims["sub"]:
            raise ValueError("identity verification failed")
        if identity.get("azp", settings.CASDOOR_CLIENT_ID) != settings.CASDOOR_CLIENT_ID:
            raise ValueError("invalid authorized party")
        resolve_identity(claims, db, bind=True)
        session_id = secrets.token_urlsafe(32)
        expires = min(int(claims["exp"]), int(time.time()) + settings.IAM_SESSION_SECONDS)
        # Rotate a previous local session on every successful login.
        previous = request.cookies.get(SESSION_COOKIE)
        if previous:
            db.execute(delete(IAMSession).where(IAMSession.id == digest(previous)))
        db.add(
            IAMSession(
                id=digest(session_id),
                expires_at=expires,
                tokens=seal({"access_token": access, "id_token": tokens["id_token"]}),
            )
        )
        db.commit()
    except HTTPException as exc:
        db.rollback()
        return login_error("role" if exc.status_code == 403 else "provider")
    except (httpx.HTTPError, ValueError, KeyError, TypeError, InvalidToken, IntegrityError):
        db.rollback()
        return login_error("provider")
    response = RedirectResponse(settings.PMS_PUBLIC_URL + data["return_to"], 303)
    response.delete_cookie(LOGIN_COOKIE, path="/")
    set_cookie(response, SESSION_COOKIE, session_id, max(0, expires - int(time.time())))
    return no_cache(response)


@router.post("/logout")
def logout(request: Request, db: Database):
    if not settings.IAM_ENABLED:
        raise HTTPException(503, "IAM 尚未启用")
    require_same_origin(request)
    session_id = request.cookies.get(SESSION_COOKIE, "")
    session = db.get(IAMSession, digest(session_id)) if session_id else None
    params = {
        "client_id": settings.CASDOOR_CLIENT_ID,
        "post_logout_redirect_uri": settings.PMS_PUBLIC_URL + "/login",
    }
    if session:
        try:
            params["id_token_hint"] = unseal(session.tokens)["id_token"]
        except (InvalidToken, ValueError, KeyError):
            pass
        db.delete(session)
        db.commit()
    response = RedirectResponse(settings.CASDOOR_ENDPOINT + "/api/logout?" + urlencode(params), 303)
    response.delete_cookie(SESSION_COOKIE, path="/")
    response.delete_cookie(LOGIN_COOKIE, path="/")
    return no_cache(response)
