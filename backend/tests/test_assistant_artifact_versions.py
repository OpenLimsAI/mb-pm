"""Selected drafts are explicit, immutable, replay-safe and permission-bound."""

import json
from uuid import uuid4

import pytest
import test_assistant
from fastapi import HTTPException

from app.models.assistant import AssistantMessage
from app.schemas.assistant import TaskQuestion
from app.services import assistant, assistant_requests, solution_knowledge

assistant_client = test_assistant.assistant_client
solution_client = test_assistant.solution_client
PREFIX = test_assistant.PREFIX


def test_selected_old_artifact_creates_new_version_and_keeps_explicit_final(assistant_client):
    f = assistant_client
    first = test_assistant.question(f, test_assistant.create(f), answer_mode="general").json()
    base = first["artifacts"][0]
    selected = f.client.put(
        f"{PREFIX}/{first['id']}",
        json={"revision": first["revision"], "final_artifact_id": base["id"]},
    ).json()
    later = test_assistant.question(
        f, selected, question="另一份成果", answer_mode="general"
    ).json()
    request_id = str(uuid4())
    result = test_assistant.question(
        f,
        later,
        question="基于选定稿改成表格",
        base_artifact_id=base["id"],
        answer_mode="general",
        request_id=request_id,
    )
    assert result.status_code == 200, result.text
    saved = result.json()
    assert saved["final_artifact_id"] == base["id"]
    assert saved["artifacts"][0] == base
    assert saved["artifacts"][-1]["base_artifact_id"] == base["id"]
    assert saved["messages"][-1]["base_artifact_id"] == base["id"]
    prompt = json.loads(f.calls[-1]["messages"][-1]["content"])
    assert prompt["base_artifact"]["content"] == base["content"]
    assert "不是已核验" in prompt["base_artifact"]["rule"]
    calls = len(f.calls)
    replay = test_assistant.question(
        f,
        later,
        question="基于选定稿改成表格",
        base_artifact_id=base["id"],
        answer_mode="general",
        request_id=request_id,
    )
    assert replay.status_code == 200 and len(f.calls) == calls
    conflict = test_assistant.question(
        f,
        saved,
        question="基于选定稿改成表格",
        base_artifact_id=later["artifacts"][-1]["id"],
        answer_mode="general",
        request_id=request_id,
    )
    assert conflict.status_code == 409 and len(f.calls) == calls


@pytest.mark.parametrize("foreign", [False, True], ids=["other-task", "other-owner"])
def test_foreign_artifact_rejected_before_model_or_queue(assistant_client, foreign):
    f = assistant_client
    original = test_assistant.question(f, test_assistant.create(f)).json()
    if foreign:
        f.login("other")
    destination = test_assistant.create(f)
    calls = len(f.calls)
    response = test_assistant.question(
        f, destination, base_artifact_id=original["artifacts"][0]["id"], answer_mode="general"
    )
    assert response.status_code == 404 and len(f.calls) == calls
    assert f.client.get(f"{PREFIX}/{destination['id']}").json()["message_count"] == 0


def protected(f, task):
    row = AssistantMessage(
        id=str(uuid4()),
        task_id=task["id"],
        request_id=str(uuid4()),
        position=0,
        role="assistant",
        content="受保护基稿",
        context="",
        model="test",
        data_sources='["knowledge"]',
        answer_mode="knowledge",
        application_scope={"version": 1, "used_sources": ["knowledge"]},
    )
    f.db.add(row)
    f.db.commit()
    return row.id


@pytest.mark.parametrize(
    "mode,sources", [("general", ["knowledge"]), ("web", ["knowledge"]), ("auto", [])]
)
def test_base_draft_cannot_bypass_current_source_selection(
    assistant_client, monkeypatch, mode, sources
):
    f = assistant_client
    task = test_assistant.create(f)
    ident = protected(f, task)
    monkeypatch.setattr(solution_knowledge, "check_access", lambda claims: None)
    response = test_assistant.question(
        f, task, base_artifact_id=ident, data_sources=sources, answer_mode=mode
    )
    assert response.status_code == 422 and f.calls == []


def test_base_source_revocation_prevents_access(assistant_client, monkeypatch):
    f = assistant_client
    task = test_assistant.create(f)
    ident = protected(f, task)

    def denied(claims):
        raise HTTPException(403, "权限已撤回")

    monkeypatch.setattr(solution_knowledge, "check_access", denied)
    response = test_assistant.question(
        f, task, base_artifact_id=ident, data_sources=["knowledge"], answer_mode="auto"
    )
    assert response.status_code == 403 and f.calls == []


