"""Read-only DIKW contracts and native tool loops; all upstreams are isolated."""

import json

import pytest
from fastapi import HTTPException

from app.services import ai
from app.services import assistant_knowledge as tools
from app.services import assistant_tool_chat as runner
from app.services import solution_knowledge as kb

CLAIMS = {"sub": "reader"}


@pytest.fixture(autouse=True)
def isolation(monkeypatch):
    monkeypatch.setenv("SOLUTION_KB_CORE_URL", "http://core.test:8765")
    monkeypatch.setenv("SOLUTION_KB_TOKEN", "server-only-token")
    monkeypatch.setenv("SOLUTION_KB_PUBLIC_URL", "https://kb.test")
    monkeypatch.setattr(kb.accounts, "live_roles", lambda subject: {"kb_viewer"})

    def forbidden(*args, **kwargs):
        raise AssertionError("Unexpected live network")

    monkeypatch.setattr(kb, "_request", forbidden)
    monkeypatch.setattr(ai, "request", forbidden)


def page(path="sources/paper.md", **changes):
    layer = {"sources": "source", "knowledge": "knowledge", "wisdom": "wisdom"}[path.split("/")[0]]
    return {"path": path, "layer": layer, "active": True, "title": "测试资料", **changes}


def upstream(monkeypatch, responses):
    calls, values = [], iter(responses)

    def request(method, path, **kwargs):
        calls.append((method, path, kwargs))
        result = next(values)
        return result if isinstance(result, bytes) else json.dumps(result).encode()

    monkeypatch.setattr(kb, "_request", request)
    return calls


def test_directory_pagination_counts_all_active_pages(monkeypatch):
    rows = [page(f"sources/{i:03}.md") for i in range(63)]
    rows += [
        rows[0],
        page(active=False),
        page("knowledge/derived.md"),
        {"path": "auth.sqlite", "layer": "source", "active": True},
    ]
    calls = upstream(monkeypatch, [rows])
    result = tools.execute(CLAIMS, "list_pages", {"layer": "source", "offset": 50, "limit": 20})
    assert result["total"] == 63 and len(result["items"]) == 13
    assert result["next_offset"] is None and not result["truncated"]
    assert calls[0] == ("GET", "/v1/base/pages", {"params": {"active": "true", "layer": "source"}})


@pytest.mark.parametrize(
    "path",
    [
        "sources/../secret.md",
        "sources/%2e%2e/x.md",
        "sources/x.md?token=x",
        "http://other.test/x.md",
        "auth.sqlite",
        "sources/a\\b.md",
        "sources/\ud800.md",
    ],
)
def test_invalid_path_never_reaches_core(path):
    assert "error" in tools.execute(CLAIMS, "read_page", {"path": path})


@pytest.mark.parametrize(
    "path", ["sources/中文 paper.md", "knowledge/concept/cmc.md", "wisdom/author/decision.md"]
)
def test_read_page_reads_each_layer_in_segments(monkeypatch, path):
    calls = upstream(monkeypatch, [page(path, body="A" * 9000)])
    result = tools.execute(CLAIMS, "read_page", {"path": path, "offset": 8000, "length": 500})
    assert result["body"] == "A" * 500 and result["total_chars"] == 9000
    assert result["next_offset"] == 8500 and result["truncated"]
    assert " " not in calls[0][1]


def test_read_page_rejects_identity_mismatch(monkeypatch):
    upstream(monkeypatch, [page("sources/other.md", body="wrong")])
    with pytest.raises(HTTPException) as exc:
        tools.execute(CLAIMS, "read_page", {"path": "sources/paper.md"})
    assert exc.value.status_code == 502


def test_retrieve_keeps_snippets_and_derived_page_references(monkeypatch):
    result = {
        "page_refs": [page("knowledge/result.md")],
        "chunks": [
            page("knowledge/result.md", text="important evidence"),
            {"path": "auth.sqlite", "text": "secret"},
        ],
    }
    wire = (
        b'{"type":"progress"}\n'
        + json.dumps({"type": "final", "status": "succeeded", "result": result}).encode()
    )
    calls = upstream(monkeypatch, [wire])
    found = tools.execute(CLAIMS, "retrieve_knowledge", {"q": "CMC"})
    assert found["chunks"][0]["text"] == "important evidence"
    assert found["page_refs"][0]["path"] == "knowledge/result.md"
    assert "secret" not in json.dumps(found)
    assert calls[0] == ("POST", "/v1/retrieve", {"payload": {"q": "CMC", "limit": 10}})


