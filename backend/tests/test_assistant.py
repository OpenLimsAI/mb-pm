"""Private assistant tasks, model dialogue and replay protection in isolated SQLite."""

import importlib.util
import json
from pathlib import Path
from uuid import uuid4

import pytest
import test_solution_ai
import test_solutions
from sqlalchemy import create_engine, inspect, text

from app.api.v1 import assistant
from app.models.assistant import AssistantMessage, AssistantTask
from app.services import ai, password_policy, solution_ai

solution_client = test_solutions.solution_client
PREFIX = "/api/v1/assistant/tasks"


@pytest.fixture
def assistant_client(solution_client, monkeypatch):
    f = solution_client
    f.client.app.include_router(assistant.router, prefix="/api/v1")
    monkeypatch.setattr(
        ai,
        "load_settings",
        lambda: {"provider": "ollama", "providers": {"ollama": {"model": "isolated-test"}}},
    )
    f.calls = []

    def chat(provider, cfg, messages, **kwargs):
        assert not f.db.in_transaction(), "model call held a database transaction"
        f.calls.append({"provider": provider, "cfg": cfg, "messages": messages, **kwargs})
        return "## 工作结果\n\n根据用户提供内容形成的建议，仍需核对。", {}

    monkeypatch.setattr(ai, "chat", chat)
    return f


