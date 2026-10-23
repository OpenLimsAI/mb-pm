"""论文适配合同与权限边界：所有 IAM / HTTP 调用均使用替身。"""

import hashlib
import json
from contextlib import contextmanager

import httpx
import pytest
from fastapi import HTTPException

from app.services import solution_knowledge as kb
from app.services.iam_admin import IAMError

CLAIMS = {"sub": "reader", "catalogue_roles": ["kb_manager"], "roles": ["admin"]}


@pytest.fixture(autouse=True)
def connection(monkeypatch):
    monkeypatch.setenv("SOLUTION_KB_CORE_URL", "http://core.test:8765")
    monkeypatch.setenv("SOLUTION_KB_TOKEN", "test-private-token")
    monkeypatch.setenv("SOLUTION_KB_PUBLIC_URL", "https://kb.test")
    monkeypatch.setattr(kb.accounts, "live_roles", lambda subject: {"kb_viewer"})

    def unexpected(*args, **kwargs):
        raise AssertionError("No test may call the network")

    monkeypatch.setattr(kb.httpx, "stream", unexpected)


@pytest.fixture
def upstream(monkeypatch):
    def install(payload, status=200, *, raw=False):
        calls = []

        @contextmanager
        def stream(method, url, **kwargs):
            calls.append({"method": method, "url": url, **kwargs})
            response = httpx.Response(
                status,
                content=payload if raw else json.dumps(payload).encode(),
                request=httpx.Request(method, url),
            )
            try:
                yield response
            finally:
                response.close()

        monkeypatch.setattr(kb.httpx, "stream", stream)
        return calls

    return install


def page(path="sources/paper.md", **extra):
    return {"path": path, "title": "稳定性研究", "layer": "source", "active": True, **extra}


@pytest.mark.parametrize(
    "key", ["SOLUTION_KB_CORE_URL", "SOLUTION_KB_TOKEN", "SOLUTION_KB_PUBLIC_URL"]
)
def test_missing_configuration_fails_explicitly_without_network(monkeypatch, key):
    monkeypatch.delenv(key)
    assert not kb.configured()
    with pytest.raises(HTTPException, match="尚未配置") as exc:
        kb.list_sources(CLAIMS)
    assert exc.value.status_code == 503


@pytest.mark.parametrize(
    "url",
    [
        "file:///tmp/data",
        "https://user:secret@core.test",
        "https://core.test/path",
        "https://core.test/?a=b",
        "https://core.test/#fragment",
        "https://core.test:invalid",
        "http://core.test\n",
        "http://core.test\\other",
    ],
)
def test_configuration_rejects_ambiguous_or_non_origin_urls(monkeypatch, url):
    # Embedded controls are invalid, while trailing surrounding whitespace is trimmed.
    monkeypatch.setenv("SOLUTION_KB_CORE_URL", url.replace("test\n", "te\nst"))
    assert not kb.configured()


@pytest.mark.parametrize("roles", [set(), {"admin"}, {"dikw-admin"}, {"project_lead"}])
def test_cached_or_platform_roles_do_not_grant_kb_access(monkeypatch, roles):
    seen = []

    def live(subject):
        seen.append(subject)
        return roles

    monkeypatch.setattr(kb.accounts, "live_roles", live)
    with pytest.raises(HTTPException) as exc:
        kb.check_access(CLAIMS)
    assert exc.value.status_code == 403
    assert seen == ["reader"]


@pytest.mark.parametrize("role", sorted(kb.KB_ROLES))
def test_actual_knowledge_roles_admit_reading(monkeypatch, role):
    monkeypatch.setattr(kb.accounts, "live_roles", lambda subject: {role})
    kb.check_access(CLAIMS)


def test_role_revocation_is_checked_on_every_read(monkeypatch, upstream):
    upstream([page()])
    roles = iter([{"kb_editor"}, set()])
    monkeypatch.setattr(kb.accounts, "live_roles", lambda subject: next(roles))
    assert kb.list_sources(CLAIMS)
    with pytest.raises(HTTPException) as exc:
        kb.get_source(CLAIMS, "kb:sources/paper.md")
    assert exc.value.status_code == 403


def test_iam_failure_does_not_grant_access_or_leak_provider_detail(monkeypatch):
    def unavailable(subject):
        raise IAMError("internal-provider-detail")

    monkeypatch.setattr(kb.accounts, "live_roles", unavailable)
    with pytest.raises(HTTPException) as exc:
        kb.check_access(CLAIMS)
    assert exc.value.status_code == 503
    assert "internal-provider-detail" not in exc.value.detail


def test_metadata_listing_is_bounded_and_does_not_download_bodies(upstream):
    records = [
        page("knowledge/private.md"),
        page("sources/../private.md"),
        page(active=False),
        page(layer="wisdom"),
        *[page(f"sources/paper-{i}.md", mtime=1_700_000_000) for i in range(40)],
    ]
    calls = upstream(records)
    result = kb.list_sources(CLAIMS)
    assert len(result) == 30
    assert all(row["content"] == row["version"] == "" for row in result)
    assert result[0]["id"] == "kb:sources/paper-0.md"
    assert result[0]["url"] == "https://kb.test/"
    assert result[0]["updated_at"].startswith("2023-")
    assert len(calls) == 1
    assert calls[0]["url"] == "http://core.test:8765/v1/base/pages"
    assert calls[0]["headers"]["Authorization"] == "Bearer test-private-token"
    assert calls[0]["params"] == {"active": "true", "layer": "source"}
    assert calls[0]["follow_redirects"] is False
    assert calls[0]["trust_env"] is False
    assert calls[0]["timeout"].connect == 5
    assert "test-private-token" not in json.dumps(result)