@pytest.mark.parametrize(
    "wire",
    [
        b'{"type":"progress"}',
        b'{"type":"final","status":"failed","error":"secret"}',
        b'{"type":"final","status":"succeeded","result":{}}',
        b"bad-json",
    ],
)
def test_failed_retrieval_is_not_treated_as_empty(monkeypatch, wire):
    upstream(monkeypatch, [wire])
    with pytest.raises(HTTPException) as exc:
        tools.execute(CLAIMS, "retrieve_knowledge", {"q": "CMC"})
    assert exc.value.status_code == 502 and "secret" not in exc.value.detail


def test_links_use_actual_incoming_src_path(monkeypatch):
    calls = upstream(
        monkeypatch,
        [
            {
                "path": "knowledge/result.md",
                "incoming": [{"src_path": "knowledge/next.md", "link_type": "wikilink"}],
                "outgoing": [{"dst_path": "sources/original.md", "link_type": "source"}],
            }
        ],
    )
    result = tools.execute(CLAIMS, "page_links", {"path": "knowledge/result.md"})
    assert result["incoming"][0]["src_path"] == "knowledge/next.md"
    assert result["outgoing"][0]["dst_path"] == "sources/original.md"
    assert calls[0][1].endswith("/links")


def test_wisdom_adapts_to_core_0610_pages_api(monkeypatch):
    calls = upstream(
        monkeypatch,
        [
            [
                page("wisdom/one.md", status="published"),
                page("wisdom/two.md", status="draft"),
                page("wisdom/gone.md", status="published", active=False),
            ]
        ],
    )
    result = tools.execute(CLAIMS, "list_wisdom", {"status": "published"})
    assert result["total"] == 1 and result["items"][0]["path"] == "wisdom/one.md"
    assert calls[0] == ("GET", "/v1/base/pages", {"params": {"active": "true", "layer": "wisdom"}})


def test_health_does_not_forward_internal_configuration(monkeypatch):
    upstream(monkeypatch, [{"status": "ok", "provider": {"api_key": "secret"}}])
    assert tools.execute(CLAIMS, "dikw_health", {}) == {"reachable": True, "status": "ok"}


@pytest.mark.parametrize(
    "name,args",
    [
        ("list_pages", {"limit": True}),
        ("retrieve_knowledge", {"q": "x", "limit": 1000}),
        ("list_pages", {"url": "https://elsewhere"}),
        ("read_page", {"path": "sources/x.md", "offset": -1}),
        ("shell", {"command": "rm"}),
        ("propose_maintenance_action", {}),
    ],
)
def test_forbidden_or_invalid_tools_never_reach_core(name, args):
    assert "error" in tools.execute(CLAIMS, name, args)


def test_permission_revocation_checked_on_every_call(monkeypatch):
    values = iter([{"kb_viewer"}, set()])
    monkeypatch.setattr(kb.accounts, "live_roles", lambda sub: next(values))
    upstream(monkeypatch, [[page()]])
    assert tools.execute(CLAIMS, "list_pages", {})["total"] == 1
    with pytest.raises(HTTPException) as exc:
        tools.execute(CLAIMS, "read_page", {"path": "sources/paper.md"})
    assert exc.value.status_code == 403


def test_json_budget_retains_total_and_accurate_resume():
    result = {
        "items": [{"path": str(i), "title": '"' * 1000} for i in range(30)],
        "total": 30,
        "offset": 0,
        "next_offset": None,
    }
    encoded = tools.encoded_result(result, budget=3000)
    parsed = json.loads(encoded)
    assert len(encoded) <= 3000 and parsed["total"] == 30 and parsed["truncated"]
    assert parsed["next_offset"] == len(parsed["items"])


def call(name, args, call_id="call1"):
    return {
        "id": call_id,
        "type": "function",
        "function": {"name": name, "arguments": json.dumps(args)},
    }


def reply(content=None, calls=None):
    return {
        "choices": [
            {"message": {"content": content, "tool_calls": calls or []}, "finish_reason": "stop"}
        ]
    }


