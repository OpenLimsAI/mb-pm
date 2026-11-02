"""Automatic routing, public-search bounds, private scope and immutable citations."""

import importlib.util
import json
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4

import httpx
import pytest
import test_assistant
import test_solutions
from fastapi import HTTPException
from sqlalchemy import create_engine, inspect, select, text

from app.core.config import settings
from app.models.solution import SolutionSource
from app.services import ai, answer_modes, solution_knowledge, web_search

solution_client = test_solutions.solution_client
assistant_client = test_assistant.assistant_client


@pytest.mark.parametrize(
    "question,requested,allowed,mode",
    [
        ("解释一下抗体是什么", "auto", True, "general"),
        ("知识库有几篇论文", "auto", True, "knowledge"),
        ("总结柿子脱涩最新学术进展", "auto", True, "web"),
        ("不要联网，介绍最近常用的方法", "auto", True, "general"),
        ("不要搜索，解释最新技术这个词", "auto", False, "general"),
        ("无需联网，解释最新技术这个词", "auto", False, "general"),
        ("不需要联网，解释最新技术这个词", "auto", False, "general"),
        ("不联网，知识库里有哪些论文", "auto", True, "knowledge"),
        ("latest persimmon research", "general", True, "general"),
        ("公司内部最新资料是什么", "auto", True, "knowledge"),
        ("公司内部最新资料是什么", "web", True, "knowledge"),
        ("当前章节有哪些相关知识？", "auto", True, "knowledge"),
        ("现有资料中的结论有哪些差异？", "auto", True, "knowledge"),
        ("公开网络数据保密技术有哪些最新进展", "auto", False, "web"),
    ],
)
def test_shared_router(question, requested, allowed, mode):
    assert answer_modes.decide(question, requested, knowledge_allowed=allowed).mode == mode


@pytest.mark.parametrize(
    "question,requested,sources,mode,used",
    [
        ("目前有哪些项目", "auto", ["projects"], "application", ("projects",)),
        ("我的项目", "auto", ["projects"], "application", ("projects",)),
        ("我负责哪些项目", "auto", ["projects"], "application", ("projects",)),
        ("查询项目管理系统的数据", "web", ["projects"], "application", ("projects",)),
        ("目前有哪些项目", "auto", ["projects", "knowledge"], "application", ("projects",)),
        (
            "列出当前项目并参考知识库",
            "auto",
            ["projects", "knowledge"],
            "application",
            ("projects", "knowledge"),
        ),
        ("知识库有几篇论文", "auto", ["projects", "knowledge"], "knowledge", ("knowledge",)),
        ("知识库里的项目状态专题论文", "auto", ["knowledge"], "knowledge", ("knowledge",)),
        ("知识库中有哪些关于项目状态的论文", "auto", ["knowledge"], "knowledge", ("knowledge",)),
        (
            "结合知识库论文分析项目最新进展",
            "auto",
            ["projects", "knowledge"],
            "application",
            ("projects", "knowledge"),
        ),
        ("目前有哪些项目", "knowledge", ["knowledge"], "knowledge", ("knowledge",)),
        ("目前有哪些项目", "general", [], "general", ()),
        ("什么是项目管理", "auto", ["projects"], "general", ()),
        ("解释抗体", "auto", ["projects", "knowledge"], "general", ()),
    ],
)
def test_personal_router_uses_only_the_applications_needed(
    question, requested, sources, mode, used
):
    plan = answer_modes.decide_personal(question, requested, data_sources=sources)
    assert plan.mode == mode and plan.sources == used


@pytest.mark.parametrize("requested", ["auto", "web"])
def test_project_intent_and_followup_never_bypass_application_selection(requested):
    with pytest.raises(HTTPException) as exc:
        answer_modes.decide_personal(
            "目前有哪些项目的最新进展", requested, data_sources=["knowledge"]
        )
    assert exc.value.status_code == 422 and "勾选项目管理" in exc.value.detail
    with pytest.raises(HTTPException):
        answer_modes.decide_personal(
            "再详细一点",
            requested if requested == "auto" else "auto",
            data_sources=[],
            previous_mode="application",
            previous_sources=["projects"],
        )
    plan = answer_modes.decide_personal(
        "再详细一点",
        "auto",
        data_sources=["projects"],
        previous_mode="application",
        previous_sources=["projects"],
    )
    assert plan.mode == "application" and plan.sources == ("projects",)
    # Report callers do not acquire PM routing from the personal-only helper.
    assert (
        answer_modes.decide("我负责哪些项目", "auto", knowledge_allowed=False).mode != "application"
    )


