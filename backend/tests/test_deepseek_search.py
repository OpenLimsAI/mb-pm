"""Official search with selected credentials only; all transport and models are mocked."""

import json
from contextlib import contextmanager

import httpx
import pytest
import test_assistant
import test_solution_ai
import test_solutions
from fastapi import HTTPException

from app.core.config import settings
from app.services import ai, solution_ai, web_search

assistant_client = test_assistant.assistant_client
solution_client = test_solutions.solution_client
OFFICIAL = {
    "provider": "deepseek",
    "base_url": "https://api.deepseek.com/v1",
    "api_key": "selected-official-fake-key",
    "model": "deepseek-v4-pro",
}


def enabled(monkeypatch, provider="deepseek"):
    monkeypatch.setattr(settings, "ASSISTANT_WEB_ENABLED", True)
    monkeypatch.setattr(settings, "ASSISTANT_WEB_PROVIDER", provider)
    # A separately configured key cannot be an implicit fallback.
    monkeypatch.setattr(settings, "ASSISTANT_WEB_API_KEY", "unselected-tavily-fake-key")


def result(**changes):
    return {
        "title": "Public source",
        "url": "https://example.org/research",
        "content": "Public extracted article",
        "summary": "Public summary",
        "snippet": "Public snippet",
        "date": "2026-11-01T12:34:56Z",
        **changes,
    }


def transport(monkeypatch, *, results=None, status=200, body=None):
    calls = []

    @contextmanager
    def stream(method, url, **kwargs):
        calls.append({"method": method, "url": url, **kwargs})
        yield (
            httpx.Response(status, content=body)
            if body is not None
            else httpx.Response(
                status, json={"results": [result()] if results is None else results}
            )
        )

    monkeypatch.setattr(web_search.httpx, "stream", stream)
    return calls


def enterprise(monkeypatch, **changes):
    cfg = {**OFFICIAL, **changes}
    monkeypatch.setattr(
        ai,
        "load_legacy_settings",
        lambda: {"provider": cfg["provider"], "providers": {cfg["provider"]: cfg}},
    )
    return cfg


@pytest.mark.parametrize(
    "base",
    [
        "https://api.deepseek.com",
        "https://api.deepseek.com/",
        "https://api.deepseek.com/v1",
        "https://api.deepseek.com/v1/",
        "https://api.deepseek.com:443/v1",
    ],
)
def test_official_search_uses_selected_key_at_fixed_endpoint(monkeypatch, base):
    enabled(monkeypatch)
    calls = transport(monkeypatch)
    refs = web_search.search(
        "Public question", provider="deepseek", cfg={**OFFICIAL, "base_url": base}
    )
    assert refs[0]["excerpt"] == "Public extracted article"
    assert refs[0]["published_at"] == "2026-11-01T12:34:56Z"
    assert calls[0]["url"] == web_search.DEEPSEEK_ENDPOINT
    assert calls[0]["headers"]["Authorization"] == "Bearer selected-official-fake-key"
    assert calls[0]["json"] == {"query": "Public question", "count": 5, "need_content": True}
    assert calls[0]["follow_redirects"] is False and calls[0]["trust_env"] is False


@pytest.mark.parametrize(
    "provider,base",
    [
        ("deepseek", "https://proxy.example/v1"),
        ("custom", "https://api.deepseek.com/v1"),
        ("openai", "https://api.deepseek.com"),
        ("deepseek", "http://api.deepseek.com"),
        ("deepseek", "https://api.deepseek.com.example.org/v1"),
        ("deepseek", "https://api.deepseek.com:8443/v1"),
        ("deepseek", "https://user:pass@api.deepseek.com/v1"),
        ("deepseek", "https://api.deepseek.com/v1?secret=1"),
        ("deepseek", "https://api.deepseek.com/v1#fragment"),
        ("deepseek", "https://api.deepseek.com/v1/tools/search"),
        ("deepseek", "https://api.deepseek.com./v1"),
    ],
)
def test_nonofficial_or_custom_credentials_never_leave_application(monkeypatch, provider, base):
    enabled(monkeypatch)
    calls = transport(monkeypatch)
    cfg = {**OFFICIAL, "base_url": base, "api_key": "proxy-private-fake-key"}
    assert not web_search.capabilities(provider=provider, cfg=cfg)["web_search"]["configured"]
    with pytest.raises(HTTPException) as exc:
        web_search.search("Public question", provider=provider, cfg=cfg)
    assert exc.value.headers["X-Assistant-Error-Code"] == "web_not_configured"
    assert calls == [] and "proxy-private-fake-key" not in str(exc.value.detail)


