"""Owned async requests, duplicate dispatch and late-worker writes in an isolated DB."""

from uuid import uuid4

import pytest
import test_assistant

from app.models.assistant import AssistantTask

solution_client = test_assistant.solution_client
assistant_client = test_assistant.assistant_client
PREFIX = test_assistant.PREFIX


def payload(task, **changes):
    return {
        "revision": task["revision"],
        "request_id": str(uuid4()),
        "question": "解释常见细胞培养因素",
        "context": "",
        "model_profile_id": "enterprise",
        "answer_mode": "general",
        "data_sources": [],
        **changes,
    }


def submit(f, task, body):
    return f.client.post(f"{PREFIX}/{task['id']}/requests", json=body)


def status(f, task, request_id):
    return f.client.get(f"{PREFIX}/{task['id']}/requests/{request_id}")


def active(f, task):
    return f.client.get(f"{PREFIX}/{task['id']}/requests/active")


def test_request_identity_and_issuer_scope_is_enforced_before_reading_payload(assistant_client):
    f = assistant_client
    task = test_assistant.create(f)
    body = payload(task, context="PRIVATE-QUEUED-MATERIAL")
    queued = submit(f, task, body)
    assert queued.status_code == 202, queued.text
    f.login("other")
    for response in (
        status(f, task, body["request_id"]),
        active(f, task),
        submit(f, task, body),
    ):
        assert response.status_code == 404
        assert "PRIVATE-QUEUED-MATERIAL" not in response.text
    f.login()
    row = f.db.get(AssistantTask, task["id"])
    row.issuer = "https://foreign-issuer.example"
    f.db.commit()
    for response in (status(f, task, body["request_id"]), active(f, task)):
        assert response.status_code == 404
        assert "PRIVATE-QUEUED-MATERIAL" not in response.text
    assert f.calls == []


@pytest.mark.parametrize(
    "change",
    [
        {"question": "另一个问题"},
        {"context": "不应替换已排队的资料"},
        {"model_profile_id": "another-profile"},
        {"answer_mode": "auto"},
    ],
)
def test_request_id_is_bound_to_its_original_payload(assistant_client, change):
    f = assistant_client
    task = test_assistant.create(f)
    body = payload(task)
    first = submit(f, task, body)
    assert first.status_code == 202, first.text
    repeated = submit(f, task, body)
    assert repeated.status_code == 202, repeated.text
    assert repeated.json()["request_id"] == body["request_id"]
    conflicting = submit(f, task, {**body, **change})
    assert conflicting.status_code == 409, conflicting.text
    assert f.calls == []
    assert f.client.get(f"{PREFIX}/{task['id']}").json()["messages"] == []


def test_pending_request_fences_legacy_generation_and_task_mutations(assistant_client):
    f = assistant_client
    task = test_assistant.create(f)
    body = payload(task)
    assert submit(f, task, body).status_code == 202
    responses = [
        test_assistant.question(f, task),
        f.client.put(
            f"{PREFIX}/{task['id']}",
            json={"title": "不应覆盖排队任务", "instructions": "", "revision": task["revision"]},
        ),
        f.client.post(f"{PREFIX}/{task['id']}/trash", json={"revision": task["revision"]}),
        submit(f, task, payload(task)),
    ]
    assert [response.status_code for response in responses] == [409, 409, 409, 409]
    current = f.client.get(f"{PREFIX}/{task['id']}").json()
    assert current["title"] == task["title"] and current["revision"] == task["revision"]
    assert current["deleted_at"] is None and current["messages"] == []
    assert f.calls == []


@pytest.mark.parametrize(
    "extra",
    [
        {"issuer": "https://attacker.example"},
        {"owner_id": "other"},
        {"status": "completed"},
        {"lease_owner": "forged-worker"},
        {"application_scope": {"version": 1, "used_sources": []}},
    ],
)
def test_user_cannot_supply_request_execution_or_authorization_state(assistant_client, extra):
    f = assistant_client
    task = test_assistant.create(f)
    response = submit(f, task, payload(task, **extra))
    assert response.status_code == 422, response.text
    assert f.calls == []