@pytest.mark.parametrize(
    "question,requested,allowed,previous",
    [
        ("总结本轮资料", "auto", False, ""),
        ("整理本次材料的结论", "auto", False, ""),
        ("总结附带资料中的最新结果", "auto", False, ""),
        ("整理附带的资料", "auto", True, ""),
        ("这份文档说明什么", "auto", False, ""),
        ("概括已上传的资料", "auto", False, ""),
        ("分析我提供的材料", "auto", False, ""),
        ("整理本轮资料的最新数据", "web", False, ""),
        ("不要联网，整理附件", "auto", False, ""),
        ("summarize the attached document", "auto", False, ""),
        ("这些资料里有哪些近期结果", "auto", False, "web"),
        ("这些资料里有哪些近期结果", "auto", False, "knowledge"),
    ],
)
def test_current_reference_material_is_not_an_application_or_public_search(
    question, requested, allowed, previous
):
    plan = answer_modes.decide(
        question,
        requested,
        knowledge_allowed=allowed,
        previous_mode=previous,
        reference_material_available=True,
    )
    assert plan.mode == "general"
    assert "本轮提供的资料" in plan.reason and "不读取知识库" in plan.reason


@pytest.mark.parametrize(
    "question,requested",
    [
        ("总结本轮资料的最新结果", "auto"),
        ("总结提供的资料里的最新结果", "web"),
        ("整理已上传的资料", "auto"),
        ("分析附件中的最新结论", "auto"),
        ("总结知识库中的这份资料", "auto"),
        ("总结内部系统已上传的资料", "web"),
        ("总结公司内部提供的资料", "auto"),
        ("总结未公开的这份文档", "auto"),
        ("解释抗体", "knowledge"),
    ],
)
def test_reference_pointer_still_requires_missing_or_explicit_private_scope(question, requested):
    # No material cannot authorize a missing private source. An attachment cannot
    # authorize explicit knowledge/internal-system access either.
    for available in (False, True):
        explicit = any(term in question for term in ("知识库", "内部", "未公开"))
        if available and not explicit and requested != "knowledge":
            continue
        with pytest.raises(HTTPException) as exc:
            answer_modes.decide(
                question,
                requested,
                knowledge_allowed=False,
                reference_material_available=available,
            )
        assert exc.value.status_code == 422


def test_reference_material_does_not_override_selected_or_explicit_knowledge_scope():
    for requested in ("auto", "web", "knowledge"):
        plan = answer_modes.decide(
            "总结本轮资料中的最新结论",
            requested,
            constrained_sources=True,
            reference_material_available=True,
        )
        assert plan.mode == "knowledge"
    assert (
        answer_modes.decide("总结本轮资料", "knowledge", reference_material_available=True).mode
        == "knowledge"
    )
    assert (
        answer_modes.decide("知识库中已上传的资料", "auto", reference_material_available=True).mode
        == "knowledge"
    )
    assert (
        answer_modes.decide("柿子脱涩的最新研究", "auto", reference_material_available=True).mode
        == "web"
    )


@pytest.mark.parametrize(
    "question,requested",
    [
        ("公司内部最新资料是什么", "auto"),
        ("知识库最新论文", "auto"),
        ("公司内部最新资料是什么", "web"),
        ("不要搜索，知识库有几篇论文", "auto"),
        ("总结我们未公开的新型抗体当前项目进展", "auto"),
        ("我们自己的实验有哪些最新进展", "auto"),
        ("解释抗体", "knowledge"),
    ],
)
def test_disabled_private_scope_never_falls_into_public_search(question, requested):
    with pytest.raises(HTTPException) as exc:
        answer_modes.decide(question, requested, knowledge_allowed=False)
    assert exc.value.status_code == 422 and "启用知识库" in exc.value.detail


