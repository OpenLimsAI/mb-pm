"""Topic continuity stays inside an author's report and never reuses generated evidence."""

import json

import pytest
import test_solutions
from test_solutions import PREFIX, add_source, create, question

from app.models.solution import SolutionAnswer
from app.services import ai

solution_client = test_solutions.solution_client


def model_calls(monkeypatch):
    calls = []
    monkeypatch.setattr(
        ai,
        "load_settings",
        lambda: {"provider": "ollama", "providers": {"ollama": {"model": "local-topic-test"}}},
    )

    def chat(_provider, _cfg, messages, **_kwargs):
        calls.append(json.loads(messages[1]["content"]))
        return "当前资料中的依据仍需验证 [1]。", {}

    monkeypatch.setattr(ai, "chat", chat)
    return calls


def test_groups_answers_and_limits_continuity_to_this_report_and_topic(
    solution_client, monkeypatch
):
    f = solution_client
    first, second = create(f), create(f, title="另一份报告")
    add_source(f)
    calls = model_calls(monkeypatch)
    for report, topic, text in [
        (first, "topic-a", "缓冲液主题甲"),
        (first, "topic-b", "缓冲液主题乙"),
        (second, "topic-a", "缓冲液其他报告"),
    ]:
        response = question(f, report, conversation_id=topic, question=text)
        assert response.status_code == 200, response.text
        assert response.json()["conversation_id"] == topic
    assert all("conversation_questions_not_evidence" not in call for call in calls)
    response = question(f, first, conversation_id="topic-a", question="继续比较缓冲液")
    assert response.status_code == 200
    assert calls[-1]["conversation_questions_not_evidence"] == ["缓冲液主题甲"]
    assert "当前资料中的依据仍需验证" not in json.dumps(calls[-1], ensure_ascii=False)
    history = f.client.get(f"{PREFIX}/{first['id']}/history").json()
    assert [item["conversation_id"] for item in history] == ["topic-a", "topic-b", "topic-a"]
    f.login("other-author")
    assert f.client.get(f"{PREFIX}/{first['id']}/history").status_code == 404
    assert question(f, first, conversation_id="topic-a").status_code == 404


def test_old_answer_can_be_continued_without_rewriting_it(solution_client, monkeypatch):
    f = solution_client
    report = create(f)
    add_source(f)
    old = question(f, report).json()
    row = f.db.get(SolutionAnswer, old["id"])
    row.conversation_id = None
    f.db.commit()
    calls = model_calls(monkeypatch)
    assert question(f, report, conversation_id=old["id"]).status_code == 200
    assert calls[-1]["conversation_questions_not_evidence"] == [old["question"]]
    f.db.refresh(row)
    assert row.conversation_id is None


@pytest.mark.parametrize("topic", ["", "a" * 81, "../topic", "topic?", []])
def test_invalid_topic_identifiers_rejected(solution_client, topic):
    f = solution_client
    response = question(f, create(f), conversation_id=topic)
    assert response.status_code == 422


def test_older_clients_get_distinct_topics_without_changing_report_revision(solution_client):
    f = solution_client
    report = create(f)
    first, second = question(f, report).json(), question(f, report).json()
    assert first["conversation_id"] and first["conversation_id"] != second["conversation_id"]
    assert f.client.get(f"{PREFIX}/{report['id']}").json()["revision"] == report["revision"]


def test_history_context_is_bounded_and_does_not_include_another_issuer(
    solution_client, monkeypatch
):
    f = solution_client
    report = create(f)
    add_source(f)
    calls = model_calls(monkeypatch)
    for i in range(8):
        assert (
            question(f, report, conversation_id="bounded", question=f"缓冲液问题 {i}").status_code
            == 200
        )
    last = f.db.get(SolutionAnswer, question(f, report, conversation_id="bounded").json()["id"])
    last.issuer = "https://other-issuer.example"
    f.db.commit()
    assert question(f, report, conversation_id="bounded").status_code == 200
    assert calls[-1]["conversation_questions_not_evidence"] == [
        f"缓冲液问题 {i}" for i in range(2, 8)
    ]
