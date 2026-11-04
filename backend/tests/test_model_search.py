"""Selected-provider search contracts; transports and model completions are mocked."""

import json
from contextlib import contextmanager

import httpx
import pytest
import test_assistant
import test_deepseek_search as native
import test_solution_ai
from fastapi import HTTPException

from app.core.config import settings
from app.services import ai, solution_ai, web_search

assistant_client = test_assistant.assistant_client
solution_client = native.solution_client
KIMI = {
    "provider": "kimi",
    "base_url": "https://api.moonshot.cn/v1",
    "api_key": "selected-kimi-fake-key",
    "model": "kimi-k3.1-pro",
}


def result(**changes):
    return {
        "title": "Public study",
        "url": "https://example.org/study",
        "text": "Full public text",
        "snippet": "Public snippet",
        "date": "2026-11-01",
        **changes,
    }


def transport(monkeypatch, results=None, **kwargs):
    return native.transport(
        monkeypatch,
        body=json.dumps({"search_results": [result()] if results is None else results}).encode(),
        **kwargs,
    )


@pytest.mark.parametrize("setting", ["model", "deepseek"])
@pytest.mark.parametrize("host", ["api.moonshot.cn", "api.moonshot.ai"])
@pytest.mark.parametrize("suffix", ["", "/", "/v1", "/v1/", ":443/v1"])
def test_selected_kimi_region_and_key_are_used_for_search(monkeypatch, setting, host, suffix):
    native.enabled(monkeypatch, setting)
    calls = transport(monkeypatch)
    cfg = {**KIMI, "base_url": f"https://{host}{suffix}"}
    cap = web_search.capabilities(provider="kimi", cfg=cfg)["web_search"]
    assert cap["configured"] and cap["provider"] == "kimi" and "Kimi" in cap["message"]
    assert not calls  # Configuration checks never initiate paid search requests.
    refs = web_search.search("Public question", provider="kimi", cfg=cfg)
    assert refs[0]["excerpt"] == "Full public text"
    assert refs[0]["published_at"] == "2026-11-01"
    assert calls[0]["url"] == f"https://{host}/v1/tools/search"
    assert calls[0]["headers"]["Authorization"] == "Bearer selected-kimi-fake-key"
    assert calls[0]["json"] == {
        "text_query": "Public question",
        "limit": 5,
        "include_content": True,
        "timeout_seconds": 15,
    }
    assert not calls[0]["follow_redirects"] and not calls[0]["trust_env"]


@pytest.mark.parametrize(
    "base",
    [
        "https://proxy.example/v1",
        "https://api.deepseek.com/v1",
        "http://api.moonshot.cn/v1",
        "https://api.moonshot.cn.example.org/v1",
        "https://api.moonshot.cn./v1",
        "https://api.moonshot.cn:8443/v1",
        "https://user:key@api.moonshot.cn/v1",
        "https://api.moonshot.cn/v1?",
        "https://api.moonshot.cn/v1#",
        "https://api.moonshot.cn/v1?key=secret",
        "https://api.moonshot.cn/v1/tools/search",
        "https://api.moonshot.cn/v1\\anything",
        " https://api.moonshot.cn/v1",
        "https://api.moonshot.cn/\nv1",
    ],
)
def test_kimi_credentials_do_not_cross_origin_or_leave_for_unsupported_address(monkeypatch, base):
    native.enabled(monkeypatch, "model")
    calls = transport(monkeypatch)
    cfg = {**KIMI, "base_url": base}
    assert not web_search.capabilities(provider="kimi", cfg=cfg)["web_search"]["configured"]
    with pytest.raises(HTTPException) as exc:
        web_search.search("Public question", provider="kimi", cfg=cfg)
    assert exc.value.headers["X-Assistant-Error-Code"] == "web_not_configured"
    assert calls == []


@pytest.mark.parametrize("provider", ["deepseek", "custom", "openai", "minimax"])
def test_official_kimi_host_alone_does_not_authorize_other_provider_keys(monkeypatch, provider):
    native.enabled(monkeypatch, "model")
    calls = transport(monkeypatch)
    with pytest.raises(HTTPException):
        web_search.search("Public question", provider=provider, cfg={**KIMI, "provider": provider})
    assert not calls


@pytest.mark.parametrize("key", ["", "  ", None])
def test_kimi_missing_key_is_reported_for_selected_provider(monkeypatch, key):
    native.enabled(monkeypatch, "model")
    calls = transport(monkeypatch)
    cap = web_search.capabilities(provider="kimi", cfg={**KIMI, "api_key": key})["web_search"]
    assert not cap["configured"] and "Kimi" in cap["message"] and "密钥" in cap["message"]
    assert not calls