def test_request_responses_are_not_cached_and_do_not_expose_execution_secrets(assistant_client):
    f = assistant_client
    task = test_assistant.create(f)
    body = payload(task, context="OWNED-REFERENCE-CONTENT")
    queued = submit(f, task, body)
    assert queued.status_code == 202, queued.text
    for response in (queued, status(f, task, body["request_id"]), active(f, task)):
        assert response.status_code in (200, 202), response.text
        assert "no-store" in response.headers.get("cache-control", "")
        assert all(
            name not in response.text
            for name in ("api_key", "lease_owner", "lease_token", "encrypted_payload")
        )
    assert f.calls == []


def request_row(f, task, request_id):
    from sqlalchemy import select

    from app.models.assistant import AssistantRequest

    f.db.expire_all()
    return f.db.scalar(
        select(AssistantRequest).where(
            AssistantRequest.task_id == task["id"], AssistantRequest.request_id == request_id
        )
    )


def claimed(f, task, body):
    from app.services import assistant_requests

    assert submit(f, task, body).status_code == 202
    row = request_row(f, task, body["request_id"])
    identifier = row.id
    f.db.rollback()
    result = assistant_requests.claim(f.db, identifier)
    assert result and result[0] == identifier
    return result


def factory_for(f):
    from sqlalchemy.orm import sessionmaker

    return sessionmaker(bind=f.db.get_bind(), autoflush=False)


def test_foreign_status_lookup_cannot_expire_or_unlock_another_owners_request(assistant_client):
    from datetime import UTC, datetime, timedelta

    from app.services import assistant_requests

    f = assistant_client
    task = test_assistant.create(f)
    body = payload(task)
    job_id, _ = claimed(f, task, body)
    row = request_row(f, task, body["request_id"])
    row.lease_until = datetime.now(UTC) - timedelta(seconds=1)
    row.partial_content = "PRIVATE-EXPIRED-WORK"
    f.db.commit()
    f.login("other")
    for response in (status(f, task, body["request_id"]), active(f, task)):
        assert response.status_code == 404 and "PRIVATE-EXPIRED-WORK" not in response.text
    row = request_row(f, task, body["request_id"])
    assert row.status == "running"
    assert f.db.get(AssistantTask, task["id"]).active_request_id == job_id
    f.db.rollback()
    f.login()
    failed = status(f, task, body["request_id"])
    assert failed.status_code == 200 and failed.json()["status"] == "failed"
    assert failed.json()["partial_content"] == ""
    assert assistant_requests.claim(f.db, job_id) is None
    assert f.calls == []


def test_expired_running_request_is_failed_without_automatic_generation(assistant_client):
    from datetime import UTC, datetime, timedelta

    from app.services import assistant_requests

    f = assistant_client
    task = test_assistant.create(f)
    body = payload(task)
    job_id, _ = claimed(f, task, body)
    row = request_row(f, task, body["request_id"])
    row.lease_until = datetime.now(UTC) - timedelta(seconds=1)
    f.db.commit()
    first = status(f, task, body["request_id"])
    assert first.status_code == 200 and first.json()["status"] == "failed"
    duplicate = submit(f, task, body)
    assert duplicate.status_code == 202 and duplicate.json()["status"] == "failed"
    assert assistant_requests.claim(f.db, job_id) is None
    assert f.db.get(AssistantTask, task["id"]).active_request_id is None
    assert f.calls == []
    next_attempt = submit(f, task, payload(task))
    assert next_attempt.status_code == 202 and next_attempt.json()["status"] == "queued"


