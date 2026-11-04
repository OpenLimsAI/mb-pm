"""Evidence gating and context isolation; all services/models are mocked."""

import json
from uuid import uuid4

import pytest
from fastapi import HTTPException
from test_assistant_knowledge_tools import CLAIMS, page, reply, upstream

from app.services import ai, assistant_retrieval, assistant_sources, web_search
from app.services import assistant_diagnostics as diagnostics
from app.services import assistant_knowledge as knowledge
from app.services import assistant_tool_chat as runner
from app.services import solution_knowledge as kb


@pytest.fixture(autouse=True)
def isolated(monkeypatch):
    monkeypatch.setenv("SOLUTION_KB_CORE_URL", "http://core.test:8765")
    monkeypatch.setenv("SOLUTION_KB_TOKEN", "test-token")
    monkeypatch.setenv("SOLUTION_KB_PUBLIC_URL", "https://kb.test")
    monkeypatch.setattr(kb.accounts, "live_roles", lambda *_: {"kb_viewer"})

    def forbidden(*_, **__):
        pytest.fail("Unexpected network/model request")

    monkeypatch.setattr(kb, "_request", forbidden)
    monkeypatch.setattr(ai, "request", forbidden)


def wire(chunks=(), refs=()):
    return json.dumps(
        {
            "type": "final",
            "status": "succeeded",
            "result": {
                "chunks": list(chunks),
                "page_refs": list(refs),
            },
        }
    ).encode()


def personal(request_fn, question="解释 CMC", **kwargs):
    return runner.chat(
        "deepseek",
        {"model": "test"},
        [
            {"role": "system", "content": "trusted rules"},
            {"role": "user", "content": json.dumps({"question": question})},
        ],
        CLAIMS,
        question=question,
        request_fn=request_fn,
        **kwargs,
    )


def prechecked(body):
    return json.loads(body["messages"][-1]["content"])["prechecked_knowledge"]


def test_web_synthesis_receives_full_question_and_safe_context_only(monkeypatch):
    search_calls, model_calls = [], []
    ref = {"url": "https://public.example/source", "title": "public", "excerpt": "evidence"}

    def search(query, **kwargs):
        search_calls.append((query, kwargs))
        return [ref]

    def model(_, __, messages, **kwargs):
        model_calls.append(messages)
        return "结论 [1]", {}

    monkeypatch.setattr(web_search, "search", search)
    monkeypatch.setattr(ai, "chat", model)
    content, _ = web_search.answer(
        "第二项再展开，并保持之前的表格格式",
        selected={"kind": "system"},
        provider="deepseek",
        cfg={},
        search_query="公开研究 第二项 2026",
        context_messages=[
            {"role": "system", "content": "UNTRUSTED_SYSTEM"},
            {"role": "tool", "content": "SECRET_TOOL"},
            {"role": "user", "content": "PRIVATE_PREFERENCE:以表格呈现", "tools": ["bad"]},
            {"role": "assistant", "content": "unverified_previous_answer"},
        ],
    )
    assert content == "结论 [1]" and len(search_calls) == len(model_calls) == 1
    assert search_calls[0][0] == "公开研究 第二项 2026"
    assert "PRIVATE" not in json.dumps(search_calls)
    payload = json.loads(model_calls[0][-1]["content"])
    assert payload["question"] == "第二项再展开，并保持之前的表格格式"
    assert "PRIVATE_PREFERENCE" in str(payload["conversation_context"])
    assert "UNTRUSTED_SYSTEM" not in str(payload) and "SECRET_TOOL" not in str(payload)
    assert "tools" not in payload["conversation_context"][0]
    assert "历史回答不是本轮事实证据" in model_calls[0][0]["content"]


def test_web_context_is_bounded_and_never_overrides_roles():
    result = web_search.synthesis_context(
        [{"role": "user", "content": "x" * 10000} for _ in range(100)]
    )
    assert sum(len(row["content"]) for row in result) <= 20000
    assert all(len(row["content"]) <= 6000 for row in result)
    assert all(row["truncated"] for row in result)