def test_explicit_report_scope_and_safe_followups():
    for requested in ("auto", "general", "web"):
        assert (
            answer_modes.decide("最新学术进展", requested, constrained_sources=True).mode
            == "knowledge"
        )
    plan = answer_modes.decide(
        "再详细一点", "auto", previous_mode="web", previous_web_question="公开问题"
    )
    assert plan.mode == "web" and "公开问题" in plan.query
    with pytest.raises(HTTPException):
        answer_modes.decide(
            "再详细一点", "auto", previous_mode="knowledge", knowledge_allowed=False
        )
    assert (
        answer_modes.decide("这些论文最近进展呢", "auto", previous_mode="knowledge").mode
        == "knowledge"
    )
    recent = answer_modes.decide(
        "这些论文最近进展呢", "auto", previous_mode="web", previous_web_question="公开论文主题"
    )
    assert recent.mode == "web" and "公开论文主题" in recent.query


def enable_search(monkeypatch):
    monkeypatch.setattr(settings, "ASSISTANT_WEB_ENABLED", True)
    monkeypatch.setattr(settings, "ASSISTANT_WEB_PROVIDER", "tavily")
    monkeypatch.setattr(settings, "ASSISTANT_WEB_API_KEY", "isolated-search-secret")


def provider(monkeypatch, *, results=None, status=200, body=None, failure=None):
    calls = []

    @contextmanager
    def stream(method, url, **kwargs):
        calls.append({"method": method, "url": url, **kwargs})
        if failure:
            raise failure
        response = (
            httpx.Response(status, content=body)
            if body is not None
            else httpx.Response(status, json={"results": results or []})
        )
        yield response

    monkeypatch.setattr(web_search.httpx, "stream", stream)
    return calls


def public_result(**changes):
    return {
        "title": "公开研究资料",
        "url": "https://example.org/research",
        "content": "公开摘要。",
        "raw_content": "服务提取的公开正文：研究条件与局限。",
        **changes,
    }


def test_adapter_uses_fixed_provider_bounded_text_and_real_metadata(monkeypatch):
    enable_search(monkeypatch)
    calls = provider(
        monkeypatch,
        results=[
            public_result(published_date="2026-10-31", raw_content="a" * 20000),
            public_result(url="https://127.0.0.1/private"),
            public_result(url="https://example.org/research"),
            public_result(url="https://example.com/second", published_date="yesterday"),
        ],
    )
    refs = web_search.search("公开问题")
    assert len(refs) == 2 and len(refs[0]["excerpt"]) == 8000
    assert refs[0]["published_at"] == "2026-10-31" and refs[1]["published_at"] is None
    assert refs[0]["retrieved_at"].endswith("+00:00")
    call = calls[0]
    assert call["method"] == "POST" and call["url"] == web_search.TAVILY_ENDPOINT
    assert call["json"]["query"] == "公开问题"
    assert (
        call["json"]["include_raw_content"] == "markdown"
        and call["json"]["include_answer"] is False
    )
    assert call["follow_redirects"] is False and call["trust_env"] is False


@pytest.mark.parametrize(
    "url",
    [
        "http://example.com/a",
        "https://user:pass@example.com/",
        "https://localhost/a",
        "https://service.local/a",
        "https://service.internal/a",
        "https://10.0.0.1/a",
        "https://169.254.169.254/a",
        "https://[::1]/a",
        "https://2130706433/a",
        "https://0x7f.0.0.1/a",
        "https://0177.0.0.1/a",
        "https://127.1/a",
        "javascript:alert(1)",
        "https://example.org:8443/a",
        "https://example.org/\nsecret",
    ],
)
def test_unsafe_citation_urls_rejected(url):
    assert not web_search.safe_url(url)