@pytest.mark.parametrize(
    "raw,summary,snippet,expected",
    [
        ("Extracted", "Summary", "Snippet", "Extracted"),
        ("", "Summary", "Snippet", "Summary"),
        ("  ", "", "Snippet", "Snippet"),
        ([], "Summary", "Snippet", "Summary"),
    ],
)
def test_search_content_fallback_and_bounded_results(monkeypatch, raw, summary, snippet, expected):
    enabled(monkeypatch)
    transport(
        monkeypatch,
        results=[
            result(content=raw, summary=summary, snippet=snippet),
            result(url="https://127.0.0.1/private"),
            result(content="a" * 20_000, url="https://example.org/second", date=None),
        ],
    )
    refs = web_search.search("Public question", provider="deepseek", cfg=OFFICIAL)
    assert len(refs) == 2 and refs[0]["excerpt"] == expected
    assert len(refs[1]["excerpt"]) == 8_000 and refs[1]["published_at"] is None


@pytest.mark.parametrize(
    "status,code",
    [
        (401, "web_auth"),
        (402, "web_balance"),
        (429, "web_rate_limit"),
        (408, "web_timeout"),
        (504, "web_timeout"),
        (500, "web_unavailable"),
    ],
)
def test_official_errors_are_distinct_and_never_echo_response(monkeypatch, status, code):
    enabled(monkeypatch)
    transport(monkeypatch, status=status, body=b"private-upstream-key-or-query")
    with pytest.raises(HTTPException) as exc:
        web_search.search("Public question", provider="deepseek", cfg=OFFICIAL)
    assert exc.value.headers["X-Assistant-Error-Code"] == code
    assert "private-" not in exc.value.detail
    if status == 402:
        assert exc.value.status_code == 402 and "余额" in exc.value.detail


def test_official_empty_results_are_distinct_from_service_failure(monkeypatch):
    enabled(monkeypatch)
    transport(monkeypatch, results=[])
    with pytest.raises(HTTPException) as exc:
        web_search.search("Public question", provider="deepseek", cfg=OFFICIAL)
    assert (
        exc.value.status_code == 422
        and exc.value.headers["X-Assistant-Error-Code"] == "web_no_results"
    )


def test_long_unicode_query_keeps_topic_and_newest_followup_and_discloses_shortening(monkeypatch):
    enabled(monkeypatch)
    calls = transport(monkeypatch)
    model_calls = []
    question = "柿子脱涩主题😀 " + "旧背景" * 100 + "\n追问：请重点比较2026年的新结果"

    def model(_provider, _cfg, messages, **_kwargs):
        model_calls.append(messages)
        return "Public evidence [1]", {}

    monkeypatch.setattr(ai, "chat", model)
    content, _ = web_search.answer(
        question, selected={"kind": "system"}, provider="deepseek", cfg=OFFICIAL
    )
    query = calls[0]["json"]["query"]
    assert len(query) == 128 and query.startswith("柿子脱涩主题😀")
    assert query.endswith("追问：请重点比较2026年的新结果")
    assert json.loads(model_calls[0][-1]["content"])["question"] == question
    assert "检索说明" in content and "短检索词" in content


def test_capability_tracks_current_selected_profile_without_other_key_fallback(
    assistant_client, monkeypatch
):
    f = assistant_client
    enabled(monkeypatch)
    enterprise(monkeypatch, api_key="enterprise-fake-key")
    profiles = [
        test_solution_ai.profile(
            id="official",
            base_url="https://api.deepseek.com/v1",
            api_key="personal-official-fake-key",
        ),
        test_solution_ai.profile(
            id="proxy", base_url="https://proxy.example/v1", api_key="proxy-private-fake-key"
        ),
    ]
    assert test_solution_ai.save(f, profiles, default="official").status_code == 200
    endpoint = test_assistant.PREFIX + "/capabilities"
    for model in ("enterprise", "system", "shared:official", None):
        response = f.client.get(endpoint, params={"model_profile_id": model} if model else {})
        assert response.status_code == 200
        assert response.json()["web_search"]["configured"] is True
        assert response.json()["web_search"]["provider"] == "deepseek"
        assert "fake-key" not in response.text and "api.deepseek.com" not in response.text
    for model in ("shared:proxy", "retrieval", "missing"):
        response = f.client.get(endpoint, params={"model_profile_id": model})
        assert response.status_code == 200 and not response.json()["web_search"]["configured"]
        assert "fake-key" not in response.text and "proxy.example" not in response.text
    f.login("other")
    assert f.client.get(endpoint, params={"model_profile_id": "shared:official"}).json()[
        "web_search"
    ]["configured"]


def test_tavily_capability_does_not_claim_generation_ready_without_selected_enterprise_key(
    assistant_client, monkeypatch
):
    f = assistant_client
    enabled(monkeypatch, "tavily")
    enterprise(monkeypatch, api_key="")
    cap = f.client.get(
        test_assistant.PREFIX + "/capabilities", params={"model_profile_id": "system"}
    )
    assert (
        not cap.json()["web_search"]["configured"] and "密钥" in cap.json()["web_search"]["message"]
    )


