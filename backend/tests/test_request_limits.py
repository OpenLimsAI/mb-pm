import asyncio

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from starlette import formparsers
from starlette.exceptions import HTTPException

from app.api.multipart import upload_form
from app.main import app
from app.middleware.request_limits import RequestLimitsMiddleware


@pytest.mark.parametrize("path", ["/api/v1/feedback", "/api/v1/templates/import"])
def test_anonymous_multipart_does_not_parse(path, monkeypatch):
    def unexpected(*args, **kwargs):
        pytest.fail("unauthenticated request started multipart parsing")

    monkeypatch.setattr(formparsers.MultiPartParser, "parse", unexpected)
    with TestClient(app) as client:
        response = client.post(
            path,
            content=b"unparsed upload",
            headers={"Content-Type": "multipart/form-data; boundary=synthetic"},
        )
    assert response.status_code in (401, 403)


async def run_request(middleware, chunks, *, headers=(), delay=0):
    messages = []
    reads = 0

    async def receive():
        nonlocal reads
        await asyncio.sleep(delay)
        if reads >= len(chunks):
            return {"type": "http.disconnect"}
        body = chunks[reads]
        reads += 1
        return {"type": "http.request", "body": body, "more_body": reads < len(chunks)}

    async def send(message):
        messages.append(message)

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "method": "POST",
        "path": "/upload",
        "raw_path": b"/upload",
        "query_string": b"",
        "headers": list(headers),
        "server": ("localhost", 80),
        "client": ("127.0.0.1", 1234),
        "scheme": "http",
        "http_version": "1.1",
    }
    await middleware(scope, receive, send)
    status = next(
        message["status"] for message in messages if message["type"] == "http.response.start"
    )
    return status, reads


def limited_app(**kwargs):
    target = FastAPI()

    @target.post("/upload")
    async def upload(request: Request):
        return {"size": len(await request.body())}

    return RequestLimitsMiddleware(target, **kwargs)


def test_chunked_body_total_is_bounded_without_content_length():
    middleware = limited_app(max_bytes=5)
    assert asyncio.run(run_request(middleware, [b"123", b"456"])) == (413, 2)
    assert middleware.active == 0
    assert asyncio.run(run_request(middleware, [b"12", b"345"])) == (200, 2)


def test_content_length_does_not_bypass_chunked_limit():
    middleware = limited_app(max_bytes=5)
    assert asyncio.run(
        run_request(middleware, [b"123456"], headers=[(b"content-length", b"1")])
    ) == (413, 1)
    assert asyncio.run(
        run_request(middleware, [b"not read"], headers=[(b"content-length", b"6")])
    ) == (413, 0)
    assert asyncio.run(
        run_request(
            middleware,
            [b"not read"],
            headers=[(b"content-length", b"1"), (b"content-length", b"1")],
        )
    ) == (400, 0)
    assert middleware.active == 0


def test_slow_body_timeout_releases_capacity():
    middleware = limited_app(seconds=0.01)
    assert asyncio.run(run_request(middleware, [b"x"], delay=0.05)) == (408, 0)
    assert middleware.active == 0
    assert asyncio.run(run_request(middleware, [b"x"])) == (200, 1)


@pytest.mark.parametrize("status", [408, 413])
def test_aborted_multipart_closes_opened_files(monkeypatch, status):
    files = []
    original = formparsers.SpooledTemporaryFile

    def track(*args, **kwargs):
        file = original(*args, **kwargs)
        files.append(file)
        return file

    monkeypatch.setattr(formparsers, "SpooledTemporaryFile", track)

    async def scenario():
        count = 0

        async def receive():
            nonlocal count
            count += 1
            if count == 1:
                return {
                    "type": "http.request",
                    "body": b'--test\r\nContent-Disposition: form-data; name="file"; filename="test.xlsx"\r\nContent-Type: application/octet-stream\r\n\r\npartial',
                    "more_body": True,
                }
            raise HTTPException(status, "bounded upload")

        request = Request(
            {"type": "http", "headers": [(b"content-type", b"multipart/form-data; boundary=test")]},
            receive,
        )
        with pytest.raises(HTTPException) as caught:
            async with upload_form(request, max_files=1, max_fields=1, max_part_size=100):
                pytest.fail("incomplete upload must not succeed")
        assert caught.value.status_code == status

    asyncio.run(scenario())
    assert files and all(file.closed for file in files)


def test_concurrent_upload_capacity_released_after_cancel():
    async def scenario():
        entered, resume = asyncio.Event(), asyncio.Event()

        async def waiting(scope, receive, send):
            entered.set()
            await resume.wait()

        middleware = RequestLimitsMiddleware(waiting, max_uploads=1)
        scope = {"type": "http", "method": "POST", "path": "/upload", "headers": []}

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        async def send(message):
            pass

        first = asyncio.create_task(middleware(scope, receive, send))
        await entered.wait()
        assert await run_request(middleware, [b"not read"]) == (429, 0)
        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first
        assert middleware.active == 0

    asyncio.run(scenario())


def test_production_lifespan_does_not_run_schema_or_backfills(monkeypatch):
    from app import main

    monkeypatch.setattr(main.settings, "AUTO_MIGRATE_SCHEMA", False)
    monkeypatch.setattr(main.settings, "AUTO_SEED", False)
    for flag in (
        "INFORMATION_WORKER_ENABLED",
        "NOTES_WISDOM_WORKER_ENABLED",
        "ASSISTANT_REQUEST_WORKER_ENABLED",
        "KNOWLEDGE_SOURCE_WORKER_ENABLED",
    ):
        monkeypatch.setattr(main.settings, flag, False)

    def forbidden(*args, **kwargs):
        pytest.fail("runtime performed migration")

    monkeypatch.setattr(main.Base.metadata, "create_all", forbidden)
    for method in ("_ensure_schema", "_backfill_task_order", "_backfill_team_members"):
        monkeypatch.setattr(main, method, forbidden)

    async def scenario():
        async with main.lifespan(main.app):
            pass

    asyncio.run(scenario())


def test_schema_upgrade_aborts_before_writes_on_bad_existing_data(monkeypatch):
    from sqlalchemy import create_engine

    from app.db import upgrade

    engine = create_engine("sqlite://")
    monkeypatch.setattr(upgrade, "engine", engine)
    monkeypatch.setattr(upgrade, "violations", lambda conn: {"ck_tasks_progress": 1})

    def forbidden(*args, **kwargs):
        pytest.fail("migration wrote before validating existing data")

    monkeypatch.setattr(upgrade.Base.metadata, "create_all", forbidden)
    with pytest.raises(RuntimeError, match="ck_tasks_progress"):
        upgrade.main()
    engine.dispose()


def test_upload_deadline_does_not_interrupt_completed_body_response():
    async def scenario():
        calls = 0

        async def receive():
            nonlocal calls
            calls += 1
            if calls == 1:
                return {"type": "http.request", "body": b"x", "more_body": False}
            await asyncio.sleep(0.03)
            return {"type": "http.disconnect"}

        async def target(scope, receive, send):
            assert (await receive())["body"] == b"x"
            assert (await receive())["type"] == "http.disconnect"

        middleware = RequestLimitsMiddleware(target, seconds=0.01)
        await middleware(
            {"type": "http", "method": "POST", "path": "/upload", "headers": []}, receive, None
        )
        assert middleware.active == 0

    asyncio.run(scenario())
