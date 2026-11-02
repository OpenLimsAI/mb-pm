"""Task continuity and provenance are useful without weakening source boundaries."""

import importlib.util
import json
from pathlib import Path
from uuid import uuid4

import pytest
import test_assistant
import test_solutions
from fastapi import HTTPException
from sqlalchemy import create_engine, inspect, text

from app.models.assistant import AssistantMessage
from app.services import answer_modes, assistant_knowledge, assistant_sources, solution_knowledge

solution_client = test_solutions.solution_client
assistant_client = test_assistant.assistant_client
PREFIX = test_assistant.PREFIX


def save(f, task, **patch):
    return f.client.put(f"{PREFIX}/{task['id']}", json={"revision": task["revision"], **patch})


def test_memory_pin_and_explicit_final_artifact(assistant_client):
    f = assistant_client
    task = test_assistant.create(f, memory="目标：形成可验证的实验计划。", pinned=True)
    answer = test_assistant.question(f, task, answer_mode="general").json()
    assert answer["memory"] == task["memory"] and answer["pinned"] is True
    assert any("user_maintained_summary" in row["content"] for row in f.calls[-1]["messages"])
    assert answer["final_artifact_id"] is None
    selected = save(f, answer, final_artifact_id=answer["messages"][-1]["id"])
    assert selected.status_code == 200, selected.text
    assert selected.json()["final_artifact_id"] == answer["messages"][-1]["id"]
    # Old clients changing only the title must not erase summary/pin/selection.
    renamed = save(f, selected.json(), title="新的名称")
    assert renamed.status_code == 200
    assert renamed.json()["memory"] == task["memory"] and renamed.json()["pinned"] is True
    assert renamed.json()["final_artifact_id"] == answer["messages"][-1]["id"]
    other = test_assistant.create(f)
    assert save(f, other, final_artifact_id=answer["messages"][-1]["id"]).status_code == 422
    assert save(f, renamed.json(), final_artifact_id=answer["messages"][0]["id"]).status_code == 422
    listed = f.client.get(PREFIX).json()["items"]
    assert listed[0]["id"] == task["id"]


def protected_answer(f, task):
    row = AssistantMessage(
        id=str(uuid4()),
        task_id=task["id"],
        request_id=str(uuid4()),
        position=0,
        role="assistant",
        content="资料中的敏感检索短语",
        context="",
        model="test",
        answer_mode="knowledge",
        data_sources='["knowledge"]',
        application_scope={"version": 1, "used_sources": ["knowledge"]},
        knowledge_references=[
            {
                "title": "原文",
                "path": "knowledge/research.md",
                "url": "https://knowledge.test/",
                "kind": "read",
                "cited": True,
            }
        ],
    )
    f.db.add(row)
    f.db.commit()
    return row


def test_fulltext_source_view_and_revocation_share_access_rules(assistant_client, monkeypatch):
    f = assistant_client
    task = test_assistant.create(f, title="研究任务")
    protected_answer(f, task)
    monkeypatch.setattr(solution_knowledge, "check_access", lambda claims: None)
    hits = f.client.get(PREFIX, params={"search": "敏感检索"}).json()
    assert hits["total"] == 1 and "敏感检索" in hits["items"][0]["excerpt"]

    def execute(claims, name, args):
        solution_knowledge.check_access(claims)
        assert name == "read_page" and args["path"] == "knowledge/research.md"
        return {
            "path": args["path"],
            "title": "原文",
            "body": "核验后的原文",
            "offset": 0,
            "total_chars": 7,
            "next_offset": None,
        }

    monkeypatch.setattr(assistant_knowledge, "execute", execute)
    original = f.client.get(
        f"{PREFIX}/{task['id']}/sources", params={"path": "knowledge/research.md"}
    )
    assert original.status_code == 200 and original.json()["body"] == "核验后的原文"
    assert (
        f.client.get(
            f"{PREFIX}/{task['id']}/sources", params={"path": "knowledge/other.md"}
        ).status_code
        == 404
    )

    def revoked(claims):
        raise HTTPException(403, "知识库权限已撤销")

    monkeypatch.setattr(solution_knowledge, "check_access", revoked)
    assert f.client.get(f"{PREFIX}/{task['id']}").status_code == 403
    assert (
        f.client.get(
            f"{PREFIX}/{task['id']}/sources", params={"path": "knowledge/research.md"}
        ).status_code
        == 403
    )
    assert f.client.get(PREFIX, params={"search": "敏感检索"}).json() == {"items": [], "total": 0}
    # Safe metadata and deletion remain available even for inaccessible history.
    title_hit = f.client.get(PREFIX, params={"search": "研究任务"}).json()
    assert title_hit["total"] == 1 and "excerpt" not in title_hit["items"][0]
    assert (
        f.client.post(
            f"{PREFIX}/{task['id']}/trash", json={"revision": task["revision"]}
        ).status_code
        == 200
    )