@pytest.mark.parametrize("replace_token", [False, True], ids=["expired-lease", "fenced-token"])
def test_old_worker_cannot_save_after_its_execution_lease_is_lost(
    assistant_client, monkeypatch, replace_token
):
    from datetime import UTC, datetime, timedelta

    from sqlalchemy import func, select

    from app.models.assistant import AssistantMessage
    from app.services import ai, assistant_requests

    f = assistant_client
    task = test_assistant.create(f)
    body = payload(task)
    job_id, token = claimed(f, task, body)
    calls = []

    def model(*_args, **_kwargs):
        calls.append(True)
        row = request_row(f, task, body["request_id"])
        if replace_token:
            row.worker_token = uuid4().hex
        else:
            row.lease_until = datetime.now(UTC) - timedelta(seconds=1)
        f.db.commit()
        return "LATE-WORKER-CONTENT-MUST-NOT-BE-SAVED", {}

    monkeypatch.setattr(ai, "chat", model)
    assistant_requests.execute(job_id, token, factory=factory_for(f), streaming=False)
    f.db.expire_all()
    assert len(calls) == 1
    assert f.db.scalar(select(func.count()).select_from(AssistantMessage)) == 0
    current = f.db.get(AssistantTask, task["id"])
    assert current.revision == task["revision"]
    assert request_row(f, task, body["request_id"]).status != "completed"


@pytest.mark.parametrize("status_code", [403, 503], ids=["revoked", "permission-unavailable"])
def test_application_partial_is_reauthorized_before_each_status_read(
    assistant_client, monkeypatch, status_code
):
    from fastapi import HTTPException

    from app.services import assistant_requests, solution_knowledge

    f = assistant_client
    task = test_assistant.create(f)
    body = payload(task, answer_mode="knowledge", data_sources=["knowledge"])
    job_id, token = claimed(f, task, body)
    denied = []

    def permission(_claims):
        if denied:
            raise HTTPException(status_code, "知识库访问暂不可用")

    monkeypatch.setattr(solution_knowledge, "check_access", permission)
    execution = assistant_requests.Execution(job_id, token, factory_for(f))
    context_token = assistant_requests.CURRENT.set(execution)
    try:
        assistant_requests.progress(
            application_scope={"version": 1, "used_sources": ["knowledge"]},
            stage="generating",
            partial_content="PRIVATE-KNOWLEDGE-PARTIAL",
        )
    finally:
        assistant_requests.CURRENT.reset(context_token)
    permitted = status(f, task, body["request_id"])
    assert permitted.status_code == 200
    assert permitted.json()["partial_content"] == "PRIVATE-KNOWLEDGE-PARTIAL"
    denied.append(True)
    for response in (status(f, task, body["request_id"]), active(f, task)):
        assert response.status_code == status_code
        assert "PRIVATE-KNOWLEDGE-PARTIAL" not in response.text
    f.db.rollback()
    assert request_row(f, task, body["request_id"]).status == "running"
    assert f.calls == []


def test_unused_knowledge_checkbox_does_not_require_knowledge_permission(
    assistant_client, monkeypatch
):
    from app.services import solution_knowledge

    f = assistant_client
    task = test_assistant.create(f)
    body = payload(task, data_sources=["knowledge"])

    def unused(*_args, **_kwargs):
        pytest.fail("unused knowledge permission was treated as a data read")

    monkeypatch.setattr(solution_knowledge, "check_access", unused)
    assert submit(f, task, body).status_code == 202
    assert status(f, task, body["request_id"]).status_code == 200
    assert active(f, task).status_code == 200
    assert f.calls == []


def test_unexpected_model_errors_are_scrubbed_in_durable_status(assistant_client, monkeypatch):
    from app.services import ai, assistant_requests

    f = assistant_client
    task = test_assistant.create(f)
    body = payload(task, context="OWNED-QUESTION-CONTEXT")
    job_id, token = claimed(f, task, body)

    def broken_model(*_args, **_kwargs):
        raise RuntimeError("SECRET-KEY SECRET-ENDPOINT SECRET-MODEL-BODY")

    monkeypatch.setattr(ai, "chat", broken_model)
    assistant_requests.execute(job_id, token, factory=factory_for(f), streaming=False)
    failed = status(f, task, body["request_id"])
    assert failed.status_code == 200
    data = failed.json()
    assert data["status"] == "failed" and data["partial_content"] == ""
    assert len(data["diagnostic_id"]) == 32
    assert "SECRET" not in failed.text and "Traceback" not in failed.text
    assert data["question"] == body["question"] and data["context"] == body["context"]
    assert f.db.get(AssistantTask, task["id"]).active_request_id is None
    assert f.client.get(f"{PREFIX}/{task['id']}").json()["messages"] == []


