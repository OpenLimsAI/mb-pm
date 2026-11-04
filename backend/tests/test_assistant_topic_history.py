"""Cross-mode and repeated follow-ups retain topics, never stale private evidence."""

import json
from types import SimpleNamespace

import pytest
import test_assistant

from app.services import answer_modes, assistant_history, assistant_tool_chat, solution_knowledge

assistant_client = test_assistant.assistant_client
solution_client = test_assistant.solution_client


@pytest.mark.parametrize(
    "question",
    [
        "本地知识库中，有哪些文献对这个问题有比较详细的论述？如何在实际工作中解决这个问题？",
        "在实际工作中如何解决上述问题？",
        "请查找关于该问题的文献",
        "前面这个问题是什么？",
    ],
)
def test_sentence_internal_reference_is_a_followup(question):
    assert answer_modes.followup(question)


def test_explicit_topic_reset_wins_over_reference_words():
    assert not answer_modes.followup("换个话题，这个问题是蛋白表达效率如何提高？")


def test_repeated_knowledge_followup_preserves_general_topic_without_old_evidence(
    assistant_client, monkeypatch
):
    f = assistant_client
    monkeypatch.setattr(solution_knowledge, "check_access", lambda claims: None)
    monkeypatch.setattr(solution_knowledge, "paper_count", lambda claims: 331)
    captured = []

    def chat(provider, cfg, messages, claims, **kwargs):
        captured.append((json.dumps(messages, ensure_ascii=False), kwargs))
        return "旧版检索答案不应再次作为证据"

    monkeypatch.setattr(assistant_tool_chat, "chat", chat)
    subject = "上游培养中如何降低抗体片段的百分比？"
    response = test_assistant.question(
        f,
        test_assistant.create(f),
        question=subject,
        context="旧附件秘密",
        answer_mode="general",
    )
    assert response.status_code == 200, response.text
    task = response.json()
    vague = "本地知识库中，有哪些文献对这个问题有比较详细的论述？"
    for _ in range(5):
        response = test_assistant.question(
            f,
            task,
            question=vague,
            context="",
            answer_mode="knowledge",
            data_sources=["knowledge"],
        )
        assert response.status_code == 200, response.text
        task = response.json()
        prompt, options = captured[-1]
        assert subject in prompt and subject in options["search_query"]
        assert "旧附件秘密" not in prompt
        assert "旧版检索答案不应再次作为证据" not in prompt
        assert prompt.count(vague) == 1
        assert options["question"] == vague


def row(content, mode="general", used=None, *, legacy=False):
    return SimpleNamespace(
        role="user",
        content=content,
        answer_mode=mode,
        application_scope={} if legacy else {"version": 1, "used_sources": used or []},
        data_sources=json.dumps(used or []),
    )


def test_context_stops_at_scope_boundary_instead_of_using_unrelated_older_topic():
    history = [row("旧的公开问题", "web"), row("保密问题", "knowledge", ["knowledge"])]
    assert assistant_history.topic_questions(history, "请继续", set()) == []
    assert assistant_history.topic_questions(history, "请继续", set(), public_only=True) == []


def test_legacy_permitted_sources_are_not_treated_as_verified_empty_scope():
    protected = row("历史敏感问题", "general", ["knowledge"], legacy=True)
    assert assistant_history.sources(protected) == {"knowledge"}
    assert assistant_history.topic_questions([protected], "上述问题还有哪些方法", set()) == []


def test_topic_chain_retains_anchor_with_bounded_followup_count():
    history = [row("细胞培养的抗体片段如何降低？")]
    history += [row(f"请继续解释第 {i} 项") for i in range(20)]
    topic = assistant_history.topic_questions(history, "请继续", set())
    assert len(topic) == 4
    assert topic[0] is history[0]
    assert topic[-1] is history[-1]
    assert len(assistant_history.query(topic, "继续" * 300)) <= 1884


def test_new_topic_breaks_the_chain():
    history = [row("旧话题"), row("换个话题，介绍细胞培养"), row("继续展开")]
    topic = assistant_history.topic_questions(history, "还有呢", set())
    assert history[0] not in topic and history[1] in topic


def test_knowledge_scope_switch_never_reuses_other_task_topic(assistant_client, monkeypatch):
    f = assistant_client
    first = test_assistant.question(
        f, test_assistant.create(f), question="其他任务的私密主题", answer_mode="general"
    )
    assert first.status_code == 200
    monkeypatch.setattr(solution_knowledge, "check_access", lambda claims: None)
    monkeypatch.setattr(solution_knowledge, "paper_count", lambda claims: 10)
    captured = []
    monkeypatch.setattr(
        assistant_tool_chat,
        "chat",
        lambda _provider, _cfg, messages, _claims, **kwargs: captured.append(
            json.dumps(messages, ensure_ascii=False)
        )
        or "请说明具体问题",
    )
    response = test_assistant.question(
        f,
        test_assistant.create(f),
        question="本地知识库中有没有这个问题的文献？",
        context="",
        answer_mode="knowledge",
        data_sources=["knowledge"],
    )
    assert response.status_code == 200, response.text
    assert "其他任务的私密主题" not in captured[-1]


def test_repeated_web_followup_keeps_public_subject_without_searching_context(
    assistant_client, monkeypatch
):
    from app.services import assistant

    f = assistant_client
    observed = []

    def web(question, **kwargs):
        observed.append(kwargs)
        return "公开答案 [1]", [{"title": "资料", "url": "https://example.org/article"}]

    monkeypatch.setattr(assistant.web_search, "answer", web)
    task = test_assistant.create(f, memory="内部任务摘要")
    response = test_assistant.question(
        f, task, question="细胞培养的最新研究", context="私密附件", answer_mode="web"
    )
    assert response.status_code == 200, response.text
    task = response.json()
    for _ in range(5):
        response = test_assistant.question(
            f, task, question="第二项再展开", context="", answer_mode="web"
        )
        assert response.status_code == 200, response.text
        task = response.json()
        query = observed[-1]["search_query"]
        assert "细胞培养的最新研究" in query
        assert query.count("第二项再展开") == 1
        assert "私密附件" not in query and "内部任务摘要" not in query


def test_legacy_private_user_text_cannot_enter_general_model_prompt(assistant_client, monkeypatch):
    from sqlalchemy import select

    from app.models.assistant import AssistantMessage

    f = assistant_client
    response = test_assistant.question(
        f, test_assistant.create(f), question="旧任务中的秘密", context="", answer_mode="general"
    )
    assert response.status_code == 200
    task = response.json()
    for message in f.db.scalars(
        select(AssistantMessage).where(AssistantMessage.task_id == task["id"])
    ).all():
        message.application_scope = {}
        message.data_sources = '["knowledge"]'
    f.db.commit()
    monkeypatch.setattr(solution_knowledge, "check_access", lambda claims: None)
    response = test_assistant.question(
        f, task, question="前面这个问题是什么？", context="", answer_mode="general"
    )
    assert response.status_code == 200, response.text
    assert "旧任务中的秘密" not in json.dumps(f.calls[-1]["messages"], ensure_ascii=False)
