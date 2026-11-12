import asyncio

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.requests import Request

from app.api.v1 import knowledge_base as mount


def fixture(monkeypatch, handler):
    monkeypatch.setattr(mount.settings, "KNOWLEDGE_BASE_UPSTREAM", "http://127.0.0.1:4322")
    monkeypatch.setattr(mount.settings, "PMS_PUBLIC_URL", "http://localhost:1234")
    monkeypatch.setattr(mount.settings, "PORTAL_PUBLIC_URL", "")
    clients = []

    def create():
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=False)
        clients.append(client)
        return client

    monkeypatch.setattr(mount, "upstream_client", create)
    app = FastAPI()
    app.include_router(mount.router)

    @app.get("/{path:path}")
    def spa(path):
        return {"spa": path}

    return TestClient(app), clients


def test_disabled_mount_does_not_fall_back_to_portal_spa(monkeypatch):
    client, clients = fixture(monkeypatch, lambda _: None)
    monkeypatch.setattr(mount.settings, "KNOWLEDGE_BASE_UPSTREAM", "")
    assert client.get("/knowledge-base/").status_code == 404
    assert clients == []


def test_prefix_cookie_wins_over_legacy_host_wide_cookie():
    assert (
        mount.knowledge_cookies(
            "dikw_mbweb_session=prefix; dikw_mbweb_login=prefix-login; "
            "mbportal_iam_session=portal; dikw_mbweb_session=old-root; dikw_mbweb_login=old-login"
        )
        == "dikw_mbweb_session=prefix; dikw_mbweb_login=prefix-login"
    )
    assert mount.knowledge_cookies("dikw_mbweb_session=bad\x00value; dikw_mbweb_session=root") == ""


@pytest.mark.parametrize(
    "origin",
    [
        "https://outside.example",
        "http://127.0.0.1:8001",
        "http://localhost:4322/path",
        "http://name:secret@localhost:4322",
    ],
)
def test_only_fixed_local_knowledge_destination_is_accepted(monkeypatch, origin):
    client, clients = fixture(monkeypatch, lambda _: None)
    monkeypatch.setattr(mount.settings, "KNOWLEDGE_BASE_UPSTREAM", origin)
    assert client.get("/knowledge-base/").status_code == 503
    assert clients == []


def test_canonical_root_preserves_paper_and_locator_parameters(monkeypatch):
    client, clients = fixture(monkeypatch, lambda _: None)
    response = client.get("/knowledge-base?paper=sources%2Fa.md&offset=12", follow_redirects=False)
    assert response.status_code == 307
    assert response.headers["location"] == "/knowledge-base/?paper=sources%2Fa.md&offset=12"
    assert clients == []


def test_proxy_preserves_prefix_and_auth_callback_without_exposing_portal_credentials(monkeypatch):
    requests = []

    def upstream(request):
        requests.append(request)
        return httpx.Response(
            302,
            headers=[
                ("Location", "http://localhost:1234/knowledge-base/?paper=a"),
                (
                    "Set-Cookie",
                    "dikw_mbweb_session=kb; Path=/knowledge-base; HttpOnly; SameSite=Lax",
                ),
                ("Set-Cookie", "mbportal_iam_session=must-not-forward; Path=/"),
                ("Connection", "keep-alive, X-Upstream-Only"),
                ("X-Upstream-Only", "must-not-forward"),
            ],
            stream=httpx.ByteStream(b""),
        )

    client, clients = fixture(monkeypatch, upstream)
    response = client.get(
        "/knowledge-base/web/auth/callback?code=fixture&state=transaction",
        headers={
            "cookie": "mbportal_iam_session=portal; mbpms_iam_session=pm; dikw_mbweb_session=kb; dikw_mbweb_login=login",
            "authorization": "Bearer portal-secret",
            "x-forwarded-host": "evil.example",
            "origin": "http://localhost:1234",
            "x-dikw-expected-identity": "identity",
        },
        follow_redirects=False,
    )
    assert response.status_code == 302
    assert response.headers["location"].endswith("/knowledge-base/?paper=a")
    assert response.headers.get_list("set-cookie") == [
        "dikw_mbweb_session=kb; Path=/knowledge-base; HttpOnly; SameSite=Lax"
    ]
    assert "connection" not in response.headers
    assert "x-upstream-only" not in response.headers
    sent = requests[0]
    assert (
        sent.url
        == "http://127.0.0.1:4322/knowledge-base/web/auth/callback?code=fixture&state=transaction"
    )
    assert sent.headers["cookie"] == "dikw_mbweb_session=kb; dikw_mbweb_login=login"
    assert "authorization" not in sent.headers
    assert sent.headers["host"] == sent.headers["x-forwarded-host"] == "localhost:1234"
    assert sent.headers["x-forwarded-prefix"] == "/knowledge-base"
    assert sent.headers["x-dikw-expected-identity"] == "identity"
    assert all(item.is_closed for item in clients)