def test_web_no_results_is_normal_evidence_insufficiency_without_model(monkeypatch):
    def empty(*_, **__):
        raise HTTPException(422, "no results", headers={"X-Assistant-Error-Code": "web_no_results"})

    monkeypatch.setattr(web_search, "search", empty)
    content, refs = web_search.answer(
        "question", selected={"kind": "system"}, provider="test", cfg={}, search_query="question"
    )
    assert refs == [] and "未找到可用来源" in content


def test_legacy_web_call_keeps_no_results_error_contract(monkeypatch):
    def empty(*_, **__):
        raise HTTPException(422, "no results", headers={"X-Assistant-Error-Code": "web_no_results"})

    monkeypatch.setattr(web_search, "search", empty)
    with pytest.raises(HTTPException) as exc:
        web_search.answer("question", selected={"kind": "system"}, provider="test", cfg={})
    assert exc.value.status_code == 422


def test_web_transport_failure_remains_an_error(monkeypatch):
    def failed(*_, **__):
        raise HTTPException(504, "timeout", headers={"X-Assistant-Error-Code": "web_timeout"})

    monkeypatch.setattr(web_search, "search", failed)
    with pytest.raises(HTTPException) as exc:
        web_search.answer("question", selected={"kind": "system"}, provider="test", cfg={})
    assert exc.value.status_code == 504


def test_personal_reads_evidence_before_first_model_request(monkeypatch):
    calls = upstream(
        monkeypatch,
        [
            wire([page(text="CMC 原始检索片段", offset=25)]),
            page(body="x" * 25 + "CMC 实际原文片段"),
        ],
    )
    observed = []

    def request(*args, **kwargs):
        assert len(calls) == 2
        observed.extend(prechecked(args[3]))
        return reply("依据 sources/paper.md 整理。")

    with assistant_sources.collect() as sources:
        assert "依据" in personal(request)
        refs, summary = sources.finish("依据 sources/paper.md 整理。", 10)
    assert [item["tool"] for item in observed] == ["retrieve_knowledge", "read_page"]
    assert observed[1]["arguments"]["offset"] == 25
    assert refs[0]["kind"] == "read" and refs[0]["citation_status"] == "path_matched"
    assert {x["text"] for x in refs[0]["excerpts"]} == {"CMC 原始检索片段", "CMC 实际原文片段"}
    assert summary["retrieved_count"] == summary["read_count"] == 1


def test_low_relevance_is_not_evidence_or_a_paid_model_call(monkeypatch):
    calls = upstream(
        monkeypatch,
        [
            wire([page(title="普通资料", text="完全无关的烹饪步骤")]),
            wire([page(title="普通资料", text="完全无关的烹饪步骤")]),
        ],
    )
    with assistant_sources.collect() as sources:
        content = personal(lambda *_args, **_kwargs: pytest.fail("must not call model"))
        refs, summary = sources.finish(content, 10)
    assert len(calls) == 2 and "未找到与问题足够相关" in content
    assert refs == [] and summary["retrieved_count"] == 0


def test_alias_supplement_deduplicates_and_ranks_without_semantic_confidence(monkeypatch):
    unrelated = page("sources/cooking.md", title="烹饪", text="早餐食谱")
    related = page(
        "sources/llm.md", title="large language model", text="Large language model architectures"
    )
    calls = upstream(
        monkeypatch,
        [
            wire([unrelated]),
            wire([unrelated, related, related]),
            page("sources/llm.md", title="LLM", body="LLM original body"),
        ],
    )

    def request(*args, **kwargs):
        rows = prechecked(args[3])
        assert rows[0]["result"]["chunks"] == []
        chunks = rows[1]["result"]["chunks"]
        assert len(chunks) == 1 and chunks[0]["path"] == "sources/llm.md"
        assert "large language model" in chunks[0]["matched_terms"]
        assert "confidence" not in json.dumps(rows)
        return reply("来源 sources/llm.md")

    assert "llm.md" in personal(request, question="解释大语言模型")
    assert len(calls) == 3 and "llm" in calls[1][2]["payload"]["q"]


