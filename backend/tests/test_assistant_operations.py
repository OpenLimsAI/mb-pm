"""Cancellation fencing, retained drafts, readiness and content-free operations."""

from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
import test_assistant
import test_assistant_requests_security as helpers
from fastapi import HTTPException
from sqlalchemy import select

from app.models.assistant import AssistantRequest, AssistantTask
from app.services import accounts, ai, assistant_generation, assistant_requests, solution_knowledge

assistant_client = test_assistant.assistant_client
solution_client = test_assistant.solution_client
isolated_request_sessions = helpers.isolated_request_sessions
PREFIX = test_assistant.PREFIX


def cancel(f, task, body):
    return f.client.post(f"{PREFIX}/{task['id']}/requests/{body['request_id']}/cancel")


def test_queued_cancel_is_idempotent_and_never_calls_model(assistant_client):
    f = assistant_client
    task = test_assistant.create(f)
    body = helpers.payload(task)
    assert helpers.submit(f, task, body).status_code == 202
    for _ in range(2):
        response = cancel(f, task, body)
        assert response.status_code == 200 and response.json()["status"] == "cancelled"
    assert f.db.get(AssistantTask, task["id"]).active_request_id is None
    assert assistant_requests.claim(f.db) is None and not f.calls
    assert helpers.submit(f, task, body).json()["status"] == "cancelled"
    assert helpers.submit(f, task, helpers.payload(task)).status_code == 202


def test_cancel_fences_late_result_preserves_draft_and_allows_explicit_continuation(
    assistant_client, monkeypatch
):
    f = assistant_client
    task = test_assistant.create(f)
    body = helpers.payload(task)
    chosen = helpers.claimed(f, task, body)

    def model(*args, **kwargs):
        assistant_generation.progress(stage="generating", partial_content="未完成草稿")
        assert cancel(f, task, body).json()["status"] == "cancelled"
        return "取消后不应保存的回答", {}

    monkeypatch.setattr(assistant_generation, "call", model)
    assistant_requests.execute(*chosen, factory=helpers.factory_for(f))
    state = helpers.status(f, task, body["request_id"]).json()
    assert state["status"] == "cancelled" and state["partial_content"] == "未完成草稿"
    assert state["can_continue"] and state["finished_at"]
    assert f.client.get(f"{PREFIX}/{task['id']}").json()["messages"] == []
    continuation = helpers.payload(task, continue_from_request=body["request_id"])
    assert helpers.submit(f, task, continuation).status_code == 202
    row = helpers.request_row(f, task, continuation["request_id"])
    chosen = assistant_requests.claim(f.db, row.id)
    captured = []

    def resumed(_p, _cfg, messages, **_kwargs):
        captured.extend(messages)
        return "完整新回答", {}

    monkeypatch.setattr(assistant_generation, "call", resumed)
    assistant_requests.execute(*chosen, factory=helpers.factory_for(f))
    assert "未完成草稿" in str(captured)
    assert f.client.get(f"{PREFIX}/{task['id']}").json()["artifacts"][0]["content"] == "完整新回答"


def test_cancel_other_owner_never_mutates_and_permission_loss_never_exposes_draft(
    assistant_client, monkeypatch
):
    f = assistant_client
    task = test_assistant.create(f)
    body = helpers.payload(task)
    helpers.claimed(f, task, body)
    job = helpers.request_row(f, task, body["request_id"])
    job.application_scope = {"version": 1, "used_sources": ["knowledge"]}
    job.partial_content = "SECRET-KB-DRAFT"
    f.db.commit()
    f.login("other")
    assert cancel(f, task, body).status_code == 404
    assert helpers.request_row(f, task, body["request_id"]).status == "running"
    f.login()

    def denied(_claims):
        raise HTTPException(403, "权限已撤销")

    monkeypatch.setattr(solution_knowledge, "check_access", denied)
    response = cancel(f, task, body)
    assert response.status_code == 403 and "SECRET" not in response.text
    assert helpers.request_row(f, task, body["request_id"]).status == "cancelled"
    assert f.db.get(AssistantTask, task["id"]).active_request_id is None
    assert (
        helpers.submit(
            f, task, helpers.payload(task, continue_from_request=body["request_id"])
        ).status_code
        == 403
    )


def test_continuation_cannot_cross_tasks_or_relax_application_scope(assistant_client, monkeypatch):
    f = assistant_client
    task = test_assistant.create(f)
    body = helpers.payload(task)
    helpers.claimed(f, task, body)
    row = helpers.request_row(f, task, body["request_id"])
    row.application_scope = {"version": 1, "used_sources": ["knowledge"]}
    row.partial_content = "授权资料草稿"
    f.db.commit()
    monkeypatch.setattr(solution_knowledge, "check_access", lambda *_: None)
    assert cancel(f, task, body).status_code == 200
    assert (
        helpers.submit(
            f,
            test_assistant.create(f),
            helpers.payload(task, continue_from_request=body["request_id"]),
        ).status_code
        == 404
    )
    assert (
        helpers.submit(
            f, task, helpers.payload(task, continue_from_request=body["request_id"])
        ).status_code
        == 422
    )


