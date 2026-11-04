"""Bounded output recovery with deterministic, credential-free model substitutes."""

import json

import pytest
from fastapi import HTTPException

from app.services import ai
from app.services import assistant_diagnostics as diagnostics
from app.services import assistant_generation as generation
from app.services import assistant_generation_policy as policy
from app.services import assistant_tool_chat as runner

CFG = {"base_url": "https://api.deepseek.com/v1", "model": "deepseek-v4-pro", "api_key": "test"}
MESSAGES = [{"role": "system", "content": "rules"}, {"role": "user", "content": "CMC"}]
CLAIMS = {"iss": "test", "sub": "owner"}


def reply(content="", *, limited=False, calls=None):
    return {
        "choices": [
            {
                "message": {
                    "content": content,
                    "tool_calls": calls or [],
                    "reasoning_content": "PRIVATE_REASONING",
                },
                "finish_reason": "length" if limited else "stop",
            }
        ],
        "usage": {"completion_tokens": 10},
    }


@pytest.fixture(autouse=True)
def no_real_network(monkeypatch):
    def forbidden(*_args, **_kwargs):
        pytest.fail("unexpected live model/network call")

    monkeypatch.setattr(ai, "request", forbidden)
    monkeypatch.setattr(generation, "_pinned_open", forbidden)
    monkeypatch.setattr(generation, "_enterprise_open", forbidden)


def knowledge_models(monkeypatch, replies):
    seen, tools, accesses = [], [], []
    values = iter(replies)
    monkeypatch.setattr(runner.solution_knowledge, "check_access", lambda *_: accesses.append(True))
    monkeypatch.setattr(runner.retrieval, "query_variants", lambda q: [q])
    monkeypatch.setattr(runner.retrieval, "rank_result", lambda _q, row, **_kwargs: row)
    monkeypatch.setattr(runner.retrieval, "relevance", lambda *_: {"evidence_eligible": True})

    def execute(_claims, name, args):
        tools.append((name, args))
        if name == "retrieve_knowledge":
            return {
                "chunks": [{"path": "sources/paper.md", "text": "CMC evidence"}],
                "page_refs": [],
            }
        if name == "read_page":
            return {"path": args["path"], "body": "CMC original evidence"}
        raise AssertionError("unexpected tool execution")

    monkeypatch.setattr(runner.knowledge, "execute", execute)

    def model(_provider, _cfg, _path, body, **_kwargs):
        seen.append(body)
        return next(values)

    monkeypatch.setattr(generation, "request", model)
    return seen, tools, accesses


def knowledge_chat(cfg=CFG, provider="deepseek", question="解释 CMC"):
    return runner.chat(provider, cfg, MESSAGES, CLAIMS, question=question)


def streaming_models(monkeypatch, replies):
    seen = []
    values = iter(replies)

    def request(_provider, _cfg, _path, body, wire, _kind):
        seen.append(body)
        row = next(values)
        if isinstance(row, Exception):
            raise row
        content = row["choices"][0]["message"]["content"]
        if content:
            wire.publish("content", content)
        return row

    monkeypatch.setattr(generation, "_stream_request", request)
    return seen


def test_knowledge_reasoning_only_length_recovers_once_without_reexecuting_tools(monkeypatch):
    seen, tools, accesses = knowledge_models(
        monkeypatch, [reply(limited=True), reply("依据 sources/paper.md 给出三项结论。")]
    )
    updates = []
    with generation.run_context(updates.append):
        result = knowledge_chat()
    assert "三项结论" in result and len(seen) == 2 and len(tools) == 2
    assert seen[0]["max_tokens"] == 8192 and seen[0]["reasoning_effort"] == "low"
    assert seen[1]["max_tokens"] == 16384 and seen[1]["thinking"] == {"type": "disabled"}
    assert "tools" not in seen[1] and "reasoning_effort" not in seen[1]
    assert "CMC original evidence" in json.dumps(seen[1]) and accesses
    assert "PRIVATE_REASONING" not in json.dumps(updates)
    assert not any(row.get("partial_content") for row in updates)


def test_knowledge_explicit_analysis_uses_same_policy_as_general_streaming(monkeypatch):
    seen, _, _ = knowledge_models(monkeypatch, [reply("依据 sources/paper.md 回答")])
    with generation.run_context(lambda _row: None):
        knowledge_chat(question="深入分析 CMC")
    assert seen[0]["max_tokens"] == 16384 and seen[0]["reasoning_effort"] == "high"


def test_knowledge_partial_is_verified_and_continued_by_append(monkeypatch):
    prefix = "<think>SECRET</think>依据 sources/paper.md，已完成第一项。"
    seen, _, _ = knowledge_models(monkeypatch, [reply(prefix, limited=True), reply("第二项行动。")])
    updates = []
    with generation.run_context(updates.append):
        answer = knowledge_chat()
    assert answer == "依据 sources/paper.md，已完成第一项。\n\n第二项行动。"
    saved = [r["partial_content"] for r in updates if r.get("partial_content")]
    assert saved == ["依据 sources/paper.md，已完成第一项。"]
    assert "SECRET" not in json.dumps(seen[1]) and "PRIVATE_REASONING" not in json.dumps(updates)
    assert json.loads(seen[1]["messages"][-1]["content"])["unfinished_answer"] == saved[0]