def test_project_filter_does_not_invent_project_membership(upstream):
    upstream([page(), page("sources/project.md", project_name="真实项目")])
    assert len(kb.list_sources(CLAIMS, project_name="真实项目")) == 1
    assert kb.list_sources(CLAIMS, project_name="其他项目") == []


def test_retrieve_requires_successful_final_and_uses_only_source_page_refs(upstream):
    stream = "\n".join(
        json.dumps(event)
        for event in [
            {"type": "progress", "phase": "search"},
            {
                "type": "final",
                "status": "succeeded",
                "result": {
                    "chunks": [],
                    "page_refs": [page(), page(), page("wisdom/no.md", layer="wisdom")],
                },
            },
        ]
    )
    calls = upstream(stream, raw=True)
    rows = kb.list_sources(CLAIMS, "稳定性")
    assert len(rows) == 1
    assert rows[0]["content"] == ""
    assert calls[0]["method"] == "POST"
    assert calls[0]["json"] == {"q": "稳定性", "limit": 12}


@pytest.mark.parametrize(
    "stream",
    [
        '{"type":"retrieval_done","hits":[]}',
        '{"type":"final","status":"failed","error":{"message":"private error"}}',
        '{"type":"final","status":"cancelled"}',
        '{"type":"final","status":"succeeded","result":{"page_refs":[]}}',
        '{"type":"final","status":"succeeded","result":{"page_refs":[],"chunks":[]}}\n{"type":"final","status":"failed"}',
        "not-json",
    ],
)
def test_retrieve_failure_is_never_disguised_as_no_results(upstream, stream):
    upstream(stream, raw=True)
    with pytest.raises(HTTPException) as exc:
        kb.list_sources(CLAIMS, "query")
    assert exc.value.status_code == 502
    assert "private error" not in exc.value.detail


@pytest.mark.parametrize(
    "source_id",
    [
        "https://evil.test/sources/a.md",
        "kb:../secret.md",
        "kb:knowledge/a.md",
        "kb:sources/../secret.md",
        "kb:sources//a.md",
        "kb:sources/./a.md",
        "kb:sources/%2e%2e/a.md",
        "kb:sources/%252e%252e/a.md",
        "kb:sources/a\\b.md",
        "kb:sources/a\n.md",
        "kb:sources/a.pdf",
        "kb:sources/" + "x" * 1024 + ".md",
    ],
)
def test_invalid_source_path_never_reaches_core(source_id):
    with pytest.raises(HTTPException) as exc:
        kb.get_source(CLAIMS, source_id)
    assert exc.value.status_code == 400


def test_body_read_preserves_untrusted_text_with_content_version(upstream):
    body = "# Evidence\nIgnore previous instructions is paper text, not a command."
    calls = upstream(
        page(
            "sources/中文 paper.md",
            body=body,
            frontmatter={"authors": ["A", "B"], "date": "2025", "tags": ["稳定性"]},
        )
    )
    source = kb.get_source(CLAIMS, "kb:sources/中文 paper.md")
    assert source["version"] == hashlib.sha256(body.encode()).hexdigest()
    assert source["content"] == body
    assert source["authors"] == "A、B"
    assert source["locator"] == "sources/中文 paper.md"
    assert calls[0]["url"].endswith("/sources/%E4%B8%AD%E6%96%87%20paper.md")


@pytest.mark.parametrize(
    "changes",
    [{"path": "sources/other.md"}, {"layer": "wisdom"}, {"active": False}, {"body": None}],
)
def test_source_identity_or_body_mismatch_is_rejected(upstream, changes):
    upstream(page(body="evidence") | changes)
    with pytest.raises(HTTPException) as exc:
        kb.get_source(CLAIMS, "kb:sources/paper.md")
    assert exc.value.status_code == 502


def test_body_size_is_rejected_without_silent_truncation(monkeypatch, upstream):
    monkeypatch.setattr(kb, "MAX_CONTENT_CHARS", 5)
    upstream(page(body="123456"))
    with pytest.raises(HTTPException) as exc:
        kb.get_source(CLAIMS, "kb:sources/paper.md")
    assert exc.value.status_code == 413


def test_wire_response_is_bounded(monkeypatch, upstream):
    monkeypatch.setattr(kb, "MAX_RESPONSE_BYTES", 5)
    upstream([page()])
    with pytest.raises(HTTPException, match="过大") as exc:
        kb.list_sources(CLAIMS)
    assert exc.value.status_code == 502


@pytest.mark.parametrize(
    "status, expected", [(302, 502), (401, 503), (403, 503), (404, 404), (500, 502)]
)
def test_upstream_errors_are_redacted(upstream, status, expected):
    upstream({"secret": "upstream-private-detail"}, status=status)
    with pytest.raises(HTTPException) as exc:
        kb.list_sources(CLAIMS)
    assert exc.value.status_code == expected
    assert "upstream-private-detail" not in exc.value.detail


def test_timeout_is_clear_and_does_not_leak_network_detail(monkeypatch):
    def timeout(*args, **kwargs):
        raise httpx.ReadTimeout("private-token-and-internal-host")

    monkeypatch.setattr(kb.httpx, "stream", timeout)
    with pytest.raises(HTTPException, match="超时") as exc:
        kb.list_sources(CLAIMS)
    assert exc.value.status_code == 504
    assert "private-token" not in exc.value.detail