@pytest.mark.parametrize(
    "status,body,code",
    [
        (401, None, "web_auth"),
        (403, None, "web_auth"),
        (429, None, "web_rate_limit"),
        (302, None, "web_unavailable"),
        (500, None, "web_unavailable"),
        (200, b"not json", "web_invalid_response"),
        (200, b"x" * 1000001, "web_invalid_response"),
        (200, None, "web_no_results"),
    ],
    # Keep verbose CI test names bounded: the oversized body must never become a node ID.
    ids=[
        "unauthorized",
        "forbidden",
        "rate-limited",
        "redirect",
        "upstream-error",
        "invalid-json",
        "oversized-response",
        "no-results",
    ],
)
def test_search_dependency_errors_are_distinct_and_sanitized(monkeypatch, status, body, code):
    enable_search(monkeypatch)
    provider(monkeypatch, status=status, body=body)
    with pytest.raises(HTTPException) as exc:
        web_search.search("private-marker")
    assert exc.value.headers["X-Assistant-Error-Code"] == code
    assert (
        "private-marker" not in exc.value.detail
        and "isolated-search-secret" not in exc.value.detail
    )


def test_unconfigured_and_timeout_never_call_model(monkeypatch):
    monkeypatch.setattr(settings, "ASSISTANT_WEB_ENABLED", False)
    calls = provider(monkeypatch)
    with pytest.raises(HTTPException) as exc:
        web_search.search("latest research")
    assert exc.value.headers["X-Assistant-Error-Code"] == "web_not_configured" and calls == []
    enable_search(monkeypatch)
    provider(monkeypatch, failure=httpx.ReadTimeout("secret provider body"))
    with pytest.raises(HTTPException) as exc:
        web_search.search("latest research")
    assert exc.value.headers["X-Assistant-Error-Code"] == "web_timeout"
    assert "secret" not in exc.value.detail


def test_search_stream_has_an_overall_elapsed_budget(monkeypatch):
    enable_search(monkeypatch)
    provider(monkeypatch, results=[public_result()])
    ticks = iter([0, 21])
    monkeypatch.setattr(web_search, "monotonic", lambda: next(ticks))
    with pytest.raises(HTTPException) as exc:
        web_search.search("public question")
    assert exc.value.headers["X-Assistant-Error-Code"] == "web_timeout"


@pytest.mark.parametrize(
    "content",
    [
        "结论[1]。另见[虚构](https://0x7f.0.0.1/private)",
        "结论[1]。https://unverified.example.org/source",
        "结论[1]。<javascript:alert(1)>",
        '结论[1]。<a href="http://localhost/private">来源</a>',
        "结论[1]。[空白来源]( )",
    ],
)
def test_grounded_answer_rejects_unverified_or_unsafe_body_links(monkeypatch, content):
    enable_search(monkeypatch)
    provider(monkeypatch, results=[public_result()])
    monkeypatch.setattr(ai, "chat", lambda *_, **__: (content, {}))
    with pytest.raises(ai.AIError) as exc:
        web_search.answer(
            "public question",
            selected={"kind": "system"},
            provider="ollama",
            cfg={"model": "isolated"},
        )
    assert exc.value.code == "model_invalid_response"


def grounded_model(monkeypatch, fixture, *, require_released=True):
    calls = []
    monkeypatch.setattr(
        ai,
        "load_settings",
        lambda: {"provider": "ollama", "providers": {"ollama": {"model": "isolated-web-model"}}},
    )

    def chat(_provider, _cfg, messages, **_kwargs):
        if require_released:
            assert not fixture.db.in_transaction()
        calls.append(messages)
        return "资料所述结果仍须核对研究条件 [1]。", {}

    monkeypatch.setattr(ai, "chat", chat)
    return calls


def test_personal_auto_general_does_not_read_allowed_knowledge(assistant_client, monkeypatch):
    f = assistant_client
    monkeypatch.setattr(
        solution_knowledge, "paper_count", lambda *_: pytest.fail("unneeded private query")
    )
    task = test_assistant.create(f)
    response = test_assistant.question(
        f, task, answer_mode="auto", data_sources=["knowledge"], question="解释抗体是什么"
    )
    assert response.status_code == 200, response.text
    assert response.json()["messages"][-1]["answer_mode"] == "general"
    saved = response.json()
    followup = test_assistant.question(
        f, saved, answer_mode="auto", data_sources=["knowledge"], question="再详细一点"
    )
    assert followup.status_code == 200, followup.text
    assert any(
        message["role"] == "assistant" and "工作结果" in message["content"]
        for message in f.calls[-1]["messages"]
    )