@pytest.mark.parametrize(
    "text",
    [
        "没有核对来源的正文",
        "来源 sources/not-read.md",
        "来源 sources/paper.md，另见 sources/broken",
        "依据 [sources/paper.md",
    ],
)
def test_unverified_or_broken_partial_is_not_saved_or_forwarded(monkeypatch, text):
    seen, _, _ = knowledge_models(
        monkeypatch, [reply(text, limited=True), reply("依据 sources/paper.md 完整回答")]
    )
    updates = []
    with generation.run_context(updates.append):
        knowledge_chat()
    assert not any(r.get("partial_content") for r in updates)
    assert json.loads(seen[1]["messages"][-1]["content"])["unfinished_answer"] == ""


def test_limited_tool_call_is_never_executed_or_forwarded(monkeypatch):
    bad_call = {
        "id": "broken",
        "function": {"name": "read_page", "arguments": '{"path":"sources/unfinished'},
    }
    seen, tools, _ = knowledge_models(
        monkeypatch,
        [reply("PRELIMINARY", limited=True, calls=[bad_call]), reply("依据 sources/paper.md 回答")],
    )
    updates = []
    with generation.run_context(updates.append):
        knowledge_chat()
    assert (
        len(tools) == 2
        and "broken" not in json.dumps(seen[1])
        and "PRELIMINARY" not in json.dumps(updates)
    )


def test_second_knowledge_length_keeps_only_safe_draft_and_stops(monkeypatch):
    seen, _, _ = knowledge_models(
        monkeypatch,
        [
            reply("来源 sources/paper.md，第一项。", limited=True),
            reply("未经读取 sources/unread.md", limited=True),
        ],
    )
    updates = []
    with generation.run_context(updates.append), pytest.raises(ai.AIError) as error:
        knowledge_chat()
    assert error.value.code == "output_limit" and len(seen) == 2
    assert [r["partial_content"] for r in updates if r.get("partial_content")] == [
        "来源 sources/paper.md，第一项。"
    ]


@pytest.mark.parametrize(
    "code", ["model_auth", "model_rate_limit", "model_timeout", "model_network"]
)
def test_model_errors_are_not_output_recovery_triggers(monkeypatch, code):
    seen = streaming_models(monkeypatch, [ai.AIError("safe", code=code)])
    with generation.run_context(lambda _row: None), pytest.raises(ai.AIError) as error:
        generation.call("deepseek", CFG, MESSAGES)
    assert error.value.code == code and len(seen) == 1


def test_stream_recovers_real_append_without_exposing_reasoning(monkeypatch):
    seen = streaming_models(
        monkeypatch, [reply("<think>SECRET</think>第一段", limited=True), reply("第二段")]
    )
    updates = []
    with generation.run_context(updates.append):
        answer, _ = generation.call("deepseek", CFG, MESSAGES)
    assert answer == "第一段\n\n第二段" and len(seen) == 2
    assert seen[1]["thinking"] == {"type": "disabled"}
    assert json.loads(seen[1]["messages"][-1]["content"])["unfinished_answer"] == "第一段"
    assert any(row.get("partial_content") == answer for row in updates)
    assert any(row.get("stage") == "recovering" for row in updates)
    assert "SECRET" not in json.dumps(updates)


def test_recovery_budget_is_shared_across_tool_and_streaming_calls(monkeypatch):
    knowledge_seen, _, _ = knowledge_models(
        monkeypatch, [reply(limited=True), reply("来源 sources/paper.md")]
    )
    stream_seen = streaming_models(monkeypatch, [reply("未完成", limited=True)])
    with generation.run_context(lambda _row: None):
        knowledge_chat()
        with pytest.raises(ai.AIError) as error:
            generation.call("deepseek", CFG, MESSAGES)
    assert error.value.code == "output_limit" and len(knowledge_seen) == 2 and len(stream_seen) == 1


def test_recovery_checks_remaining_deadline_and_cancellation(monkeypatch):
    seen = streaming_models(monkeypatch, [reply("正文", limited=True)])
    with (
        generation.run_context(lambda _row: None, budget_seconds=10),
        pytest.raises(ai.AIError) as error,
    ):
        generation.call("deepseek", CFG, MESSAGES)
    assert error.value.code == "output_limit" and len(seen) == 1
    cancelled = False

    def callback(fields):
        nonlocal cancelled
        if fields.get("final_partial"):
            cancelled = True
        elif cancelled:
            raise HTTPException(409, "cancelled")

    seen = streaming_models(monkeypatch, [reply("正文", limited=True)])
    with generation.run_context(callback), pytest.raises(HTTPException):
        generation.call("deepseek", CFG, MESSAGES)
    assert len(seen) == 1