@pytest.mark.parametrize(
    "selected", ["enterprise", "official", None], ids=["enterprise", "private", "account-default"]
)
def test_personal_search_uses_exact_selected_key_and_excludes_private_context(
    assistant_client, monkeypatch, selected
):
    f = assistant_client
    enabled(monkeypatch)
    enterprise(monkeypatch, api_key="enterprise-selected-fake-key")
    if selected in ("official", None):
        assert (
            test_solution_ai.save(
                f,
                [
                    test_solution_ai.profile(
                        id="official",
                        base_url="https://api.deepseek.com",
                        api_key="private-selected-fake-key",
                    )
                ],
                default="official",
            ).status_code
            == 200
        )
        monkeypatch.setattr(
            solution_ai, "chat", lambda *_args, **_kwargs: ("Public result [1]", {})
        )
    else:
        monkeypatch.setattr(ai, "chat", lambda *_args, **_kwargs: ("Public result [1]", {}))
    calls = transport(monkeypatch)
    task = test_assistant.create(f, instructions="private-task-instructions")
    response = test_assistant.question(
        f,
        task,
        model_profile_id="shared:official" if selected == "official" else selected,
        answer_mode="web",
        data_sources=[],
        question="柿子脱涩最新公开研究",
        context="private-reference-material",
    )
    assert response.status_code == 200, response.text
    assert response.json()["messages"][-1]["answer_mode"] == "web"
    expected = (
        "enterprise-selected-fake-key" if selected == "enterprise" else "private-selected-fake-key"
    )
    assert calls[0]["headers"]["Authorization"] == "Bearer " + expected
    assert calls[0]["json"] == {"query": "柿子脱涩最新公开研究", "count": 5, "need_content": True}
    assert "private-" not in json.dumps(calls[0]["json"])


def test_native_response_and_total_content_stay_bounded(monkeypatch):
    enabled(monkeypatch)
    transport(monkeypatch, body=b"x" * 1_000_001)
    with pytest.raises(HTTPException) as exc:
        web_search.search("Public question", provider="deepseek", cfg=OFFICIAL)
    assert exc.value.headers["X-Assistant-Error-Code"] == "web_invalid_response"
    monkeypatch.setattr(settings, "ASSISTANT_WEB_MAX_RESULTS", 8)
    calls = transport(
        monkeypatch,
        results=[
            result(url=f"https://example.org/{index}", content="a" * 20_000) for index in range(8)
        ],
    )
    refs = web_search.search("Public question", provider="deepseek", cfg=OFFICIAL)
    assert calls[0]["json"]["count"] == 8
    assert len(refs) <= 8 and sum(len(item["excerpt"]) for item in refs) <= 40_000


def test_balance_failure_preserves_personal_draft_and_diagnostic(assistant_client, monkeypatch):
    f = assistant_client
    enabled(monkeypatch)
    enterprise(monkeypatch)
    transport(monkeypatch, status=402, body=b"private-upstream-detail")
    task = test_assistant.create(f)
    response = test_assistant.question(f, task, answer_mode="web", question="最新公开研究")
    assert response.status_code == 402 and "余额不足" in response.json()["detail"]
    assert response.headers["X-Assistant-Error-Code"] == "web_balance"
    assert response.headers["X-Assistant-Diagnostic-ID"]
    assert not f.calls and "private-upstream-detail" not in response.text
    assert f.client.get(f"{test_assistant.PREFIX}/{task['id']}").json() == task


def test_proxy_profile_web_request_does_not_send_key_to_official_or_fallback(
    assistant_client, monkeypatch
):
    f = assistant_client
    enabled(monkeypatch)
    enterprise(monkeypatch)
    assert (
        test_solution_ai.save(
            f,
            [test_solution_ai.profile(id="proxy", api_key="proxy-private-fake-key")],
            default="proxy",
        ).status_code
        == 200
    )
    calls = transport(monkeypatch)
    task = test_assistant.create(f)
    response = test_assistant.question(
        f, task, model_profile_id="shared:proxy", answer_mode="web", question="最新研究进展"
    )
    assert response.status_code == 503 and "当前模型未接入联网搜索" in response.json()["detail"]
    assert calls == [] and not f.calls
    assert f.client.get(f"{test_assistant.PREFIX}/{task['id']}").json()["messages"] == []


def test_report_search_uses_private_selected_key_and_retains_verified_citation(
    assistant_client, monkeypatch
):
    f = assistant_client
    enabled(monkeypatch)
    enterprise(monkeypatch)
    assert (
        test_solution_ai.save(
            f,
            [
                test_solution_ai.profile(
                    id="official",
                    base_url="https://api.deepseek.com/v1",
                    api_key="report-selected-fake-key",
                )
            ],
            default="official",
        ).status_code
        == 200
    )
    monkeypatch.setattr(
        solution_ai, "chat", lambda *_args, **_kwargs: ("Public report result [1]", {})
    )
    calls = transport(monkeypatch)
    report = test_solutions.create(f)
    response = test_solutions.question(
        f,
        report,
        model_profile_id="shared:official",
        answer_mode="web",
        question="柿子脱涩最新公开研究",
        context="private-report-context",
    )
    assert response.status_code == 200, response.text
    assert response.json()["answer_mode"] == "web" and response.json()["references"]
    assert calls[0]["headers"]["Authorization"] == "Bearer report-selected-fake-key"
    assert "private-report-context" not in json.dumps(calls[0]["json"])