@pytest.mark.parametrize("requested", ["auto", "web"])
@pytest.mark.parametrize(
    "sources", [[], ["knowledge"]], ids=["no-application", "knowledge-allowed"]
)
def test_personal_provided_material_reaches_model_without_knowledge_or_search(
    assistant_client, monkeypatch, requested, sources
):
    f = assistant_client
    monkeypatch.setattr(
        solution_knowledge, "paper_count", lambda *_: pytest.fail("unneeded private query")
    )
    monkeypatch.setattr(web_search, "search", lambda *_: pytest.fail("private attachment search"))
    task = test_assistant.create(f)
    response = test_assistant.question(
        f,
        task,
        answer_mode=requested,
        data_sources=sources,
        question="总结本轮附带资料中的最新结果",
        context="private-user-provided-reference-marker",
    )
    assert response.status_code == 200, response.text
    answer = response.json()["messages"][-1]
    assert answer["answer_mode"] == "general" and answer["web_references"] == []
    assert "本轮提供的资料" in answer["mode_reason"]
    assert any(
        message["role"] == "user"
        and json.loads(message["content"]).get("reference_material")
        == "private-user-provided-reference-marker"
        for message in f.calls[-1]["messages"]
    )


@pytest.mark.parametrize(
    "question,context,requested",
    [
        ("总结本轮资料中的最新结果", "", "auto"),
        ("整理已上传的资料", "  ", "web"),
        ("总结知识库中的这份资料", "user-provided", "auto"),
        ("总结内部系统的附带资料", "user-provided", "web"),
        ("总结这份资料", "user-provided", "knowledge"),
    ],
)
def test_personal_material_does_not_authorize_missing_application_scope(
    assistant_client, monkeypatch, question, context, requested
):
    f = assistant_client
    monkeypatch.setattr(
        web_search, "search", lambda *_: pytest.fail("missing private source search")
    )
    task = test_assistant.create(f)
    response = test_assistant.question(
        f, task, answer_mode=requested, data_sources=[], question=question, context=context
    )
    assert response.status_code == 422 and "启用知识库" in response.json()["detail"]
    assert f.calls == []
    assert f.client.get(f"{test_assistant.PREFIX}/{task['id']}").json()["messages"] == []


def test_personal_web_never_sends_context_preferences_or_knowledge_to_search(
    assistant_client, monkeypatch
):
    f = assistant_client
    enable_search(monkeypatch)
    calls = provider(monkeypatch, results=[public_result()])
    model_calls = grounded_model(monkeypatch, f)
    task = test_assistant.create(f, instructions="secret-task-instructions")
    request_id = str(uuid4())
    response = test_assistant.question(
        f,
        task,
        answer_mode="auto",
        data_sources=["knowledge"],
        question="柿子脱涩最新进展",
        context="secret-report-attachment",
        request_id=request_id,
    )
    assert response.status_code == 200, response.text
    saved = response.json()
    assert saved["messages"][-1]["answer_mode"] == "web" and saved["messages"][-1]["web_references"]
    assert calls[0]["json"]["query"] == "柿子脱涩最新进展"
    assert "secret-" not in json.dumps(calls[0]["json"]) + json.dumps(model_calls)
    replay = test_assistant.question(
        f,
        task,
        answer_mode="auto",
        data_sources=["knowledge"],
        question="柿子脱涩最新进展",
        context="secret-report-attachment",
        request_id=request_id,
    )
    assert replay.status_code == 200 and replay.json() == saved and len(calls) == 1
    changed = test_assistant.question(
        f,
        task,
        answer_mode="web",
        data_sources=["knowledge"],
        question="柿子脱涩最新进展",
        context="secret-report-attachment",
        request_id=request_id,
    )
    assert changed.status_code == 409 and len(calls) == 1