def test_streams_grounded_answer_and_closes_upstream(monkeypatch):
    class Stream(httpx.AsyncByteStream):
        closed = False

        async def __aiter__(self):
            yield b'{"type":"phase"}\n'
            yield b'{"type":"answer"}\n'

        async def aclose(self):
            self.closed = True

    stream = Stream()
    seen = []

    async def upstream(request):
        seen.append(await request.aread())
        assert request.headers["x-dikw-model"] == "shared:deepseek"
        assert request.headers["origin"] == "http://localhost:1234"
        return httpx.Response(200, headers={"Content-Type": "application/x-ndjson"}, stream=stream)

    client, clients = fixture(monkeypatch, upstream)
    response = client.post(
        "/knowledge-base/web/knowledge/research/answer",
        content=b'{"question":"fixture"}',
        headers={
            "content-type": "application/json",
            "x-dikw-model": "shared:deepseek",
            "origin": "http://localhost:1234",
        },
    )
    assert response.status_code == 200
    assert response.content == b'{"type":"phase"}\n{"type":"answer"}\n'
    assert seen == [b'{"question":"fixture"}']
    assert stream.closed and all(item.is_closed for item in clients)


@pytest.mark.parametrize(
    "path",
    [
        b"/knowledge-base/%2e%2e/api",
        b"/knowledge-base/%252e%252e/api",
        b"/knowledge-base/%5capi",
        b"/knowledge-base/%00api",
    ],
)
def test_rejects_encoded_traversal(path):
    request = Request(
        {
            "type": "http",
            "method": "GET",
            "path": path.decode(),
            "raw_path": path,
            "headers": [],
            "query_string": b"",
        }
    )
    with pytest.raises(Exception) as error:
        mount.request_path(request)
    assert error.value.status_code == 400


def test_network_failure_is_sanitized(monkeypatch):
    def upstream(request):
        raise httpx.ConnectError("secret-upstream-detail", request=request)

    client, clients = fixture(monkeypatch, upstream)
    response = client.get("/knowledge-base/")
    assert response.status_code == 503
    assert "secret" not in response.text
    assert all(item.is_closed for item in clients)


def test_portal_middleware_preserves_the_kb_auth_script_policy(monkeypatch):
    from app.main import app

    policy = "default-src 'none'; script-src 'sha256-test'; frame-ancestors http://localhost:1234"

    def upstream(request):
        return httpx.Response(
            200,
            headers={"Content-Security-Policy": policy, "Content-Type": "text/html"},
            stream=httpx.ByteStream(b"<p>auth recovery</p>"),
        )

    fixture(monkeypatch, upstream)
    response = TestClient(app).get("/knowledge-base/")
    assert response.status_code == 200
    assert response.headers["content-security-policy"] == policy


def test_cancelled_connect_closes_client(monkeypatch):
    class Client:
        closed = False

        def build_request(self, *args, **kwargs):
            return None

        async def send(self, *args, **kwargs):
            raise asyncio.CancelledError

        async def aclose(self):
            self.closed = True

    monkeypatch.setattr(mount.settings, "KNOWLEDGE_BASE_UPSTREAM", "http://127.0.0.1:4322")
    client = Client()
    monkeypatch.setattr(mount, "upstream_client", lambda: client)
    request = Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/knowledge-base/",
            "raw_path": b"/knowledge-base/",
            "headers": [],
            "query_string": b"",
        }
    )
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(mount.knowledge_proxy(request))
    assert client.closed
