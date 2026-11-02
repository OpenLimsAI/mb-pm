"""Durable dispatch, incremental progress, final persistence and migration contracts."""

import importlib.util
import json
from pathlib import Path
from uuid import uuid4

import test_assistant
from sqlalchemy import create_engine, inspect, select, text
from sqlalchemy.orm import sessionmaker

from app.models.assistant import AssistantRequest, AssistantTask
from app.services import assistant_generation as generation
from app.services import assistant_requests as requests

assistant_client = test_assistant.assistant_client
solution_client = test_assistant.solution_client
PREFIX = test_assistant.PREFIX


def submit(f, task, **changes):
    payload = {
        "revision": task["revision"],
        "request_id": str(uuid4()),
        "question": "什么是细胞培养",
        "context": "",
        "data_sources": [],
        "answer_mode": "auto",
        "model_profile_id": "enterprise",
        **changes,
    }
    response = f.client.post(f"{PREFIX}/{task['id']}/requests", json=payload)
    assert response.status_code == 202, response.text
    return payload, response.json()


def test_queue_survives_reopen_and_only_worker_generates(assistant_client, monkeypatch):
    f = assistant_client
    task = test_assistant.create(f)
    payload, state = submit(f, task)
    assert state["status"] == "queued" and f.calls == []
    active = f.client.get(f"{PREFIX}/{task['id']}/requests/active").json()["request"]
    assert (
        active["request_id"] == payload["request_id"] and active["question"] == payload["question"]
    )
    called = []

    def model(*_args, **_kwargs):
        called.append(1)
        generation.progress(stage="generating", partial_content="这是生成中的片段")
        with sessionmaker(bind=f.db.get_bind())() as probe:
            row = probe.scalar(
                select(AssistantRequest).where(AssistantRequest.request_id == payload["request_id"])
            )
            assert row.status == "running" and row.partial_content == "这是生成中的片段"
        return "这是完整的正式回答。", {}

    monkeypatch.setattr(generation, "call", model)
    with sessionmaker(bind=f.db.get_bind())() as db:
        job = db.scalar(
            select(AssistantRequest).where(AssistantRequest.request_id == payload["request_id"])
        )
        chosen = requests.claim(db, job.id)
        assert requests.claim(db, job.id) is None
    requests.execute(*chosen, factory=sessionmaker(bind=f.db.get_bind(), autoflush=False))
    f.db.expire_all()
    final = f.client.get(f"{PREFIX}/{task['id']}/requests/{payload['request_id']}").json()
    assert final["status"] == "completed" and final["partial_content"] == "" and called == [1]
    detail = f.client.get(f"{PREFIX}/{task['id']}").json()
    assert detail["revision"] == 2 and len(detail["messages"]) == 2
    assert detail["artifacts"][0]["content"] == "这是完整的正式回答。"
    assert (
        f.client.post(f"{PREFIX}/{task['id']}/requests", json=payload).json()["status"]
        == "completed"
    )
    assert f.client.get(f"{PREFIX}/{task['id']}/requests/active").json() == {"request": None}
    assert called == [1] and f.db.get(AssistantTask, task["id"]).active_request_id is None


def test_failure_keeps_question_but_does_not_publish_partial(assistant_client, monkeypatch):
    from app.services import ai

    f = assistant_client
    task = test_assistant.create(f)
    payload, _ = submit(f, task)

    def model(*_args, **_kwargs):
        generation.progress(stage="generating", partial_content="未完成的正文")
        raise ai.AIError("SECRET", code="model_timeout")

    monkeypatch.setattr(generation, "call", model)
    with sessionmaker(bind=f.db.get_bind())() as db:
        job = db.scalar(
            select(AssistantRequest).where(AssistantRequest.request_id == payload["request_id"])
        )
        chosen = requests.claim(db, job.id)
    requests.execute(*chosen, factory=sessionmaker(bind=f.db.get_bind(), autoflush=False))
    f.db.expire_all()
    state = f.client.get(f"{PREFIX}/{task['id']}/requests/{payload['request_id']}").json()
    assert state["status"] == "failed" and state["question"] == payload["question"]
    assert state["partial_content"] == "" and "SECRET" not in json.dumps(state)
    assert len(state["diagnostic_id"]) == 32
    assert f.client.get(f"{PREFIX}/{task['id']}").json()["messages"] == []
    assert f.db.get(AssistantTask, task["id"]).active_request_id is None


def test_migration_016_repeatable_additive_and_refuses_to_drop_requests():
    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    folder = Path(__file__).parents[1] / "alembic/versions"
    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        connection.execute(
            text("CREATE TABLE assistant_tasks (id VARCHAR(64) PRIMARY KEY, legacy TEXT)")
        )
        connection.execute(text("INSERT INTO assistant_tasks (id,legacy) VALUES ('old','KEEP')"))
        path = folder / "2026_11_02_0100-016_assistant_requests.py"
        spec = importlib.util.spec_from_file_location("assistant_requests_migration", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with Operations.context(MigrationContext.configure(connection)):
            module.upgrade()
            module.upgrade()
            assert {
                c["name"] for c in inspect(connection).get_columns("assistant_requests")
            } == set(AssistantRequest.__table__.columns.keys())
            assert connection.execute(
                text("SELECT legacy,active_request_id FROM assistant_tasks WHERE id='old'")
            ).one() == ("KEEP", None)
            module.downgrade()
            assert (
                connection.execute(
                    text("SELECT legacy FROM assistant_tasks WHERE id='old'")
                ).scalar_one()
                == "KEEP"
            )
    engine.dispose()