def test_personal_unconfigured_web_preserves_task_and_has_diagnostic(assistant_client, monkeypatch):
    f = assistant_client
    monkeypatch.setattr(settings, "ASSISTANT_WEB_ENABLED", False)
    task = test_assistant.create(f)
    response = test_assistant.question(f, task, answer_mode="auto", question="最新研究进展")
    assert (
        response.status_code == 503
        and response.headers["X-Assistant-Error-Code"] == "web_not_configured"
    )
    assert response.headers["X-Assistant-Diagnostic-ID"]
    assert f.client.get(f"{test_assistant.PREFIX}/{task['id']}").json()["revision"] == 1
    assert not f.calls
    cap = f.client.get(test_assistant.PREFIX + "/capabilities").json()
    assert not cap["web_search"]["configured"] and "API_KEY" not in json.dumps(cap)


def test_report_web_snapshots_can_be_adopted_and_are_owner_scoped(solution_client, monkeypatch):
    f = solution_client
    enable_search(monkeypatch)
    calls = provider(monkeypatch, results=[public_result()])
    grounded_model(monkeypatch, f)
    report = test_solutions.create(f)
    response = test_solutions.question(
        f, report, answer_mode="auto", question="柿子脱涩最新进展", context="private report text"
    )
    assert response.status_code == 200, response.text
    answer = response.json()
    assert answer["answer_mode"] == "web" and len(answer["references"]) == 1
    assert "private report text" not in json.dumps(calls[0]["json"])
    ref = answer["references"][0]
    source = f.db.get(SolutionSource, ref["source_id"])
    assert source.kind == "web" and source.content == ref["excerpt"]
    adopted = f.client.put(
        f"{test_solutions.PREFIX}/{report['id']}",
        json=test_solutions.body(revision=1, references=answer["references"]),
    )
    assert adopted.status_code == 200, adopted.text
    assert adopted.json()["references"] == answer["references"]
    again = test_solutions.question(
        f, adopted.json(), answer_mode="web", question="柿子脱涩最新进展"
    )
    assert again.status_code == 200, again.text
    assert again.json()["references"][0]["source_id"] == ref["source_id"]
    assert len(list(f.db.scalars(select(SolutionSource).where(SolutionSource.kind == "web")))) == 1
    f.login("other")
    assert f.client.get(f"{test_solutions.PREFIX}/sources/{ref['source_id']}").status_code == 404
    assert (
        f.client.post(
            test_solutions.PREFIX, json=test_solutions.body(references=answer["references"])
        ).status_code
        == 403
    )
    mutation = f.client.post(
        test_solutions.PREFIX + "/sources", json={"title": "fake", "kind": "web", "content": "fake"}
    )
    assert mutation.status_code == 422


def test_report_scope_never_runs_public_search_and_general_history_stays_in_topic(
    solution_client, monkeypatch
):
    f = solution_client
    calls = grounded_model(monkeypatch, f, require_released=False)
    monkeypatch.setattr(
        web_search, "search", lambda *_: pytest.fail("private scope left application")
    )
    report = test_solutions.create(f)
    source = test_solutions.add_source(f)
    scoped = test_solutions.question(
        f, report, answer_mode="web", source_ids=[source["id"]], question="最新缓冲液稳定性"
    )
    assert scoped.status_code == 200 and scoped.json()["answer_mode"] == "knowledge"
    first = test_solutions.question(
        f, report, answer_mode="general", conversation_id="general-topic", question="解释抗体概念"
    )
    assert first.status_code == 200, first.text
    other = test_solutions.question(
        f,
        report,
        answer_mode="general",
        conversation_id="other-topic",
        question="unrelated topic secret",
    )
    assert other.status_code == 200
    followup = test_solutions.question(
        f, report, answer_mode="auto", conversation_id="general-topic", question="再详细一点"
    )
    assert followup.status_code == 200 and followup.json()["answer_mode"] == "general"
    last = json.dumps(calls[-1], ensure_ascii=False)
    assert "解释抗体概念" in last and "unrelated topic secret" not in last and "缓冲液" not in last