def test_followup_uses_independent_query_without_replacing_current_question(monkeypatch):
    calls = upstream(monkeypatch, [wire([page(text="CMC 证据")]), page(body="CMC 原文")])

    def request(*args, **kwargs):
        assert json.loads(args[3]["messages"][1]["content"])["question"] == "第二项再展开"
        return reply("sources/paper.md")

    personal(request, question="第二项再展开", search_query="CMC 限制 第二项再展开")
    assert calls[0][2]["payload"]["q"] == "CMC 限制 第二项再展开"


def test_prefetch_counts_against_same_call_budget(monkeypatch):
    monkeypatch.setattr(runner, "MAX_CALLS", 1)
    calls = upstream(monkeypatch, [wire([page(text="CMC snippet")])])

    def request(*args, **kwargs):
        assert "tools" not in args[3]
        return reply("sources/paper.md")

    assert "paper.md" in personal(request) and len(calls) == 1


def test_revocation_during_prefetch_blocks_answer_before_model(monkeypatch):
    checks = iter([{"kb_viewer"}, {"kb_viewer"}, set()])
    monkeypatch.setattr(kb.accounts, "live_roles", lambda *_: next(checks))
    calls = upstream(monkeypatch, [wire([page(text="CMC snippet")])])
    with pytest.raises(HTTPException) as exc:
        personal(lambda *_args, **_kwargs: pytest.fail("must not reach model"))
    assert exc.value.status_code == 403 and len(calls) == 1


def test_prefetch_upstream_failure_is_not_a_no_results_message(monkeypatch):
    upstream(monkeypatch, [b'{"type":"final","status":"failed"}'])
    with pytest.raises(HTTPException) as exc:
        personal(lambda *_args, **_kwargs: pytest.fail("must not reach model"))
    assert exc.value.status_code == 502


def test_catalogue_question_reads_real_count_before_model(monkeypatch):
    calls = upstream(monkeypatch, [[page(f"sources/{i}.md") for i in range(35)]])

    def request(*args, **kwargs):
        rows = prechecked(args[3])
        assert rows[0]["tool"] == "list_pages" and rows[0]["result"]["total"] == 35
        assert rows[0]["result"]["truncated"]
        return reply("共35份资料，本页目录不完整。")

    assert "35" in personal(request, question="知识库有多少份资料") and len(calls) == 1


@pytest.mark.parametrize(
    "question",
    [
        "CMC有多少种工艺",
        "知识库中ADC有什么风险",
        "解释大语言模型",
        "知识库有多少ADC论文",
        "列出全部GMP资料",
        "分析目录中药品的风险",
    ],
)
def test_content_questions_are_not_mistaken_for_full_catalogue(question):
    assert not assistant_retrieval.catalogue_question(question)


def test_source_excerpts_keep_actual_offsets_and_path_matching_only():
    row = page()
    with assistant_sources.collect() as sources:
        sources.observe("retrieve_knowledge", {"chunks": [{**row, "text": "snippet"}]})
        sources.observe("read_page", {**row, "body": "actual body", "offset": 440})
        sources.observe("read_page", {**row, "body": "next body", "offset": 900})
        refs, _ = sources.finish("一个未经语义验证的断言 sources/paper.md", 1)
    assert [x["offset"] for x in refs[0]["excerpts"]] == [None, 440, 900]
    assert refs[0]["citation_status"] == "path_matched"
    assert all(x["length"] == len(x["text"]) for x in refs[0]["excerpts"])


def test_core_retrieval_rejects_invalid_offsets_but_keeps_lexical_basis(monkeypatch):
    upstream(
        monkeypatch,
        [wire([page(text="CMC snippet", offset=True), page(text="CMC next", offset=80)])],
    )
    value = knowledge.execute(CLAIMS, "retrieve_knowledge", {"q": "CMC"})
    assert "offset" not in value["chunks"][0] and value["chunks"][1]["offset"] == 80
    assert value["chunks"][0]["evidence_eligible"]
    assert value["ranking_basis"] == "lexical_topic_match_not_fact_verification"