def test_explicit_tavily_remains_independent_and_never_receives_model_key(monkeypatch):
    native.enabled(monkeypatch, "tavily")
    calls = native.transport(monkeypatch, results=[{"raw_content": "Public", **result()}])
    assert web_search.capabilities(provider="kimi", cfg=KIMI)["web_search"]["provider"] == "tavily"
    web_search.search("Public question", provider="kimi", cfg=KIMI)
    assert calls[0]["url"] == web_search.TAVILY_ENDPOINT
    assert calls[0]["headers"]["Authorization"] == "Bearer unselected-tavily-fake-key"
    assert "selected-kimi" not in json.dumps(calls[0], default=str)


def test_disabled_search_prevents_all_providers(monkeypatch):
    native.enabled(monkeypatch, "model")
    monkeypatch.setattr(settings, "ASSISTANT_WEB_ENABLED", False)
    calls = transport(monkeypatch)
    for provider, cfg in (("kimi", KIMI), ("deepseek", native.OFFICIAL)):
        assert not web_search.capabilities(provider=provider, cfg=cfg)["web_search"]["configured"]
        with pytest.raises(HTTPException):
            web_search.search("Public question", provider=provider, cfg=cfg)
    assert not calls


def test_kimi_parses_only_documented_fields_with_content_and_url_bounds(monkeypatch):
    native.enabled(monkeypatch, "model")
    monkeypatch.setattr(settings, "ASSISTANT_WEB_MAX_RESULTS", 8)
    calls = transport(
        monkeypatch,
        results=[
            result(text="", snippet="Fallback"),
            result(text="duplicate"),
            result(url="https://127.0.0.1/private"),
            *[
                result(text="x" * 20_000, url=f"https://example.org/{index}", date="unknown")
                for index in range(5)
            ],
        ],
    )
    refs = web_search.search("Public question", provider="kimi", cfg=KIMI)
    assert calls[0]["json"]["limit"] == 8
    assert refs[0]["excerpt"] == "Fallback"
    assert len(refs) == 6 and refs[-1]["published_at"] is None
    assert all(len(ref["excerpt"]) <= 8000 for ref in refs)
    assert sum(len(ref["excerpt"]) for ref in refs) == 40000


@pytest.mark.parametrize(
    "body,code",
    [
        (b'{"search_results": []}', "web_no_results"),
        (b'{"results": []}', "web_invalid_response"),
        (b'{"search_results": {}}', "web_invalid_response"),
        (b'{"search_results": [null, "bad"]}', "web_no_results"),
        (b"not-json", "web_invalid_response"),
        (b"x" * 1_000_001, "web_invalid_response"),
    ],
    ids=["empty", "other-vendor", "wrong-type", "invalid-items", "malformed", "oversize"],
)
def test_kimi_invalid_responses_are_not_misrepresented_as_sources(monkeypatch, body, code):
    native.enabled(monkeypatch, "model")
    native.transport(monkeypatch, body=body)
    with pytest.raises(HTTPException) as exc:
        web_search.search("Public question", provider="kimi", cfg=KIMI)
    assert exc.value.headers["X-Assistant-Error-Code"] == code


@pytest.mark.parametrize(
    "status,code",
    [
        (401, "web_auth"),
        (403, "web_auth"),
        (402, "web_balance"),
        (429, "web_rate_limit"),
        (408, "web_timeout"),
        (504, "web_timeout"),
        (302, "web_unavailable"),
        (502, "web_unavailable"),
    ],
)
def test_kimi_errors_remain_distinct_and_do_not_expose_response(monkeypatch, status, code):
    native.enabled(monkeypatch, "model")
    calls = native.transport(monkeypatch, status=status, body=b"private-upstream-secret")
    with pytest.raises(HTTPException) as exc:
        web_search.search("Public question", provider="kimi", cfg=KIMI)
    assert exc.value.headers["X-Assistant-Error-Code"] == code
    assert "private-" not in exc.value.detail and len(calls) == 1


def test_kimi_uses_own_query_limit_and_keeps_private_synthesis_context_out_of_search(monkeypatch):
    native.enabled(monkeypatch, "deepseek")  # Existing production setting follows Kimi too.
    calls = transport(monkeypatch)
    model_calls = []

    def model(provider, cfg, messages, **kwargs):
        model_calls.append((provider, cfg, json.loads(messages[-1]["content"])))
        return "Public evidence [1]", {}

    monkeypatch.setattr(ai, "chat", model)
    question = "Public theme " + "context " * 300 + "latest constraint"
    content, _ = web_search.answer(
        question,
        selected={"kind": "system"},
        provider="kimi",
        cfg=KIMI,
        context_messages=[{"role": "user", "content": "private-task-instructions"}],
    )
    assert len(calls[0]["json"]["text_query"]) == 2000
    assert calls[0]["json"]["text_query"].endswith("latest constraint")
    assert "private-task" not in json.dumps(calls[0]["json"])
    assert model_calls[0][0] == "kimi" and model_calls[0][1] == KIMI
    assert model_calls[0][2]["question"] == question and "检索说明" in content
    assert "private-task-instructions" in json.dumps(model_calls[0][2])