def test_revoked_access_prevents_knowledge_retry(monkeypatch):
    seen, _, _ = knowledge_models(monkeypatch, [reply(limited=True)])

    def request(*args, **kwargs):
        seen.append(args[3])

        def revoked(*_):
            raise HTTPException(403, "revoked")

        monkeypatch.setattr(runner.solution_knowledge, "check_access", revoked)
        return reply(limited=True)

    monkeypatch.setattr(generation, "request", request)
    with generation.run_context(lambda _row: None), pytest.raises(HTTPException) as error:
        knowledge_chat()
    assert error.value.status_code == 403 and len(seen) == 1


@pytest.mark.parametrize(
    "provider,cfg",
    [
        ("custom", {**CFG, "base_url": "https://proxy.example/v1"}),
        ("kimi", CFG),
        ("custom", {**CFG, "model": "other-model"}),
    ],
)
def test_policy_and_recovery_do_not_leak_to_other_vendors(provider, cfg):
    body = {"max_tokens": 4096}
    policy.tune(provider, cfg, body, recovering=True)
    assert body == {"max_tokens": 4096}
    with generation.run_context(lambda _row: None):
        assert not generation.claim_output_recovery(provider, cfg)


def test_kimi_completion_budget_is_logged_without_content(monkeypatch):
    events = []
    monkeypatch.setattr(diagnostics.LOGGER, "info", lambda text: events.append(json.loads(text)))
    with diagnostics.request_scope("00000000-0000-0000-0000-000000000001"):
        diagnostics.model_call(
            lambda *_a, **_k: reply("PRIVATE"),
            "custom",
            {},
            "/chat/completions",
            {"max_completion_tokens": 16384},
            timeout=1,
        )
    assert next(row for row in events if row["event"] == "model_started")["output_budget"] == 16384
    assert "PRIVATE" not in json.dumps(events)


@pytest.mark.parametrize(
    "suffix",
    ["另外依据 sources/unread.md 作结论", "另外依据 sources/broken", "继续 [sources/paper.md"],
)
def test_unverified_recovery_suffix_does_not_complete_or_clear_safe_prefix(monkeypatch, suffix):
    seen, _, _ = knowledge_models(
        monkeypatch,
        [
            reply("来源 sources/paper.md，第一项。", limited=True),
            reply(suffix),
        ],
    )
    updates = []
    with generation.run_context(updates.append), pytest.raises(ai.AIError) as error:
        knowledge_chat()
    assert error.value.code == "model_invalid_response" and len(seen) == 2
    assert [r["partial_content"] for r in updates if r.get("partial_content")] == [
        "来源 sources/paper.md，第一项。"
    ]


def test_second_stream_limit_stops_after_one_recovery_and_keeps_combined_draft(monkeypatch):
    seen = streaming_models(
        monkeypatch, [reply("第一段", limited=True), reply("第二段", limited=True)]
    )
    updates = []
    with generation.run_context(updates.append), pytest.raises(ai.AIError) as error:
        generation.call("deepseek", CFG, MESSAGES)
    assert error.value.code == "output_limit" and len(seen) == 2
    assert updates[-1]["partial_content"] == "第一段\n\n第二段"


def test_legacy_report_tool_calls_keep_previous_policy(monkeypatch):
    seen = []
    monkeypatch.setattr(runner.solution_knowledge, "check_access", lambda *_: None)

    def request(_p, _c, _path, body, **_kwargs):
        seen.append(body)
        return reply("模型正文", limited=True)

    with pytest.raises(ai.AIError) as error:
        runner.chat("deepseek", CFG, MESSAGES, CLAIMS, request_fn=request)
    assert error.value.code == "output_limit" and len(seen) == 1
    assert seen[0]["max_tokens"] == 4096 and "reasoning_effort" not in seen[0]


def test_stream_recovery_combined_limit_never_writes_oversized_draft(monkeypatch):
    prefix = "A" * 79999
    seen = streaming_models(monkeypatch, [reply(prefix, limited=True), reply("BB")])
    updates = []

    def save(fields):
        assert len(fields.get("partial_content", "")) <= generation.MAX_CONTENT
        updates.append(fields)

    with generation.run_context(save), pytest.raises(ai.AIError) as error:
        generation.call("deepseek", CFG, MESSAGES)
    assert error.value.code == "response_too_large" and len(seen) == 2
    assert [r["partial_content"] for r in updates if r.get("partial_content")][-1] == prefix


@pytest.mark.parametrize("limited", [False, True])
def test_knowledge_recovery_combined_limit_keeps_verified_prefix(monkeypatch, limited):
    prefix = "依据 sources/paper.md " + "A" * 79970
    seen, _, _ = knowledge_models(
        monkeypatch, [reply(prefix, limited=True), reply("B" * 100, limited=limited)]
    )
    updates = []

    def save(fields):
        assert len(fields.get("partial_content", "")) <= 80000
        updates.append(fields)

    with generation.run_context(save), pytest.raises(ai.AIError) as error:
        knowledge_chat()
    assert error.value.code == "response_too_large" and len(seen) == 2
    assert [r["partial_content"] for r in updates if r.get("partial_content")] == [prefix]