def test_lexical_relevance_requires_the_named_technical_topic():
    assert not assistant_retrieval.relevance(
        "CMC risk assessment", "Other risk", "Risk assessment"
    )["evidence_eligible"]
    assert not assistant_retrieval.relevance("ADC", "decade", "Traditional treatment")[
        "evidence_eligible"
    ]
    assert assistant_retrieval.relevance("质量源于设计", "QbD", "overview")["evidence_eligible"]


@pytest.mark.parametrize(
    "content",
    [
        "一个没有引用的结论",
        "来源 sources/fabricated.md",
        "来源 sources/paper.md 以及 sources/fabricated.md",
        "来源 sources/paper.mdspoof",
    ],
)
def test_personal_answer_requires_only_observed_evidence_paths(monkeypatch, content):
    upstream(monkeypatch, [wire([page(text="CMC 实际片段")]), page(body="CMC 实际原文")])
    result = personal(lambda *_args, **_kwargs: reply(content))
    assert "未能提供与实际原文片段对应" in result
    assert "fabricated" not in result


def test_matching_title_without_relevant_snippet_or_body_is_not_evidence(monkeypatch):
    title_match = page(title="CMC overview", text="烹饪方法与早餐食谱")
    upstream(
        monkeypatch,
        [
            wire([title_match], [title_match]),
            page(title="CMC overview", body="完全无关的正文和食谱"),
        ],
    )
    result = personal(lambda *_args, **_kwargs: pytest.fail("title alone cannot support an answer"))
    assert "未找到与问题足够相关" in result


def test_web_context_truncation_is_disclosed_in_returned_answer(monkeypatch):
    monkeypatch.setattr(
        web_search,
        "search",
        lambda *_args, **_kwargs: [
            {
                "url": "https://public.example/source",
                "title": "public",
                "excerpt": "evidence",
            }
        ],
    )
    monkeypatch.setattr(ai, "chat", lambda *_args, **_kwargs: ("结论 [1]", {}))
    content, _ = web_search.answer(
        "改写基稿",
        selected={"kind": "system"},
        provider="test",
        cfg={},
        context_messages=[{"role": "user", "content": "x" * 8000}],
    )
    assert "上下文说明" in content and "未带入的部分尚未核对" in content


def test_prefetch_is_in_diagnostics_and_has_no_hidden_model_round(monkeypatch):
    upstream(monkeypatch, [wire([page(text="CMC snippet")]), page(body="CMC original body")])
    with diagnostics.request_scope(uuid4()) as trace:
        result = personal(lambda *_args, **_kwargs: reply("sources/paper.md"))
        assert trace.tool_calls == 2 and trace.model_rounds == 1
    assert result == "sources/paper.md"


def test_prefetch_obeys_total_elapsed_budget_before_model(monkeypatch):
    ticks = iter([0, 0, runner.MAX_SECONDS + 1])
    monkeypatch.setattr(runner.time, "monotonic", lambda: next(ticks))
    upstream(monkeypatch, [wire([page(text="CMC snippet")])])
    with pytest.raises(HTTPException) as exc:
        personal(lambda *_args, **_kwargs: pytest.fail("must not call model after budget"))
    assert exc.value.headers["X-Assistant-Error-Code"] == "query_timeout"


def test_saved_excerpts_are_bounded_separately_from_tool_data():
    with assistant_sources.collect() as sources:
        for index in range(30):
            sources.observe(
                "read_page",
                {
                    **page(f"sources/{index}.md"),
                    "offset": 100,
                    "body": "x" * 6000,
                },
            )
        refs, summary = sources.finish("", 30)
    assert sum(len(excerpt["text"]) for ref in refs for excerpt in ref["excerpts"]) <= 24000
    assert all(len(excerpt["text"]) <= 1200 for ref in refs for excerpt in ref["excerpts"])
    assert summary["truncated"]