def test_operations_requires_live_admin_and_never_returns_prompts_or_keys(
    assistant_client, monkeypatch
):
    f = assistant_client
    task = test_assistant.create(f)
    body = helpers.payload(task, question="SECRET-PROMPT", context="SECRET-CONTEXT")
    helpers.submit(f, task, body)
    monkeypatch.setattr(accounts, "live_roles", lambda _: set())
    assert f.client.get(PREFIX + "/operations").status_code == 403
    monkeypatch.setattr(accounts, "live_roles", lambda _: {"admin"})
    response = f.client.get(PREFIX + "/operations")
    assert response.status_code == 200 and response.json()["totals"]["queued"] == 1
    assert "SECRET" not in response.text and "worker_token" not in response.text
    assert response.headers["cache-control"] == "no-store"
    assert f.client.get(PREFIX + "/operations?diagnostic_id=not-valid").status_code == 422


def test_limits_validate_persist_and_enforce_admission(assistant_client, monkeypatch):
    f = assistant_client
    monkeypatch.setattr(accounts, "live_roles", lambda _: {"admin"})
    limits = {"per_user_pending": 1, "global_queued": 2, "per_user_running": 1, "retention_days": 0}
    assert (
        f.client.put(
            PREFIX + "/operations/settings", json={**limits, "retention_days": 2}
        ).status_code
        == 422
    )
    assert f.client.put(PREFIX + "/operations/settings", json=limits).json()["limits"] == limits
    task = test_assistant.create(f)
    assert helpers.submit(f, task, helpers.payload(task)).status_code == 202
    task2 = test_assistant.create(f)
    assert helpers.submit(f, task2, helpers.payload(task2)).status_code == 429
    assert f.client.post(PREFIX + "/operations/prune").status_code == 422


def test_prune_is_explicit_bounded_keeps_messages_and_idempotency_tombstone(
    assistant_client, monkeypatch
):
    f = assistant_client
    monkeypatch.setattr(accounts, "live_roles", lambda _: {"admin"})
    task = test_assistant.create(f)
    body = helpers.payload(task)
    assert helpers.submit(f, task, body).status_code == 202
    cancel(f, task, body)
    row = helpers.request_row(f, task, body["request_id"])
    row.finished_at = datetime.now(UTC) - timedelta(days=30)
    f.db.commit()
    limits = {
        "per_user_pending": 3,
        "global_queued": 100,
        "per_user_running": 1,
        "retention_days": 7,
    }
    f.client.put(PREFIX + "/operations/settings", json=limits)
    assert helpers.request_row(f, task, body["request_id"]).payload
    assert f.client.post(PREFIX + "/operations/prune").json() == {"pruned": 1}
    assert f.client.post(PREFIX + "/operations/prune").json() == {"pruned": 0}
    state = helpers.submit(f, task, body).json()
    assert state["status"] == "cancelled" and state["payload_expired"] is True
    assert state["question"] == "" and state["can_continue"] is False
    assert f.db.get(AssistantTask, task["id"]) is not None


def test_preflight_never_calls_model_and_checks_actual_scope_not_unused_checkbox(
    assistant_client, monkeypatch
):
    f = assistant_client

    def unused(*args, **kwargs):
        pytest.fail("preflight performed model inference or unnecessary KB access")

    monkeypatch.setattr(ai, "chat", unused)
    monkeypatch.setattr(solution_knowledge, "check_access", unused)
    response = f.client.post(
        PREFIX + "/preflight",
        json={
            "question": "什么是细胞培养",
            "model_profile_id": "enterprise",
            "data_sources": ["knowledge"],
        },
    )
    assert response.status_code == 200 and response.json()["ready"] is True
    assert [row["key"] for row in response.json()["checks"]] == ["model"]
    monkeypatch.setattr(
        ai,
        "load_settings",
        lambda: {"provider": "deepseek", "providers": {"deepseek": {"model": "x", "api_key": ""}}},
    )
    response = f.client.post(PREFIX + "/preflight", json={"model_profile_id": "enterprise"})
    assert response.json()["ready"] is False


def test_fair_queue_skips_owner_at_limit(assistant_client):
    f = assistant_client
    a, b = test_assistant.create(f), test_assistant.create(f)
    ba, bb = helpers.payload(a), helpers.payload(b)
    helpers.submit(f, a, ba)
    helpers.submit(f, b, bb)
    assert assistant_requests.claim(f.db)[0] == helpers.request_row(f, a, ba["request_id"]).id
    f.login("other")
    c = test_assistant.create(f)
    bc = helpers.payload(c)
    helpers.submit(f, c, bc)
    assert assistant_requests.claim(f.db)[0] == helpers.request_row(f, c, bc["request_id"]).id
    assert assistant_requests.claim(f.db) is None