def test_invalid_web_citations_do_not_persist(assistant_client, monkeypatch):
    f = assistant_client
    enable_search(monkeypatch)
    provider(monkeypatch, results=[public_result()])
    monkeypatch.setattr(ai, "chat", lambda *_, **__: ("unsupported citation [99]", {}))
    task = test_assistant.create(f)
    response = test_assistant.question(f, task, answer_mode="web")
    assert (
        response.status_code == 503
        and response.headers["X-Assistant-Error-Code"] == "model_invalid_response"
    )
    assert f.client.get(f"{test_assistant.PREFIX}/{task['id']}").json()["messages"] == []


def test_answer_mode_migration_is_additive_repeatable_and_reversible():
    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    path = (
        Path(__file__).parents[1] / "alembic/versions/2026_11_01_0100-014_assistant_answer_modes.py"
    )
    spec = importlib.util.spec_from_file_location("answer_mode_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        for table in ("assistant_messages", "solution_answers"):
            connection.execute(
                text(f"CREATE TABLE {table} (id VARCHAR(64) PRIMARY KEY, content TEXT NOT NULL)")
            )
            connection.execute(text(f"INSERT INTO {table} VALUES ('legacy', 'retained')"))
        with Operations.context(MigrationContext.configure(connection)):
            module.upgrade()
            module.upgrade()
            for table in ("assistant_messages", "solution_answers"):
                row = connection.execute(text(f"SELECT * FROM {table}")).mappings().one()
                assert (
                    row["content"] == "retained"
                    and row["answer_mode"] == ""
                    and row["web_references"] == "[]"
                )
            module.downgrade()
            for table in ("assistant_messages", "solution_answers"):
                assert {column["name"] for column in inspect(connection).get_columns(table)} == {
                    "id",
                    "content",
                }
                assert (
                    connection.execute(text(f"SELECT content FROM {table}")).scalar() == "retained"
                )
    engine.dispose()


def test_startup_fallback_upgrades_existing_messages_and_answers(tmp_path, monkeypatch):
    import app.main as main

    engine = create_engine(f"sqlite:///{tmp_path / 'legacy-answer-modes.db'}")
    with engine.begin() as connection:
        for table in ("assistant_messages", "solution_answers"):
            connection.execute(
                text(
                    f"CREATE TABLE {table} (id VARCHAR(64), solution_id VARCHAR(64), content TEXT)"
                )
            )
            connection.execute(text(f"INSERT INTO {table} VALUES ('legacy', 'report', 'retained')"))
    monkeypatch.setattr(main, "engine", engine)
    main._ensure_schema()
    main._ensure_schema()
    with engine.connect() as connection:
        for table in ("assistant_messages", "solution_answers"):
            row = connection.execute(text(f"SELECT * FROM {table}")).mappings().one()
            assert (
                row["content"] == "retained"
                and row["answer_mode"] == ""
                and row["web_references"] == "[]"
            )
    engine.dispose()


def test_application_scope_migration_retains_legacy_rows_and_is_repeatable():
    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    path = (
        Path(__file__).parents[1]
        / "alembic/versions/2026_11_01_0200-015_assistant_application_scope.py"
    )
    spec = importlib.util.spec_from_file_location("application_scope_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE assistant_messages (id VARCHAR(64), content TEXT)"))
        connection.execute(text("INSERT INTO assistant_messages VALUES ('legacy', 'retained')"))
        with Operations.context(MigrationContext.configure(connection)):
            module.upgrade()
            module.upgrade()
            row = connection.execute(text("SELECT * FROM assistant_messages")).mappings().one()
            assert row["content"] == "retained" and row["application_scope"] == "{}"
            module.downgrade()
            assert {
                column["name"] for column in inspect(connection).get_columns("assistant_messages")
            } == {"id", "content"}
            assert (
                connection.execute(text("SELECT content FROM assistant_messages")).scalar()
                == "retained"
            )
    engine.dispose()