def test_source_provenance_distinguishes_catalogue_retrieval_read_and_citation():
    rows = [{"path": f"sources/{name}.md", "title": name} for name in ("a", "b", "c")]
    with assistant_sources.collect() as sources:
        assistant_sources.observe("list_pages", {"items": rows, "total": 300, "truncated": True})
        assistant_sources.observe(
            "retrieve_knowledge", {"page_refs": [rows[0], rows[1]], "chunks": []}
        )
        assistant_sources.observe("read_page", {**rows[0], "body": "正文"})
        refs, counts = sources.finish("依据 sources/a.md。", 300)
    assert [row["kind"] for row in refs] == ["read", "retrieved", "catalogued"]
    assert [row["cited"] for row in refs] == [True, False, False]
    assert counts == {
        "material_count": 300,
        "catalogued_count": 3,
        "retrieved_count": 2,
        "read_count": 1,
        "cited_count": 1,
        "truncated": True,
        "count_basis": "source_materials",
    }


def test_direct_reads_do_not_claim_retrieval_and_repeated_stages_count_once():
    row = {"path": "sources/direct.md", "title": "Direct"}
    with assistant_sources.collect() as sources:
        assistant_sources.observe("read_page", {**row, "body": "第一页"})
        assistant_sources.observe("read_page", {**row, "body": "第二页"})
        refs, counts = sources.finish("sources/direct.md", 10)
        assert counts["read_count"] == 1 and counts["retrieved_count"] == 0
        assert counts["catalogued_count"] == 0 and len(refs) == 1
        assistant_sources.observe("list_pages", {"items": [row]})
        refs, counts = sources.finish("sources/direct.md", 10)
        assert refs[0]["kind"] == "read"
        assert counts["catalogued_count"] == 1 and counts["read_count"] == 1
        assert counts["retrieved_count"] == 0


@pytest.mark.parametrize(
    "question,expected",
    [
        ("请深入分析", True),
        ("不要深入分析，给我简要回答", False),
        ("无需详细推导", False),
        ("请用严谨推导，不要编造数据", True),
        ("不要深入分析，但请详细推导这个公式", True),
        ("深入分析产品不稳定的原因", True),
    ],
)
def test_deep_reasoning_requires_affirmative_request(question, expected):
    assert answer_modes.deep_analysis(question) is expected


def test_long_followup_keeps_source_scope_and_new_topic_resets_it():
    prompt = "请继续解释上述材料中的限制，" + "特别关注实验条件和不确定性。" * 10
    assert len(prompt) > 80
    plan = answer_modes.decide_personal(
        prompt,
        "auto",
        data_sources=["knowledge"],
        previous_mode="knowledge",
        previous_sources=["knowledge"],
    )
    assert plan.mode == "knowledge"
    new = answer_modes.decide_personal(
        "换个话题，介绍抗体", "auto", data_sources=["knowledge"], previous_mode="knowledge"
    )
    assert new.mode == "general"