def test_global_admission_limit_is_atomic_between_instances(isolated_request_sessions):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    from app.models.assistant import AssistantOperationsConfig
    from app.schemas.assistant import TaskQuestion

    engine, factory = isolated_request_sessions
    if engine.dialect.name != "postgresql":
        pytest.skip("Production PostgreSQL advisory transaction lock")
    task_a, claims = helpers.race_task(factory)
    task_b, _ = helpers.race_task(factory)
    with factory() as db:
        db.add(
            AssistantOperationsConfig(
                id="default",
                limits={
                    "per_user_pending": 1,
                    "global_queued": 1,
                    "per_user_running": 1,
                    "retention_days": 0,
                },
            )
        )
        db.commit()
    barrier = Barrier(2, timeout=5)

    def submit(task_id):
        barrier.wait()
        with factory() as db:
            try:
                assistant_requests.submit(
                    db,
                    claims,
                    db.get(AssistantTask, task_id),
                    TaskQuestion(
                        revision=1,
                        request_id=uuid4(),
                        question="并发提交",
                        answer_mode="general",
                    ),
                )
                return 202
            except HTTPException as exc:
                return exc.status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(submit, identifier) for identifier in (task_a, task_b)]
        assert sorted(f.result(timeout=15) for f in futures) == [202, 429]


def test_cleanup_moves_past_tombstones_and_preserves_completed_dialogue(
    assistant_client, monkeypatch
):
    from app.models.assistant import AssistantMessage, AssistantOperationsConfig

    f = assistant_client
    monkeypatch.setattr(accounts, "live_roles", lambda _: {"admin"})
    task = test_assistant.create(f)
    response = test_assistant.question(f, task)
    assert response.status_code == 200
    saved = response.json()["messages"]
    row = f.db.scalar(select(AssistantRequest).where(AssistantRequest.task_id == task["id"]))
    row.finished_at = datetime.now(UTC) - timedelta(days=20)
    for _ in range(1001):
        f.db.add(
            AssistantRequest(
                id=uuid4().hex,
                task_id=task["id"],
                request_id=str(uuid4()),
                payload={},
                fingerprint="x" * 64,
                status="cancelled",
                stage="cancelled",
                finished_at=datetime.now(UTC) - timedelta(days=30),
            )
        )
    f.db.add(
        AssistantOperationsConfig(
            id="default",
            limits={
                "per_user_pending": 3,
                "global_queued": 100,
                "per_user_running": 1,
                "retention_days": 7,
            },
        )
    )
    f.db.commit()
    assert f.client.post(PREFIX + "/operations/prune").json() == {"pruned": 1}
    assert f.client.get(f"{PREFIX}/{task['id']}").json()["messages"] == saved
    assert (
        len(
            f.db.scalars(
                select(AssistantMessage).where(AssistantMessage.task_id == task["id"])
            ).all()
        )
        == 2
    )


def test_legacy_inline_cannot_bypass_per_user_running_limit(assistant_client):
    f = assistant_client
    first = test_assistant.create(f)
    helpers.claimed(f, first, helpers.payload(first))
    second = test_assistant.create(f)
    response = test_assistant.question(f, second)
    assert response.status_code == 429
    assert f.calls == []
    assert f.db.get(AssistantTask, second["id"]).active_request_id is None


def test_preflight_blocks_revoked_history_before_routing_or_model_call(
    assistant_client, monkeypatch
):
    from app.models.assistant import AssistantMessage
    from app.services import answer_modes

    f = assistant_client
    task = test_assistant.create(f)
    f.db.add(
        AssistantMessage(
            id=uuid4().hex,
            task_id=task["id"],
            request_id=str(uuid4()),
            position=1,
            role="assistant",
            content="PRIVATE-HISTORICAL-KB",
            data_sources='["knowledge"]',
            answer_mode="knowledge",
            application_scope={"version": 1, "used_sources": ["knowledge"]},
        )
    )
    f.db.commit()

    def revoked(_claims):
        raise HTTPException(403, "当前知识库权限已撤销")

    def unused(*_args, **_kwargs):
        pytest.fail("preflight routed or generated using revoked historical context")

    monkeypatch.setattr(solution_knowledge, "check_access", revoked)
    monkeypatch.setattr(answer_modes, "decide_personal", unused)
    monkeypatch.setattr(ai, "chat", unused)
    response = f.client.post(
        PREFIX + "/preflight",
        json={
            "task_id": task["id"],
            "question": "还有呢",
            "model_profile_id": "enterprise",
            "answer_mode": "auto",
            "data_sources": ["knowledge"],
        },
    )
    assert response.status_code == 200
    assert response.json()["ready"] is False
    assert any(
        row["key"] == "scope" and row["status"] == "blocked" for row in response.json()["checks"]
    )
    assert "PRIVATE" not in response.text and not f.calls
