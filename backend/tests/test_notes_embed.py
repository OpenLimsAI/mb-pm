"""The notes document, not every portal page, may be embedded by the KB."""

import pytest
from fastapi import FastAPI
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.testclient import TestClient

from app.core.config import settings
from app.main import prevent_auth_response_caching
from app.middleware.notes_embed import BASE_ANCESTORS


@pytest.fixture
def embedded_client():
    app = FastAPI()
    app.middleware("http")(prevent_auth_response_caching)

    @app.api_route("/{path:path}", methods=["GET", "HEAD", "POST"])
    def document(path: str):
        return JSONResponse({}) if path.startswith("api/") else HTMLResponse("<main>notes</main>")

    with TestClient(app) as client:
        yield client


@pytest.mark.parametrize("origin", ["https://kb.openlims.ai", "http://localhost:4322"])
def test_only_notes_embed_html_allows_the_configured_kb(embedded_client, monkeypatch, origin):
    monkeypatch.setattr(settings, "KNOWLEDGE_NOTES_ORIGIN", origin)
    for method in ("get", "head"):
        response = getattr(embedded_client, method)("/notes?embed=knowledge")
        assert response.headers["content-security-policy"] == (
            "object-src 'none'; base-uri 'self'; frame-ancestors " + BASE_ANCESTORS + " " + origin
        )
    for path in (
        "/notes",
        "/",
        "/settings?embed=knowledge",
        "/api/v1/notes?embed=knowledge",
        "/notes?embed=other",
        "/notes/child?embed=knowledge",
        "/notes/?embed=knowledge",
        "/notes?embed=knowledge&embed=other",
    ):
        assert embedded_client.get(path).headers["content-security-policy"].endswith(BASE_ANCESTORS)
    assert (
        embedded_client.post("/notes?embed=knowledge")
        .headers["content-security-policy"]
        .endswith(BASE_ANCESTORS)
    )


@pytest.mark.parametrize(
    "origin",
    [
        "",
        "*",
        "https://*.example",
        "https://kb.example/path",
        "https://kb.example/",
        "https://kb.example?x=1",
        "https://kb.example#fragment",
        "https://user:password@kb.example",
        "https://kb.example; script-src *",
        "https://kb.example https://other.example",
        "https://kb.example\n",
        "javascript:alert(1)",
        "https://kb.example:0",
        "https://kb.example:invalid",
        "https://kb.example:65536",
    ],
)
def test_invalid_origin_fails_closed(embedded_client, monkeypatch, origin):
    monkeypatch.setattr(settings, "KNOWLEDGE_NOTES_ORIGIN", origin)
    response = embedded_client.get("/notes?embed=knowledge")
    assert response.headers["content-security-policy"].endswith(BASE_ANCESTORS)