@pytest.mark.parametrize("failure", [httpx.ReadTimeout("secret"), httpx.ConnectError("secret")])
def test_kimi_transport_failure_does_not_fall_back_or_expose_details(monkeypatch, failure):
    native.enabled(monkeypatch, "model")
    calls = []

    @contextmanager
    def failed(method, url, **kwargs):
        calls.append(url)
        raise failure
        yield  # pragma: no cover

    monkeypatch.setattr(web_search.httpx, "stream", failed)
    with pytest.raises(HTTPException) as exc:
        web_search.search("Public question", provider="kimi", cfg=KIMI)
    expected = "web_timeout" if isinstance(failure, httpx.TimeoutException) else "web_unavailable"
    assert exc.value.headers["X-Assistant-Error-Code"] == expected
    assert "secret" not in exc.value.detail
    assert calls == ["https://api.moonshot.cn/v1/tools/search"]


def test_kimi_total_budget_is_checked_and_timeout_allows_server_search(monkeypatch):
    native.enabled(monkeypatch, "model")
    calls = transport(monkeypatch)
    ticks = iter([0.0, 21.0])
    monkeypatch.setattr(web_search, "monotonic", lambda: next(ticks))
    with pytest.raises(HTTPException) as exc:
        web_search.search("Public question", provider="kimi", cfg=KIMI)
    assert exc.value.headers["X-Assistant-Error-Code"] == "web_timeout"
    assert calls[0]["timeout"].read > calls[0]["json"]["timeout_seconds"]
    assert calls[0]["timeout"].connect == 5.0


def test_capability_and_actual_search_follow_model_switches(assistant_client, monkeypatch):
    f = assistant_client
    native.enabled(monkeypatch, "deepseek")
    native.enterprise(monkeypatch)
    profiles = [
        test_solution_ai.profile(id="deepseek", **native.OFFICIAL),
        test_solution_ai.profile(id="kimi", **KIMI),
    ]
    assert test_solution_ai.save(f, profiles, default="kimi").status_code == 200
    monkeypatch.setattr(solution_ai, "chat", lambda *_a, **_kw: ("Public evidence [1]", {}))
    for model, provider in (
        ("enterprise", "deepseek"),
        ("kimi", "kimi"),
        (None, "kimi"),
        ("deepseek", "deepseek"),
    ):
        params = {"model_profile_id": model} if model else {}
        cap = f.client.get(test_assistant.PREFIX + "/capabilities", params=params)
        assert cap.status_code == 200 and cap.json()["web_search"]["provider"] == provider
        assert "fake-key" not in cap.text
    for selected, expected_provider in (
        ("kimi", "kimi"),
        ("deepseek", "deepseek"),
        ("kimi", "kimi"),
    ):
        calls = (
            transport(monkeypatch) if expected_provider == "kimi" else native.transport(monkeypatch)
        )
        task = test_assistant.create(f)
        response = test_assistant.question(
            f,
            task,
            model_profile_id=selected,
            answer_mode="web",
            question="最新公开研究",
            context="private-material",
        )
        assert response.status_code == 200, response.text
        assert response.json()["messages"][-1]["answer_mode"] == "web"
        expected = KIMI if expected_provider == "kimi" else native.OFFICIAL
        assert calls[0]["headers"]["Authorization"] == "Bearer " + expected["api_key"]
        assert calls[0]["url"].startswith(expected["base_url"])
        assert "private-material" not in json.dumps(calls[0]["json"])


@pytest.mark.parametrize(
    "question,kind",
    [
        ("上游培养中哪些因素影响抗体片段？", "general"),
        ("请深入分析上游培养中抗体片段的风险及证据", "analysis"),
        ("不用深入分析，简述上游培养中抗体片段的原因", "general"),
    ],
)
def test_web_synthesis_respects_explicit_depth_within_durable_generation(monkeypatch, question, kind):
    from app.services import assistant_generation as generation

    native.enabled(monkeypatch, "model")
    searches = transport(monkeypatch)
    calls = []

    def generate(provider, cfg, messages, **kwargs):
        calls.append((provider, kwargs["kind"]))
        return "Evidence [1]", {}

    monkeypatch.setattr(generation, "call", generate)
    with generation.run_context(lambda fields: None):
        web_search.answer(question, selected={"kind": "system"}, provider="kimi", cfg=KIMI)
    assert calls == [("kimi", kind)]
    assert len(searches) == 1