def test_project_partial_is_not_returned_after_membership_revocation(monkeypatch, assistant_client):
    from datetime import date

    from sqlalchemy import delete

    from app.core.config import settings
    from app.models import IAMIdentity, Project, ProjectMember, User
    from app.services import accounts, assistant_requests

    f = assistant_client
    for subject in ("author", "owner"):
        f.db.add(
            User(
                id=subject,
                username=subject,
                display_name=subject,
                email=subject + "@example.test",
                role="rd",
                is_active=True,
            )
        )
    f.db.flush()
    f.db.add(IAMIdentity(issuer=settings.casdoor_issuer, subject="author", user_id="author"))
    f.db.add(
        Project(
            id="private-project",
            code="PRIVATE-PROJECT",
            name="授权项目",
            owner_id="owner",
            product_type="抗体",
            current_stage="研究",
            target_stage="验证",
            status="活跃",
            health="绿",
            progress=0,
            planned_start=date(2026, 1, 1),
            planned_end=date(2026, 12, 31),
        )
    )
    f.db.flush()
    f.db.add(ProjectMember(project_id="private-project", user_id="author"))
    f.db.commit()
    monkeypatch.setattr(accounts, "live_roles", lambda _subject: set())
    task = test_assistant.create(f)
    body = payload(task, question="目前有哪些项目？", answer_mode="auto", data_sources=["projects"])
    job_id, token = claimed(f, task, body)
    context_token = assistant_requests.CURRENT.set(
        assistant_requests.Execution(job_id, token, factory_for(f))
    )
    try:
        assistant_requests.progress(
            application_scope={
                "version": 1,
                "used_sources": ["projects"],
                "project_ids": ["private-project"],
                "visible_count": 1,
            },
            stage="generating",
            partial_content="PRIVATE-PROJECT-PARTIAL",
        )
    finally:
        assistant_requests.CURRENT.reset(context_token)
    permitted = status(f, task, body["request_id"])
    assert (
        permitted.status_code == 200
        and permitted.json()["partial_content"] == "PRIVATE-PROJECT-PARTIAL"
    )
    f.db.execute(delete(ProjectMember).where(ProjectMember.user_id == "author"))
    f.db.commit()
    for response in (status(f, task, body["request_id"]), active(f, task)):
        assert response.status_code == 403 and "PRIVATE-PROJECT-PARTIAL" not in response.text
    assert f.calls == []


@pytest.fixture
def isolated_request_sessions(tmp_path):
    """Use real PostgreSQL sessions in CI; local SQLite uses an isolated file."""
    import os

    from sqlalchemy import create_engine, text
    from sqlalchemy.engine import make_url
    from sqlalchemy.orm import sessionmaker

    from app.db.base import Base
    from app.models.assistant import AssistantMessage, AssistantRequest

    database_url = os.environ.get("TEST_DATABASE_URL")
    admin = schema = None
    if database_url and make_url(database_url).get_backend_name() == "postgresql":
        admin = create_engine(database_url)
        schema = "assistant_requests_race_" + uuid4().hex
        with admin.begin() as connection:
            connection.execute(text('CREATE SCHEMA "' + schema + '"'))
        engine = create_engine(database_url, connect_args={"options": "-csearch_path=" + schema})
    else:
        engine = create_engine(
            "sqlite:///" + str(tmp_path / "requests-race.db"),
            connect_args={"check_same_thread": False, "timeout": 10},
        )
    try:
        Base.metadata.create_all(
            engine,
            tables=[
                AssistantTask.__table__,
                AssistantMessage.__table__,
                AssistantRequest.__table__,
            ],
        )
        yield engine, sessionmaker(bind=engine, autoflush=False)
    finally:
        engine.dispose()
        if admin:
            with admin.begin() as connection:
                connection.execute(text('DROP SCHEMA "' + schema + '" CASCADE'))
            admin.dispose()