def test_application_followup_keeps_question_but_requeries_facts(assistant_client, monkeypatch):
    from app.services import assistant_tool_chat

    f = assistant_client
    reads, prompts = [], []
    monkeypatch.setattr(solution_knowledge, "check_access", lambda claims: None)
    monkeypatch.setattr(solution_knowledge, "paper_count", lambda claims: reads.append(1) or 13)

    def tool_chat(provider, cfg, messages, claims, **kwargs):
        prompts.append(json.dumps(messages, ensure_ascii=False))
        return "旧版检索事实不能作为本轮证据"

    monkeypatch.setattr(assistant_tool_chat, "chat", tool_chat)
    task = test_assistant.create(f)
    first = test_assistant.question(
        f,
        task,
        question="知识库中关于培养基的资料有哪些",
        context="旧附件不应重复发送",
        data_sources=["knowledge"],
        answer_mode="auto",
    )
    assert first.status_code == 200, first.text
    second = test_assistant.question(
        f,
        first.json(),
        question="请继续解释上述资料中的不确定性",
        context="",
        data_sources=["knowledge"],
        answer_mode="auto",
    )
    assert second.status_code == 200, second.text
    assert len(reads) == 2
    assert "知识库中关于培养基的资料有哪些" in prompts[-1]
    assert "requires_fresh_evidence" in prompts[-1]
    assert "旧版检索事实不能作为本轮证据" not in prompts[-1]
    assert "旧附件不应重复发送" not in prompts[-1]


def test_migration_017_additive_repeatable_preserves_legacy_contents():
    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    engine = create_engine("sqlite://")
    path = (
        Path(__file__).parents[1] / "alembic/versions/2026_11_02_0200-017_assistant_improvements.py"
    )
    spec = importlib.util.spec_from_file_location("assistant_improvements_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    with engine.begin() as connection:
        connection.execute(
            text("CREATE TABLE assistant_tasks (id VARCHAR(64) PRIMARY KEY, title TEXT)")
        )
        connection.execute(
            text("CREATE TABLE assistant_messages (id VARCHAR(64) PRIMARY KEY, content TEXT)")
        )
        connection.execute(text("CREATE TABLE assistant_requests (id VARCHAR(64) PRIMARY KEY)"))
        connection.execute(text("INSERT INTO assistant_tasks(id,title) VALUES ('old','Keep')"))
        connection.execute(
            text("INSERT INTO assistant_messages(id,content) VALUES ('answer','Original')")
        )
        with Operations.context(MigrationContext.configure(connection)):
            module.upgrade()
            module.upgrade()
            assert connection.execute(
                text("SELECT title,memory,pinned,final_artifact_id FROM assistant_tasks")
            ).one() == ("Keep", "", 0, None)
            answer = connection.execute(
                text("SELECT content,knowledge_references,source_summary FROM assistant_messages")
            ).one()
            assert (
                answer[0] == "Original"
                and json.loads(answer[1]) == []
                and json.loads(answer[2]) == {}
            )
            assert "first_content_at" in {
                c["name"] for c in inspect(connection).get_columns("assistant_requests")
            }
            assert "assistant_operations_config" in inspect(connection).get_table_names()
            with pytest.raises(RuntimeError):
                module.downgrade()
    engine.dispose()


def test_continuation_does_not_carry_kb_draft_into_auto_general_scope(
    assistant_client, monkeypatch
):
    import test_assistant_requests_security as helpers

    from app.services import assistant_generation, assistant_requests

    f = assistant_client
    task = test_assistant.create(f)
    body = helpers.payload(task)
    helpers.claimed(f, task, body)
    old = helpers.request_row(f, task, body["request_id"])
    old.application_scope = {"version": 1, "used_sources": ["knowledge"]}
    old.partial_content = "SECRET-KB-DRAFT"
    f.db.commit()
    monkeypatch.setattr(solution_knowledge, "check_access", lambda *_: None)
    assert (
        f.client.post(f"{PREFIX}/{task['id']}/requests/{body['request_id']}/cancel").status_code
        == 200
    )
    changed_question = helpers.payload(
        task,
        question="解释什么是抗体",
        answer_mode="auto",
        data_sources=["knowledge"],
        continue_from_request=body["request_id"],
    )
    assert helpers.submit(f, task, changed_question).status_code == 202
    row = helpers.request_row(f, task, changed_question["request_id"])
    chosen = assistant_requests.claim(f.db, row.id)

    def forbidden(*args, **kwargs):
        pytest.fail("auto general mode must never receive an application-derived draft")

    monkeypatch.setattr(assistant_generation, "call", forbidden)
    assistant_requests.execute(*chosen, factory=helpers.factory_for(f))
    state = helpers.status(f, task, changed_question["request_id"]).json()
    assert state["status"] == "failed" and "SECRET" not in json.dumps(state)
    assert f.client.get(f"{PREFIX}/{task['id']}").json()["messages"] == []