def create(f, **changes):
    response = f.client.post(
        PREFIX,
        json={
            "id": str(uuid4()),
            "title": "整理研究计划",
            "instructions": "先列问题，再给行动建议",
            **changes,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def question(f, task, **changes):
    return f.client.post(
        f"{PREFIX}/{task['id']}/messages",
        json={
            "revision": task["revision"],
            "request_id": str(uuid4()),
            "question": "请帮我拆解下一步计划",
            "context": "研究背景与待验证问题。",
            "model_profile_id": "enterprise",
            **changes,
        },
    )


def test_chat_persists_pair_and_result_artifact(assistant_client):
    f = assistant_client
    task = create(f)
    response = question(f, task)
    assert response.status_code == 200, response.text
    saved = response.json()
    assert saved["revision"] == 2 and saved["message_count"] == 2
    assert [row["role"] for row in saved["messages"]] == ["user", "assistant"]
    assert saved["messages"][0]["context"] == "研究背景与待验证问题。"
    assert saved["messages"][1]["context"] == ""
    assert saved["artifacts"][0]["content"] == saved["messages"][1]["content"]
    assert saved["artifacts"][0]["id"] == saved["messages"][1]["id"]
    assert "owner_id" not in response.text and "profile_id" not in response.text
    assert saved["created_at"].endswith("+00:00")
    assert f.client.get(f"{PREFIX}/{task['id']}").json() == saved
    listed = f.client.get(PREFIX).json()["items"][0]
    assert listed["message_count"] == 2 and "messages" not in listed
    call = f.calls[0]
    assert call["provider"] == "ollama" and call["timeout"] == 60
    assert "没有浏览器" in call["messages"][0]["content"]
    assert (
        json.loads(call["messages"][-1]["content"])["reference_material"]
        == "研究背景与待验证问题。"
    )


@pytest.mark.parametrize("context", ["", "  \n  "], ids=["empty", "whitespace"])
@pytest.mark.parametrize("sources", [[], ["knowledge"]], ids=["disabled", "allowed"])
def test_general_question_does_not_send_empty_application_or_reference_fields(
    assistant_client, monkeypatch, context, sources
):
    from app.services import assistant as service

    f = assistant_client

    def unused(*_args, **_kwargs):
        pytest.fail("general answer must not retrieve application or web data")

    monkeypatch.setattr(service, "application_data", unused)
    monkeypatch.setattr(service.assistant_tool_chat, "chat", unused)
    monkeypatch.setattr(service.web_search, "answer", unused)
    prompt = "你觉得上游培养过程中有哪些因素能影响抗体片段的产生？或者说能降低抗体片段的百分比？"
    response = question(
        f,
        create(f),
        question=prompt,
        context=context,
        data_sources=sources,
        answer_mode="auto",
    )
    assert response.status_code == 200, response.text
    assert json.loads(f.calls[-1]["messages"][-1]["content"]) == {"question": prompt}
    saved = response.json()
    answer = saved["messages"][-1]
    assert answer["answer_mode"] == "general" and answer["used_sources"] == []
    assert answer["web_references"] == []
    assert saved["messages"][0]["context"] == context
    assert saved["artifacts"][0]["content"] == answer["content"]


def test_create_retry_and_metadata_conflicts(assistant_client):
    f = assistant_client
    task = create(f)
    original = {key: task[key] for key in ("id", "title", "instructions")}
    assert f.client.post(PREFIX, json=original).json() == task
    assert f.client.post(PREFIX, json={**original, "title": "另一内容"}).status_code == 409
    draft = {"revision": 1, "title": "新标题", "instructions": "简洁"}
    changed = f.client.put(f"{PREFIX}/{task['id']}", json=draft).json()
    assert changed["title"] == "新标题" and changed["revision"] == 2
    assert f.client.put(f"{PREFIX}/{task['id']}", json=draft).status_code == 409
    assert question(f, task).status_code == 409 and f.calls == []
    assert f.client.get(PREFIX, params={"search": "新标题"}).json()["total"] == 1
    assert f.client.get(PREFIX, params={"search": "整理研究计划"}).json()["total"] == 0


def test_owner_and_issuer_isolate_every_route(assistant_client):
    f = assistant_client
    task = create(f)
    question(f, task)
    f.login("other")
    assert f.client.get(PREFIX).json()["total"] == 0
    assert f.client.get(f"{PREFIX}/{task['id']}").status_code == 404
    assert question(f, task).status_code == 404
    for suffix in ("trash", "restore"):
        assert (
            f.client.post(f"{PREFIX}/{task['id']}/{suffix}", json={"revision": 2}).status_code
            == 404
        )
    assert (
        f.client.put(f"{PREFIX}/{task['id']}", json={"revision": 2, "title": "窃取"}).status_code
        == 404
    )
    assert (
        f.client.post(
            PREFIX, json={key: task[key] for key in ("id", "title", "instructions")}
        ).status_code
        == 409
    )
    f.login()
    row = f.db.get(AssistantTask, task["id"])
    row.issuer = "https://other-issuer.example"
    f.db.commit()
    assert f.client.get(PREFIX).json()["total"] == 0
    assert f.client.get(f"{PREFIX}/{task['id']}").status_code == 404


def test_auth_origin_and_temporary_password(assistant_client):
    f = assistant_client
    f.client.cookies.clear()
    assert f.client.get(PREFIX).status_code == 401
    f.login()
    assert (
        f.client.post(
            PREFIX, json={"id": str(uuid4())}, headers={"Origin": "https://other.example"}
        ).status_code
        == 403
    )
    f.client.headers.pop("Origin")
    assert f.client.post(PREFIX, json={"id": str(uuid4())}).status_code == 403
    password_policy.require_change(f.db, "author", "reset")
    f.db.commit()
    assert f.client.get(PREFIX).status_code == 403


def test_trash_restore_retains_messages_and_outputs(assistant_client):
    f = assistant_client
    saved = question(f, create(f)).json()
    path = f"{PREFIX}/{saved['id']}"
    assert f.client.post(path + "/trash", json={"revision": 1}).status_code == 409
    deleted = f.client.post(path + "/trash", json={"revision": 2}).json()
    assert deleted["deleted_at"] and deleted["message_count"] == 2
    assert "messages" not in deleted and "artifacts" not in deleted and "context" not in deleted
    assert f.client.get(PREFIX).json()["total"] == 0
    assert f.client.get(PREFIX, params={"trashed": True}).json()["total"] == 1
    assert question(f, deleted).status_code == 409
    restored = f.client.post(path + "/restore", json={"revision": 3}).json()
    assert restored["revision"] == 4 and restored["deleted_at"] is None
    assert "messages" not in restored and "artifacts" not in restored and "context" not in restored
    detail = f.client.get(path).json()
    assert detail["messages"] == saved["messages"] and detail["artifacts"] == saved["artifacts"]


def test_request_retry_does_not_regenerate(assistant_client):
    f = assistant_client
    task = create(f)
    request = str(uuid4())
    saved = question(f, task, request_id=request).json()
    assert question(f, task, request_id=request).json() == saved
    assert len(f.calls) == 1
    for patch in (
        {"question": "另一个问题"},
        {"context": "另一个附件"},
        {"model_profile_id": None},
    ):
        assert question(f, task, request_id=request, **patch).status_code == 409
    assert len(f.calls) == 1 and f.db.query(AssistantMessage).count() == 2


@pytest.mark.parametrize(
    "failure", [ai.AIError("SECRET_PROVIDER_RESPONSE"), OSError("secret"), ValueError("secret")]
)
def test_failure_scrubs_provider_error_and_preserves_task(assistant_client, monkeypatch, failure):
    f = assistant_client
    task = create(f)

    def fail(*_args, **_kwargs):
        raise failure

    monkeypatch.setattr(ai, "chat", fail)
    response = question(f, task)
    assert response.status_code == 503
    assert "secret" not in response.text.lower()
    assert f.client.get(f"{PREFIX}/{task['id']}").json() == task


def test_generation_cannot_overwrite_concurrent_task_change(assistant_client, monkeypatch):
    f = assistant_client
    task = create(f)

    def concurrent(*_args, **_kwargs):
        assert not f.db.in_transaction()
        row = f.db.get(AssistantTask, task["id"])
        row.title = "另一页面保存的名称"
        row.revision += 1
        f.db.commit()
        return "不应覆盖已更新任务", {}

    monkeypatch.setattr(ai, "chat", concurrent)
    assert question(f, task).status_code == 409
    current = f.client.get(f"{PREFIX}/{task['id']}").json()
    assert current["title"] == "另一页面保存的名称"
    assert current["messages"] == [] and current["revision"] == 2


def test_private_model_uses_owned_encrypted_config(assistant_client, monkeypatch):
    f = assistant_client
    assert test_solution_ai.save(f).status_code == 200
    calls = []

    def private(cfg, messages, **_kwargs):
        assert not f.db.in_transaction()
        assert cfg["api_key"] == test_solution_ai.FAKE_KEY
        calls.append(messages)
        return "个人模型回复", {}

    monkeypatch.setattr(solution_ai, "chat", private)
    response = question(f, create(f), model_profile_id=None)
    assert (
        response.status_code == 200 and response.json()["messages"][-1]["model"] == "research-test"
    )
    assert test_solution_ai.FAKE_KEY not in response.text and len(calls) == 1
    f.login("other")
    assert question(f, create(f), model_profile_id="personal-model-1").status_code == 404


def test_bounded_history_and_task_boundary(assistant_client):
    f = assistant_client
    task = create(f)
    for i in range(5):
        task = question(f, task, question=f"当前任务问题{i}", context=f"参考资料{i}").json()
    question(f, create(f, title="另一个任务"), question="不能读取的另一个任务秘密")
    question(f, task, question="继续当前任务")
    call = f.calls[-1]["messages"]
    value = json.dumps(call, ensure_ascii=False)
    assert "当前任务问题0" not in value and "当前任务问题1" not in value
    assert "当前任务问题4" in value and "参考资料4" not in value
    assert "另一个任务秘密" not in value and len(call) <= 9


@pytest.mark.parametrize(
    "patch",
    [
        {"question": " "},
        {"question": "字" * 12001},
        {"context": "字" * 20001},
        {"request_id": "bad"},
        {"revision": 0},
        {"owner_id": "other"},
    ],
)
def test_invalid_question_input(assistant_client, patch):
    f = assistant_client
    assert question(f, create(f), **patch).status_code == 422 and f.calls == []


def test_missing_model_and_retrieval_do_not_fall_back(assistant_client, monkeypatch):
    f = assistant_client
    task = create(f)
    assert question(f, task, model_profile_id="retrieval").status_code == 422
    assert question(f, task, model_profile_id="missing").status_code == 404
    monkeypatch.setattr(
        ai,
        "load_settings",
        lambda: {
            "provider": "deepseek",
            "providers": {"deepseek": {"model": "test", "api_key": ""}},
        },
    )
    assert question(f, task).status_code == 422 and f.calls == []


def test_migration_is_repeatable_and_retains_legacy_tables():
    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    path = Path(__file__).parents[1] / "alembic/versions/2026_10_25_0300-010_assistant_tasks.py"
    spec = importlib.util.spec_from_file_location("assistant_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE unrelated_legacy_data (id INTEGER)"))
        with Operations.context(MigrationContext.configure(connection)):
            module.upgrade()
            module.upgrade()
            info = inspect(connection)
            for model in (AssistantTask, AssistantMessage):
                actual = {
                    column["name"]: column for column in info.get_columns(model.__tablename__)
                }
                expected = set(model.__table__.columns.keys())
                if model is AssistantTask:
                    expected.remove("active_request_id")  # introduced by migration 016
                    expected -= {"memory", "pinned", "final_artifact_id"}  # 017
                if model is AssistantMessage:
                    expected.remove("data_sources")  # introduced by migration 012
                    expected -= {
                        "answer_mode",
                        "requested_mode",
                        "mode_reason",
                        "web_references",
                    }  # 014
                    expected.remove("application_scope")  # introduced by migration 015
                    expected -= {"knowledge_references", "source_summary"}  # 017
                assert set(actual) == expected
                for column in model.__table__.columns:
                    if column.name in expected:
                        assert actual[column.name]["nullable"] == column.nullable
            assert info.get_foreign_keys("assistant_tasks") == []
            assert {item["name"] for item in info.get_unique_constraints("assistant_messages")} == {
                "uq_assistant_messages_request_role",
                "uq_assistant_messages_position",
            }
            module.downgrade()
            assert inspect(connection).get_table_names() == ["unrelated_legacy_data"]
    engine.dispose()


@pytest.mark.parametrize(
    "patch",
    [
        {"title": " "},
        {"title": "字" * 201},
        {"project": "已移除字段"},
        {"instructions": "字" * 4001},
        {"id": "bad"},
        {"owner_id": "other"},
    ],
)
def test_invalid_task_metadata(assistant_client, patch):
    f = assistant_client
    response = f.client.post(PREFIX, json={"id": str(uuid4()), **patch})
    assert response.status_code == 422
    assert f.client.get(PREFIX).json()["total"] == 0


def test_pagination_and_literal_search(assistant_client):
    f = assistant_client
    for i in range(101):
        create(f, title=f"100%计划{i}" if i == 3 else f"计划{i}")
    first = f.client.get(PREFIX).json()
    second = f.client.get(PREFIX, params={"offset": 100}).json()
    assert first["total"] == 101 and len(first["items"]) == 100
    assert len(second["items"]) == 1
    assert not ({row["id"] for row in first["items"]} & {row["id"] for row in second["items"]})
    assert f.client.get(PREFIX, params={"search": "%"}).json()["total"] == 1
    assert f.client.get(PREFIX, params={"offset": 10**30}).status_code == 422


@pytest.mark.parametrize(
    "result", ["", "  ", "字" * 80001, None], ids=["empty", "blank", "oversized", "null"]
)
def test_invalid_model_reply_is_not_persisted(assistant_client, monkeypatch, result):
    f = assistant_client
    task = create(f)
    monkeypatch.setattr(ai, "chat", lambda *_args, **_kwargs: (result, {}))
    assert question(f, task).status_code == (
        422 if isinstance(result, str) and len(result) > 80000 else 503
    )
    assert f.client.get(f"{PREFIX}/{task['id']}").json()["messages"] == []


def test_message_limit_does_not_call_model(assistant_client):
    f = assistant_client
    task = create(f)
    for position in range(200):
        f.db.add(
            AssistantMessage(
                id=str(uuid4()),
                task_id=task["id"],
                request_id=str(uuid4()),
                position=position,
                role="user" if position % 2 == 0 else "assistant",
                content="历史",
                context="",
                model="test",
            )
        )
    f.db.commit()
    assert question(f, task).status_code == 422 and f.calls == []


def test_scope_isolation_and_replay(assistant_client, monkeypatch):
    from app.services import assistant as service

    f = assistant_client
    monkeypatch.setattr(
        service,
        "application_data",
        lambda db, claims, payload: {
            key: {"active_material_count": 7, "note": "机密应用数据"}
            for key in payload.data_sources
        },
    )
    monkeypatch.setattr(
        service.assistant_tool_chat,
        "chat",
        lambda provider, cfg, messages, claims, **kwargs: ai.chat(provider, cfg, messages)[0],
    )
    monkeypatch.setattr(service.solution_knowledge, "check_access", lambda claims: None)
    task = create(f)
    request_id = str(uuid4())
    response = question(f, task, request_id=request_id, data_sources=["knowledge"])
    assert response.status_code == 200
    task = response.json()
    assert "机密应用数据" in json.dumps(f.calls[-1]["messages"], ensure_ascii=False)
    assert "不得用一般知识推测或编造业务事实" in f.calls[-1]["messages"][0]["content"]
    assert question(f, task, request_id=request_id, data_sources=[]).status_code == 409
    assert question(f, task, data_sources=[]).status_code == 200
    latest = json.dumps(f.calls[-1]["messages"], ensure_ascii=False)
    assert "机密应用数据" not in latest
    assert "工作结果" not in latest


def test_knowledge_question_supplies_full_catalogue_count(assistant_client, monkeypatch):
    from app.services import solution_knowledge

    f = assistant_client
    monkeypatch.setattr(solution_knowledge, "paper_count", lambda claims: 63)
    monkeypatch.setattr(solution_knowledge, "check_access", lambda claims: None)
    from app.services import assistant_tool_chat

    def tool_chat(provider, cfg, messages, claims, **kwargs):
        f.calls.append({"messages": messages})
        return "知识库当前有63项有效材料，不能等同论文篇数"

    monkeypatch.setattr(assistant_tool_chat, "chat", tool_chat)
    response = question(f, create(f), data_sources=["knowledge"])
    assert response.status_code == 200, response.text
    data = json.loads(f.calls[-1]["messages"][-1]["content"])["application_data"]["knowledge"]
    assert data["active_material_count"] == 63
    assert "只读查询工具" in data["note"]


def test_knowledge_failure_does_not_call_model(assistant_client, monkeypatch):
    from fastapi import HTTPException

    from app.services import solution_knowledge

    f = assistant_client

    def unavailable(*args, **kwargs):
        raise HTTPException(503, "知识库不可用")

    monkeypatch.setattr(solution_knowledge, "paper_count", unavailable)
    response = question(f, create(f), data_sources=["knowledge"])
    assert response.status_code == 503
    assert f.calls == []


def test_unbound_project_source_cannot_read_project_data(assistant_client):
    f = assistant_client
    task = create(f)
    assert (
        question(f, task, question="目前有哪些项目", data_sources=["projects"]).status_code == 403
    )
    assert (
        question(
            f, task, question="目前有哪些项目", data_sources=["projects", "knowledge"]
        ).status_code
        == 403
    )
    assert f.calls == []
    assert f.client.get(f"{PREFIX}/{task['id']}").json()["messages"] == []


def test_legacy_grouped_task_remains_usable_without_exposing_group(assistant_client):
    f = assistant_client
    task = create(f)
    row = f.db.get(AssistantTask, task["id"])
    row.project = "旧分组专用词"
    f.db.commit()
    assert "project" not in f.client.get(f"{PREFIX}/{task['id']}").json()
    assert f.client.get(PREFIX, params={"search": "旧分组专用词"}).json()["total"] == 0
    assert f.client.get(PREFIX, params={"search": task["title"]}).json()["total"] == 1
    edited = f.client.put(
        f"{PREFIX}/{task['id']}",
        json={"revision": task["revision"], "title": "修改后任务", "instructions": "新指引"},
    )
    assert edited.status_code == 200
    assert "project" not in edited.json()
    answered = question(f, edited.json())
    assert answered.status_code == 200
    assert answered.json()["message_count"] == 2
    f.db.expire_all()
    assert f.db.get(AssistantTask, task["id"]).project == "旧分组专用词"


def test_data_sources_migration_upgrade_repeat_and_downgrade():
    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    path = (
        Path(__file__).parents[1] / "alembic/versions/2026_10_30_0100-012_assistant_data_sources.py"
    )
    spec = importlib.util.spec_from_file_location("assistant_scope_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        connection.execute(
            text("CREATE TABLE assistant_messages (id TEXT PRIMARY KEY, content TEXT NOT NULL)")
        )
        connection.execute(text("INSERT INTO assistant_messages VALUES ('one', 'original')"))
        with Operations.context(MigrationContext.configure(connection)):
            module.upgrade()
            module.upgrade()
            columns = {c["name"]: c for c in inspect(connection).get_columns("assistant_messages")}
            assert columns["data_sources"]["nullable"] is False
            assert (
                connection.execute(text("SELECT data_sources FROM assistant_messages")).scalar_one()
                == "[]"
            )
            connection.execute(
                text("UPDATE assistant_messages SET data_sources = '[\"projects\"]'")
            )
            module.downgrade()
            assert {c["name"] for c in inspect(connection).get_columns("assistant_messages")} == {
                "id",
                "content",
            }
            assert (
                connection.execute(text("SELECT content FROM assistant_messages")).scalar_one()
                == "original"
            )
    engine.dispose()


def test_kb_tools_route_uses_pinned_private_transport(assistant_client, monkeypatch):
    from app.services import assistant_tool_chat, solution_knowledge

    f = assistant_client
    assert test_solution_ai.save(f).status_code == 200
    monkeypatch.setattr(solution_knowledge, "paper_count", lambda claims: 63)
    monkeypatch.setattr(solution_knowledge, "check_access", lambda claims: None)
    seen = []

    def tools(provider, cfg, messages, claims, **kwargs):
        assert not f.db.in_transaction()
        assert provider == "custom" and cfg["api_key"] == test_solution_ai.FAKE_KEY
        assert kwargs["request_fn"] is solution_ai.pinned_request
        seen.append(messages)
        return "已查询知识库原文"

    monkeypatch.setattr(assistant_tool_chat, "chat", tools)
    result = question(f, create(f), data_sources=["knowledge"], model_profile_id=None)
    assert result.status_code == 200 and len(seen) == 1
    assert test_solution_ai.FAKE_KEY not in result.text
    assert result.json()["messages"][-1]["content"] == "已查询知识库原文"


def test_unselected_knowledge_never_registers_or_executes_tools(assistant_client, monkeypatch):
    from app.services import assistant_tool_chat

    def forbidden(*args, **kwargs):
        raise AssertionError("Knowledge was not selected")

    monkeypatch.setattr(assistant_tool_chat, "chat", forbidden)
    f = assistant_client
    assert question(f, create(f)).status_code == 200 and len(f.calls) == 1


def test_kb_tool_failure_retains_task_and_request_for_retry(assistant_client, monkeypatch):
    from fastapi import HTTPException

    from app.services import assistant_tool_chat, solution_knowledge

    f = assistant_client
    monkeypatch.setattr(solution_knowledge, "paper_count", lambda claims: 63)
    monkeypatch.setattr(solution_knowledge, "check_access", lambda claims: None)

    def unavailable(*args, **kwargs):
        raise HTTPException(504, "知识库响应超时，请重试")

    monkeypatch.setattr(assistant_tool_chat, "chat", unavailable)
    task = create(f)
    result = question(f, task, data_sources=["knowledge"])
    assert result.status_code == 503 and "超时" in result.json()["detail"]
    assert f.client.get(f"{PREFIX}/{task['id']}").json() == task


def test_kb_native_tool_roundtrip_is_saved_only_after_final_reply(assistant_client, monkeypatch):
    from app.services import solution_knowledge

    f = assistant_client
    monkeypatch.setattr(solution_knowledge, "check_access", lambda claims: None)
    monkeypatch.setattr(solution_knowledge, "paper_count", lambda claims: 63)
    monkeypatch.setattr(solution_knowledge, "check_access", lambda claims: None)
    seen = []

    def request(provider, cfg, path, body, **kwargs):
        assert not f.db.in_transaction()
        seen.append(body)
        if len(seen) == 1:
            return {
                "message": {
                    "tool_calls": [
                        {
                            "function": {
                                "name": "read_page",
                                "arguments": {"path": "knowledge/cmc.md"},
                            }
                        }
                    ]
                }
            }
        assert "verified local evidence" in body["messages"][-1]["content"]
        return {"message": {"content": "依据 knowledge/cmc.md 的资料给出回答。"}}

    def core(method, path, **kwargs):
        assert method == "GET" and path == "/v1/base/pages/knowledge/cmc.md"
        return json.dumps(
            {"path": "knowledge/cmc.md", "layer": "knowledge", "body": "verified local evidence"}
        ).encode()

    monkeypatch.setenv("SOLUTION_KB_CORE_URL", "http://core.test")
    monkeypatch.setenv("SOLUTION_KB_TOKEN", "server-only-token")
    monkeypatch.setenv("SOLUTION_KB_PUBLIC_URL", "https://kb.test")
    monkeypatch.setattr(ai, "request", request)
    monkeypatch.setattr(solution_knowledge, "_request", core)
    task = create(f)
    request_id = str(uuid4())
    result = question(f, task, data_sources=["knowledge"], request_id=request_id)
    assert result.status_code == 200, result.text
    assert len(seen) == 2 and result.json()["message_count"] == 2
    assert "server-only-token" not in result.text and "verified local evidence" not in result.text
    assert (
        question(f, task, data_sources=["knowledge"], request_id=request_id).json() == result.json()
    )
    assert len(seen) == 2