def race_task(factory):
    from app.core.config import settings

    identifier = uuid4().hex
    with factory() as db:
        db.add(
            AssistantTask(
                id=identifier,
                issuer=settings.casdoor_issuer,
                owner_id="race-owner",
                title="并发验收",
            )
        )
        db.commit()
    return identifier, {
        "iss": settings.casdoor_issuer,
        "sub": "race-owner",
        "owner": settings.CASDOOR_ORG,
    }


def test_two_instances_claim_a_queued_request_only_once(isolated_request_sessions, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    from sqlalchemy import event, func, select

    from app.models.assistant import AssistantMessage, AssistantRequest
    from app.schemas.assistant import TaskQuestion
    from app.services import ai, assistant_requests

    engine, factory = isolated_request_sessions
    task_id, claims = race_task(factory)
    with factory() as db:
        job_id, _, _ = assistant_requests.submit(
            db,
            claims,
            db.get(AssistantTask, task_id),
            TaskQuestion(
                revision=1,
                request_id=uuid4(),
                question="解释细胞培养",
                model_profile_id="enterprise",
                answer_mode="general",
            ),
        )
    barrier = Barrier(2, timeout=5)

    def synchronized_select(_conn, _cursor, statement, _parameters, _context, _many):
        if statement.lstrip().upper().startswith("SELECT ASSISTANT_REQUESTS.ID"):
            barrier.wait()

    event.listen(engine, "after_cursor_execute", synchronized_select)
    try:

        def contender():
            with factory() as db:
                return assistant_requests.claim(db, job_id)

        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [executor.submit(contender) for _ in range(2)]
            results = [future.result(timeout=15) for future in futures]
    finally:
        event.remove(engine, "after_cursor_execute", synchronized_select)
    winners = [result for result in results if result]
    assert len(winners) == 1 and winners[0][0] == job_id
    calls = []
    monkeypatch.setattr(
        ai,
        "load_settings",
        lambda: {"provider": "ollama", "providers": {"ollama": {"model": "isolated-race-test"}}},
    )

    def model(*_args, **_kwargs):
        calls.append(True)
        return "并发领取只应调用一次模型。", {}

    monkeypatch.setattr(ai, "chat", model)
    assistant_requests.execute(*winners[0], factory=factory, streaming=False)
    assistant_requests.execute(*winners[0], factory=factory, streaming=False)
    with factory() as db:
        assert db.get(AssistantRequest, job_id).status == "completed"
        assert db.get(AssistantTask, task_id).active_request_id is None
        assert db.scalar(select(func.count()).select_from(AssistantMessage)) == 2
    assert calls == [True]


def test_concurrent_submissions_cannot_reserve_two_slots_on_one_task(isolated_request_sessions):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    from fastapi import HTTPException
    from sqlalchemy import event, func, select

    from app.models.assistant import AssistantRequest
    from app.schemas.assistant import TaskQuestion
    from app.services import assistant_requests

    engine, factory = isolated_request_sessions
    task_id, claims = race_task(factory)
    barrier = Barrier(2, timeout=5)

    def synchronized_reservation(_conn, _cursor, statement, _parameters, _context, _many):
        if statement.lstrip().upper().startswith("UPDATE ASSISTANT_TASKS SET ACTIVE_REQUEST_ID"):
            barrier.wait()

    event.listen(engine, "before_cursor_execute", synchronized_reservation)
    try:

        def contender():
            with factory() as db:
                try:
                    assistant_requests.submit(
                        db,
                        claims,
                        db.get(AssistantTask, task_id),
                        TaskQuestion(
                            revision=1,
                            request_id=uuid4(),
                            question="解释细胞培养",
                            model_profile_id="enterprise",
                            answer_mode="general",
                        ),
                    )
                    return 202
                except HTTPException as error:
                    return error.status_code

        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [executor.submit(contender) for _ in range(2)]
            results = [future.result(timeout=15) for future in futures]
    finally:
        event.remove(engine, "before_cursor_execute", synchronized_reservation)
    assert sorted(results) == [202, 409]
    with factory() as db:
        assert db.scalar(select(func.count()).select_from(AssistantRequest)) == 1
        job = db.scalar(select(AssistantRequest))
        assert job.status == "queued" and db.get(AssistantTask, task_id).active_request_id == job.id