@pytest.mark.parametrize("endpoint", ["messages", "requests"])
def test_project_base_cannot_expand_explicit_knowledge_only_mode(
    assistant_client, monkeypatch, endpoint
):
    from app.services import assistant_projects

    f = assistant_client
    task = test_assistant.create(f)
    ident = protected(f, task)
    row = f.db.get(AssistantMessage, ident)
    row.data_sources = '["projects"]'
    row.answer_mode = "application"
    row.application_scope = {"version": 1, "used_sources": ["projects"], "project_ids": ["p1"]}
    f.db.commit()
    monkeypatch.setattr(assistant_projects, "check_saved", lambda *args: {})
    response = f.client.post(
        f"{PREFIX}/{task['id']}/{endpoint}",
        json={
            "revision": task["revision"],
            "request_id": str(uuid4()),
            "question": "请修改这稿",
            "base_artifact_id": ident,
            "data_sources": ["projects", "knowledge"],
            "answer_mode": "knowledge",
        },
    )
    assert response.status_code == 422 and f.calls == []


def test_base_preflight_checks_real_scope_without_generating(assistant_client, monkeypatch):
    f = assistant_client
    task = test_assistant.create(f)
    ident = protected(f, task)
    monkeypatch.setattr(solution_knowledge, "check_access", lambda claims: None)
    missing = f.client.post(
        PREFIX + "/preflight",
        json={
            "task_id": task["id"],
            "base_artifact_id": ident,
            "question": "请修改",
            "answer_mode": "auto",
            "data_sources": [],
        },
    )
    assert missing.status_code == 200 and not missing.json()["ready"]
    ready = f.client.post(
        PREFIX + "/preflight",
        json={
            "task_id": task["id"],
            "base_artifact_id": ident,
            "question": "请修改",
            "answer_mode": "auto",
            "data_sources": ["knowledge"],
        },
    )
    assert ready.status_code == 200 and ready.json()["ready"]
    assert any(c["key"] == "knowledge" for c in ready.json()["checks"])
    assert f.calls == []


def test_auto_base_reuses_source_and_persists_lineage(assistant_client, monkeypatch):
    f = assistant_client
    task = test_assistant.create(f)
    ident = protected(f, task)
    monkeypatch.setattr(solution_knowledge, "check_access", lambda claims: None)
    monkeypatch.setattr(solution_knowledge, "paper_count", lambda claims: 3)
    captured = []
    monkeypatch.setattr(
        assistant.assistant_tool_chat,
        "chat",
        lambda *a, **kw: captured.append((a, kw)) or "新版待核对内容",
    )
    response = test_assistant.question(
        f,
        task,
        question="请修改这一稿",
        base_artifact_id=ident,
        data_sources=["knowledge"],
        answer_mode="auto",
    )
    assert response.status_code == 200, response.text
    answer = response.json()["messages"][-1]
    assert answer["used_sources"] == ["knowledge"] and answer["base_artifact_id"] == ident
    assert captured[0][1]["question"] == "请修改这一稿"


def test_optional_base_field_keeps_legacy_request_fingerprint():
    payload = TaskQuestion(revision=1, request_id=uuid4(), question="问题")
    import hashlib

    old = payload.model_dump(
        mode="json", exclude={"revision", "base_artifact_id", "continue_from_request"}
    )
    assert (
        assistant_requests.fingerprint(payload)
        == hashlib.sha256(json.dumps(old, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    )


@pytest.mark.parametrize(
    "question,body",
    [
        ("细胞培养中抗体片段如何降低", "Cell culture conditions affect antibody fragmentation."),
        ("蛋白酶导致的片段", "Proteolysis can produce fragments."),
        ("柿子脱涩有什么方法", "Persimmon deastringency methods."),
    ],
)
def test_domain_queries_keep_relevant_english_evidence(question, body):
    from app.services.assistant_retrieval import relevance, query_variants

    assert relevance(question, "", body)["evidence_eligible"]
    assert len(query_variants(question)) <= 2


def test_web_followup_includes_task_memory_and_previous_answer_without_search_leak(
    assistant_client, monkeypatch
):
    f = assistant_client
    task = test_assistant.create(f, instructions="用表格回答", memory="已确认目标：比较两种策略")
    observed = []

    def web(question, **kwargs):
        observed.append((question, kwargs))
        return "第一项甲，第二项乙。[1]", [{"title": "source", "url": "https://example.org/paper"}]

    monkeypatch.setattr(assistant.web_search, "answer", web)
    first = test_assistant.question(
        f, task, question="最新细胞培养策略", context="", answer_mode="web"
    ).json()
    response = test_assistant.question(
        f, first, question="第二项再展开", context="内部写作限制", answer_mode="web"
    )
    assert response.status_code == 200, response.text
    question, options = observed[-1]
    assert question == "第二项再展开"
    assert "最新细胞培养策略" in options["search_query"]
    assert "内部写作限制" not in options["search_query"]
    context = json.dumps(options["context_messages"], ensure_ascii=False)
    assert all(
        s in context for s in ["用表格回答", "比较两种策略", "第一项甲，第二项乙", "内部写作限制"]
    )
    assert "unverified_previous_answer" in context
