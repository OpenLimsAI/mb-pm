"""Only the server-owned SPA entry may preserve same-origin form navigation Origin."""

import pytest
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, RedirectResponse, Response
from fastapi.testclient import TestClient

from app import main


@pytest.fixture
def policy_client(tmp_path, monkeypatch):
    (tmp_path / "index.html").write_text("<html>SPA entry</html>")
    (tmp_path / "release-notes.html").write_text("<html>static notes</html>")
    (tmp_path / "data.json").write_text('{"ok":true}')
    app = FastAPI()
    app.middleware("http")(main.prevent_auth_response_caching)
    monkeypatch.setattr(main, "_HAS_SPA", True)
    monkeypatch.setattr(main, "_STATIC", tmp_path)
    app.get("/")(main.root)

    @app.get("/api/v1/html")
    @app.get("/auth/html")
    def sensitive_html():
        return HTMLResponse("<html>sensitive</html>")

    @app.get("/api/v1/marked-html")
    def marked_api(request: Request):
        request.state.spa_entry_document = True
        return HTMLResponse("<html>still sensitive</html>")

    @app.get("/auth/redirect")
    def redirect():
        return RedirectResponse("/login", status_code=303)

    @app.get("/boundary/{kind}")
    def boundary(kind: str, request: Request):
        request.state.spa_entry_document = True
        if kind == "redirect":
            return HTMLResponse("redirect", status_code=303, headers={"Location": "/login"})
        if kind == "error":
            return HTMLResponse("error", status_code=500)
        return Response("{}", media_type="application/json")

    main.mount_spa(app, tmp_path.resolve())
    return TestClient(app, follow_redirects=False)


@pytest.mark.parametrize("path", ["/", "/index.html", "/login", "/workspace", "/projects/p1"])
def test_spa_entry_preserves_same_origin_form_origin(policy_client, path):
    response = policy_client.get(path)
    assert response.status_code == 200
    assert response.headers["referrer-policy"] == "same-origin"
    assert response.headers["cache-control"] == "no-cache"


@pytest.mark.parametrize(
    "path",
    [
        "/api/v1/html",
        "/api/v1/marked-html",
        "/auth/html",
        "/auth/redirect",
        "/api/v1/missing",
        "/release-notes.html",
        "/data.json",
        "/boundary/redirect",
        "/boundary/error",
        "/boundary/json",
        "/docs",
    ],
)
def test_non_spa_responses_remain_no_referrer(policy_client, path):
    response = policy_client.get(path, headers={"X-Spa-Entry-Document": "true"})
    assert response.headers["referrer-policy"] == "no-referrer"
    if path.startswith("/api/v1/"):
        assert response.headers["cache-control"] == "no-store"


def test_api_only_root_remains_no_referrer(policy_client, monkeypatch):
    monkeypatch.setattr(main, "_HAS_SPA", False)
    response = policy_client.get("/")
    assert response.headers["content-type"] == "application/json"
    assert response.headers["referrer-policy"] == "no-referrer"