def chat(request, provider="deepseek"):
    return runner.chat(
        provider,
        {"model": "test"},
        [{"role": "system", "content": "rules"}, {"role": "user", "content": "question"}],
        CLAIMS,
        request_fn=request,
    )


def test_model_retrieves_then_reads_with_real_tool_results(monkeypatch):
    seen = []
    results = iter(
        [
            reply(calls=[call("retrieve_knowledge", {"q": "CMC"})]),
            reply(calls=[call("read_page", {"path": "sources/paper.md"}, "call2")]),
            reply("根据原文回答 [测试资料](https://kb.test/)"),
        ]
    )
    upstream(
        monkeypatch,
        [
            json.dumps(
                {
                    "type": "final",
                    "status": "succeeded",
                    "result": {"chunks": [page(text="snippet")], "page_refs": [page()]},
                }
            ).encode(),
            page(body="actual paragraph"),
        ],
    )

    def request(provider, cfg, path, body, **kwargs):
        seen.append(body)
        assert path == "/chat/completions" and kwargs["timeout"] <= 60
        return next(results)

    assert "根据原文回答" in chat(request)
    assert "actual paragraph" in json.dumps(seen[-1]) and "tool_call_id" in json.dumps(seen[-1])
    assert {t["function"]["name"] for t in seen[0]["tools"]} == set(tools.REGISTRY)
    assert "server-only-token" not in json.dumps(seen)


def test_ollama_native_objects_and_tool_name(monkeypatch):
    upstream(monkeypatch, [{"status": "ok"}])
    replies = iter(
        [
            {"message": {"tool_calls": [{"function": {"name": "dikw_health", "arguments": {}}}]}},
            {"message": {"content": "服务正常"}},
        ]
    )
    seen = []

    def request(provider, cfg, path, body, **kwargs):
        assert provider == "ollama" and path == "/api/chat"
        seen.append(body)
        return next(replies)

    assert chat(request, "ollama") == "服务正常"
    assert seen[1]["messages"][-1]["tool_name"] == "dikw_health"


@pytest.mark.parametrize("provider", ["deepseek", "kimi"])
def test_provider_required_reasoning_is_preserved(monkeypatch, provider):
    upstream(monkeypatch, [{"status": "ok"}])
    first = reply(calls=[call("dikw_health", {})])
    first["choices"][0]["message"]["reasoning_content"] = "检查服务"
    responses, seen = iter([first, reply("正常")]), []

    def request(provider, cfg, path, body, **kwargs):
        seen.append(body)
        return next(responses)

    assert chat(request, provider) == "正常"
    assert seen[1]["messages"][-2]["reasoning_content"] == "检查服务"


def test_unknown_tool_error_allows_model_to_correct():
    responses, seen = (
        iter([reply(calls=[call("shell", {"command": "bad"})]), reply("无法执行这个操作")]),
        [],
    )

    def request(*args, **kwargs):
        seen.append(args[3])
        return next(responses)

    assert chat(request) == "无法执行这个操作"
    assert "未知或未授权" in seen[1]["messages"][-1]["content"]


def test_round_limit_disables_tools_for_final_answer(monkeypatch):
    monkeypatch.setattr(runner, "MAX_ROUNDS", 1)
    upstream(monkeypatch, [{"status": "ok"}])
    responses, seen = iter([reply(calls=[call("dikw_health", {})]), reply("本轮资料不足")]), []

    def request(*args, **kwargs):
        seen.append(args[3])
        return next(responses)

    assert chat(request) == "本轮资料不足"
    assert "tools" in seen[0] and "tools" not in seen[1]
    assert "查询已结束" in seen[1]["messages"][-1]["content"]


def test_revocation_after_model_answer_is_not_returned(monkeypatch):
    def request(*args, **kwargs):
        monkeypatch.setattr(kb.accounts, "live_roles", lambda sub: set())
        return reply("不能保存失权后的答案")

    with pytest.raises(HTTPException) as exc:
        chat(request)
    assert exc.value.status_code == 403


@pytest.mark.parametrize(
    "result", [reply(""), reply(42), {"choices": []}, {"choices": [{"finish_reason": "length"}]}]
)
def test_invalid_or_truncated_model_response_fails(result):
    with pytest.raises(ai.AIError):
        chat(lambda *args, **kwargs: result)
