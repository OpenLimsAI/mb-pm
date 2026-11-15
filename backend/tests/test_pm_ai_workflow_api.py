"""Independent workflow API, restart and additive-upgrade contract regressions."""

import importlib.util
import json
from collections import Counter
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from uuid import uuid4

import pytest
import sqlalchemy as sa

from alembic.migration import MigrationContext
from alembic.operations import Operations
from app import main as app_main
from app.db.session import SessionLocal
from app.db.session import engine as application_test_engine
from app.models import Task, User
from app.models.pm_ai import PMAIRun
from app.services import ai, pm_ai_runs

VERSIONS = Path(__file__).parents[1] / "alembic" / "versions"
ENDPOINT = "/api/v1/pm-ai/runs"
CONFIG = {"model": "deepseek-v4-pro", "base_url": "https://api.deepseek.com"}


@pytest.fixture(autouse=True)
def isolated_models_and_runs(monkeypatch, live_ai_roles, client):
    monkeypatch.setattr(
        ai, "load_settings", lambda db: {"provider": "deepseek", "providers": {"deepseek": CONFIG}}
    )
    monkeypatch.setattr(ai, "request", lambda *a, **k: pytest.fail("unexpected paid model call"))
    yield
    with SessionLocal.begin() as db:
        db.query(PMAIRun).delete()


def queued(client, headers, project, *, scenario="weekly", material=""):
    response = client.post(
        ENDPOINT,
        headers=headers,
        json={"scenario": scenario, "project_ids": [project], "material": material},
    )
    assert response.status_code == 202, response.text
    return response.json()


def read(client, headers, run_id):
    response = client.get(f"{ENDPOINT}/{run_id}", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def resume(client, headers, run_id):
    response = client.post(f"{ENDPOINT}/{run_id}/resume", headers=headers)
    assert response.status_code == 202, response.text
    return response.json()


def meeting_project(project_factory, count=14, *, note_size=0):
    project = project_factory("t-admin")
    with SessionLocal.begin() as db:
        original = (
            db.query(Task).filter(Task.sub_project_id == f"{project}-sp").order_by(Task.id).all()
        )
        records = list(original)
        for index in range(2, count):
            task = Task(
                id=f"wf-{uuid4().hex[:12]}",
                code=f"WF-{index:02}",
                name=f"会议任务{index:02}",
                sub_project_id=f"{project}-sp",
                owner_id="t-admin",
                status="未开始",
                priority="中",
                planned_start=date(2026, 1, 1),
                planned_end=date(2026, 12, 31),
                progress=0,
            )
            db.add(task)
            records.append(task)
        for index, task in enumerate(records):
            task.name = f"会议任务{index:02}"
            task.notes = "备" * note_size
        db.flush()
        tasks = [(task.id, task.name) for task in records]
    material = "\n".join(f"{name}进度更新为25%，进展说明为已完成资料评审。" for _, name in tasks)
    return project, tasks, material


def install_model(monkeypatch, run_id, *, crash_call=None):
    calls = []

    def respond(provider, config, path, body=None, timeout=25):
        # Reservation must be durable before an external charge can start.
        with SessionLocal() as db:
            workflow = db.get(PMAIRun, run_id).workflow
            entry = workflow["ledger"][-1]
            assert workflow["calls_used"] == len(calls) + 1
            assert entry["reserved_tokens"] > 0
            step = next(step for step in workflow["steps"] if step["id"] == entry["step_id"])
            calls.append(
                {
                    "step_id": step["id"],
                    "kind": step["kind"],
                    "reservation": entry["reserved_tokens"],
                }
            )
        if crash_call == len(calls):
            raise SystemExit("simulated worker exit after durable reservation")
        context = json.loads(body["messages"][-1]["content"])["context"]
        refs = context["source"]["refs"]
        actions = []
        if step["kind"] == "analysis" and context.get("material"):
            mentioned = [task for task in context["tasks"] if task["name"] in context["material"]]
            assert len(mentioned) <= 12, "meeting batches must fit the per-step action limit"
            for task in mentioned:
                task_ref = task.get("evidence_id", f"task:{task['id']}")
                material_ref = next(
                    (
                        ref["id"]
                        for ref in refs
                        if ref["id"].startswith("material:")
                        and task["name"] in ref.get("excerpt", "")
                    ),
                    next(ref["id"] for ref in refs if ref["id"].startswith("material:")),
                )
                actions.append(
                    {
                        "kind": "task_update",
                        "task_id": task["id"],
                        "expected_revision": task["revision"],
                        "progress": 25,
                        "notes": "已完成资料评审",
                        "reason": "会议确认",
                        "evidence_ids": [task_ref, material_ref],
                    }
                )
        result = {
            "summary": "阶段结论已保存，仍需人工核对",
            "findings": [],
            "draft_actions": actions,
        }
        return {
            "choices": [
                {
                    "message": {"content": json.dumps(result, ensure_ascii=False)},
                    "finish_reason": "stop",
                }
            ],
            "usage": {"prompt_tokens": 17, "completion_tokens": 13, "total_tokens": 30},
        }

    monkeypatch.setattr(ai, "request", respond)
    return calls


def finish_workflow(client, headers, run_id, *, max_windows=20):
    for _ in range(max_windows):
        current = read(client, headers, run_id)
        if current["state"] == "succeeded":
            return current
        if current["state"] == "paused":
            assert current["workflow"]["can_resume"], current
            resume(client, headers, run_id)
        assert pm_ai_runs.process_one()
    pytest.fail("bounded workflow did not finish within expected windows")


def test_resume_queued_is_idempotent_and_does_not_create_runs_or_bypass_owner(
    client, auth_headers, project_factory, iam_user, bearer
):
    current = queued(client, auth_headers, project_factory("t-admin"))
    assert current["workflow"] is not None and current["workflow"]["calls_used"] == 0
    first = resume(client, auth_headers, current["id"])
    again = resume(client, auth_headers, current["id"])
    assert first["id"] == again["id"] == current["id"]
    assert again["workflow"] == first["workflow"]
    with SessionLocal() as db:
        assert db.query(PMAIRun).count() == 1
    other = bearer(iam_user("wf-other", "rd"), "rd")
    assert client.post(f"{ENDPOINT}/{current['id']}/resume", headers=other).status_code == 404
    assert client.post(f"{ENDPOINT}/{current['id']}/resume").status_code == 401


def test_paused_checkpoint_does_not_block_new_work_but_resume_cannot_overlap_same_user(
    client, auth_headers, project_factory, monkeypatch
):
    from app.services import pm_ai_workflow

    monkeypatch.setattr(pm_ai_workflow, "WINDOW_CALLS", 1)
    project, _, material = meeting_project(project_factory)
    current = queued(client, auth_headers, project, scenario="meeting", material=material)
    calls = install_model(monkeypatch, current["id"])
    assert pm_ai_runs.process_one()
    paused = read(client, auth_headers, current["id"])
    assert paused["state"] == "paused" and len(calls) == 1
    another = queued(client, auth_headers, project, scenario="explain")
    rejected = client.post(f"{ENDPOINT}/{current['id']}/resume", headers=auth_headers)
    assert rejected.status_code == 409
    assert read(client, auth_headers, current["id"])["workflow"] == paused["workflow"]
    client.post(f"{ENDPOINT}/{another['id']}/cancel", headers=auth_headers)
    resumed = resume(client, auth_headers, current["id"])
    duplicate = resume(client, auth_headers, current["id"])
    assert resumed["workflow"] == duplicate["workflow"]


def test_meeting_batches_keep_every_action_and_original_reference_without_writing_tasks(
    client, auth_headers, project_factory, monkeypatch
):
    project, task_rows, material = meeting_project(project_factory)
    current = queued(client, auth_headers, project, scenario="meeting", material=material)
    calls = install_model(monkeypatch, current["id"])
    final = finish_workflow(client, auth_headers, current["id"])
    assert len(calls) >= 2
    actions = final["result"]["draft_actions"]
    assert Counter(action["task_id"] for action in actions) == Counter(
        task_id for task_id, _ in task_rows
    )
    original_refs = {ref["id"] for ref in current["source"]["refs"]}
    assert all(set(action["evidence_ids"]) <= original_refs for action in actions)
    assert all(
        action["progress"] == 25 and action["notes"] == "已完成资料评审" for action in actions
    )
    assert not final["stale"]
    preview = client.post(
        f"{ENDPOINT}/{current['id']}/changes/preview",
        headers=auth_headers,
        json={"actions": actions[:12]},
    )
    assert preview.status_code == 200, preview.text
    with SessionLocal() as db:
        assert all(db.get(Task, task_id).progress == 0 for task_id, _ in task_rows)
        assert all(db.get(Task, task_id).notes != "已完成资料评审" for task_id, _ in task_rows)


def test_restart_keeps_completed_steps_and_unknown_charge_reservations(
    client, auth_headers, project_factory, monkeypatch
):
    from app.services import pm_ai_workflow

    monkeypatch.setattr(pm_ai_workflow, "WINDOW_CALLS", 1)
    project, _, material = meeting_project(project_factory)
    current = queued(client, auth_headers, project, scenario="meeting", material=material)
    calls = install_model(monkeypatch, current["id"], crash_call=2)
    assert pm_ai_runs.process_one()
    paused = read(client, auth_headers, current["id"])
    assert paused["state"] == "paused" and paused["workflow"]["completed_steps"] >= 1
    first_step = calls[0]["step_id"]
    resume(client, auth_headers, current["id"])
    with pytest.raises(SystemExit, match="simulated worker exit"):
        pm_ai_runs.process_one()
    with SessionLocal.begin() as db:
        row = db.get(PMAIRun, current["id"])
        reserved_budget = row.workflow["token_budget_used"]
        assert row.workflow["calls_used"] == 2
        assert row.workflow["ledger"][-1]["reserved_tokens"] > 0
        row.started_at = datetime.now(UTC) - timedelta(minutes=16)
    pm_ai_runs.process_one()
    interrupted = read(client, auth_headers, current["id"])
    assert interrupted["state"] == "paused"
    assert interrupted["workflow"]["pause_reason"] == "process_interrupted"
    assert interrupted["workflow"]["calls_used"] == 2
    assert interrupted["workflow"]["token_budget_used"] >= reserved_budget
    final = finish_workflow(client, auth_headers, current["id"])
    assert final["state"] == "succeeded"
    assert sum(call["step_id"] == first_step for call in calls) == 1
    assert final["workflow"]["calls_used"] == len(calls)


@pytest.mark.parametrize("change", ["task", "model"])
def test_resume_rejects_changed_snapshot_or_model_without_mixing_checkpoints(
    client, auth_headers, project_factory, monkeypatch, change
):
    from app.services import pm_ai_workflow

    monkeypatch.setattr(pm_ai_workflow, "WINDOW_CALLS", 1)
    project, task_rows, material = meeting_project(project_factory)
    current = queued(client, auth_headers, project, scenario="meeting", material=material)
    calls = install_model(monkeypatch, current["id"])
    assert pm_ai_runs.process_one()
    paused = read(client, auth_headers, current["id"])
    assert paused["state"] == "paused"
    if change == "task":
        with SessionLocal.begin() as db:
            db.get(Task, task_rows[0][0]).notes = "暂停后新增的真实变化"
    else:
        monkeypatch.setattr(
            ai,
            "load_settings",
            lambda db: {
                "provider": "deepseek",
                "providers": {"deepseek": {**CONFIG, "model": "changed-model"}},
            },
        )
    response = client.post(f"{ENDPOINT}/{current['id']}/resume", headers=auth_headers)
    assert response.status_code == 409, response.text
    after = read(client, auth_headers, current["id"])
    assert (
        after["result"] is None
        and after["workflow"]["completed_steps"] == paused["workflow"]["completed_steps"]
    )
    assert len(calls) == 1


def test_resume_rechecks_live_permissions_before_any_additional_charge(
    client, auth_headers, project_factory, monkeypatch
):
    from app.services import pm_ai_workflow

    monkeypatch.setattr(pm_ai_workflow, "WINDOW_CALLS", 1)
    project, _, material = meeting_project(project_factory)
    current = queued(client, auth_headers, project, scenario="meeting", material=material)
    calls = install_model(monkeypatch, current["id"])
    assert pm_ai_runs.process_one()
    with SessionLocal.begin() as db:
        db.get(User, "t-admin").is_active = False
    try:
        assert (
            client.post(f"{ENDPOINT}/{current['id']}/resume", headers=auth_headers).status_code
            == 403
        )
        assert len(calls) == 1
    finally:
        with SessionLocal.begin() as db:
            db.get(User, "t-admin").is_active = True


@pytest.mark.parametrize(
    "limit,value,reason", [("JOB_CALLS", 1, "job_call_limit"), ("JOB_TOKENS", 1, "job_token_limit")]
)
def test_hard_job_budget_cannot_be_reset_by_repeated_resume(
    client, auth_headers, project_factory, monkeypatch, limit, value, reason
):
    from app.services import pm_ai_workflow

    monkeypatch.setattr(pm_ai_workflow, limit, value)
    project, _, material = meeting_project(project_factory)
    current = queued(client, auth_headers, project, scenario="meeting", material=material)
    calls = install_model(monkeypatch, current["id"])
    assert pm_ai_runs.process_one()
    paused = read(client, auth_headers, current["id"])
    assert paused["state"] == "paused" and paused["workflow"]["pause_reason"] == reason
    assert not paused["workflow"]["can_resume"]
    cancelled = client.post(f"{ENDPOINT}/{current['id']}/cancel", headers=auth_headers).json()
    assert cancelled["workflow"] == paused["workflow"]
    for _ in range(2):
        assert (
            client.post(f"{ENDPOINT}/{current['id']}/resume", headers=auth_headers).status_code
            == 409
        )
    after = read(client, auth_headers, current["id"])
    assert after["workflow"] == paused["workflow"]
    assert len(calls) == (1 if limit == "JOB_CALLS" else 0)


def test_expanded_context_resume_and_stale_check_use_the_original_workflow_mode(
    client, auth_headers, project_factory, monkeypatch
):
    from app.services import pm_ai_workflow

    project, task_rows, material = meeting_project(project_factory, count=24, note_size=5000)
    # Over the legacy 200-line evidence cap, but below the workflow's explicit
    # input/material limits. Extra lines carry no task mutation instructions.
    material += "\n" + "\n".join(f"其他讨论第{index}行，无新增决定。" for index in range(205))
    current = queued(client, auth_headers, project, scenario="meeting", material=material)
    with SessionLocal() as db:
        snapshot = db.get(PMAIRun, current["id"]).context
        assert len(json.dumps(snapshot, ensure_ascii=False)) > 120000
        assert any(ref["id"] == "material:229" for ref in snapshot["source"]["refs"])
    monkeypatch.setattr(pm_ai_workflow, "WINDOW_CALLS", 1)
    calls = install_model(monkeypatch, current["id"])
    assert pm_ai_runs.process_one()
    paused = read(client, auth_headers, current["id"])
    assert paused["state"] == "paused"
    resumed = resume(client, auth_headers, current["id"])
    assert resumed["state"] == "queued"
    # Restore the normal call window for finishing this isolated synthetic run.
    monkeypatch.setattr(pm_ai_workflow, "WINDOW_CALLS", 12)
    final = finish_workflow(client, auth_headers, current["id"])
    assert not final["stale"]
    assert len(final["result"]["draft_actions"]) == len(task_rows)
    assert final["workflow"]["calls_used"] == len(calls)


def test_conflicting_meeting_updates_preserve_checkpoints_and_never_choose_a_value(
    client, auth_headers, project_factory, monkeypatch
):
    project = project_factory("t-admin")
    with SessionLocal() as db:
        task = db.get(Task, f"{project}-t1")
        task_id, task_name, revision = task.id, task.name, task.revision
    material = f"{task_name}进度更新为25%。\n{task_name}进度更新为35%。"
    current = queued(client, auth_headers, project, scenario="meeting", material=material)
    actions = [
        {
            "kind": "task_update",
            "task_id": task_id,
            "expected_revision": revision,
            "progress": progress,
            "reason": "会议存在两个不同进度",
            "evidence_ids": [f"task:{task_id}", f"material:{index}"],
        }
        for index, progress in [(1, 25), (2, 35)]
    ]
    result = {"summary": "同一任务存在互相冲突的进度记录", "findings": [], "draft_actions": actions}
    calls = []

    def response(*args, **kwargs):
        calls.append(True)
        return {"choices": [{"message": {"content": json.dumps(result)}, "finish_reason": "stop"}]}

    monkeypatch.setattr(ai, "request", response)
    assert pm_ai_runs.process_one()
    paused = read(client, auth_headers, current["id"])
    assert paused["state"] == "paused" and paused["result"] is None
    assert paused["workflow"]["pause_reason"] == "action_conflict"
    assert not paused["workflow"]["can_resume"]
    assert (
        client.post(f"{ENDPOINT}/{current['id']}/resume", headers=auth_headers).status_code == 409
    )
    with SessionLocal() as db:
        row = db.get(PMAIRun, current["id"])
        saved = [step["result"] for step in row.workflow["steps"] if step["state"] == "completed"]
        assert saved[0]["draft_actions"] == actions
        assert db.get(Task, task_id).progress == 0
    assert len(calls) == 1


def test_workflow_pause_preserves_progress_and_is_idempotent_but_legacy_cancel_stays_terminal(
    client, auth_headers, project_factory, monkeypatch
):
    from app.services import pm_ai_workflow

    monkeypatch.setattr(pm_ai_workflow, "WINDOW_CALLS", 1)
    project, _, material = meeting_project(project_factory)
    current = queued(client, auth_headers, project, scenario="meeting", material=material)
    calls = install_model(monkeypatch, current["id"])
    assert pm_ai_runs.process_one()
    original = read(client, auth_headers, current["id"])
    resume(client, auth_headers, current["id"])
    paused = client.post(f"{ENDPOINT}/{current['id']}/cancel", headers=auth_headers).json()
    repeated = client.post(f"{ENDPOINT}/{current['id']}/cancel", headers=auth_headers).json()
    assert paused["state"] == repeated["state"] == "paused"
    assert paused["workflow"]["pause_reason"] == "user_stopped"
    assert paused["workflow"]["can_resume"]
    assert repeated["workflow"] == paused["workflow"]
    assert paused["workflow"]["completed_steps"] == original["workflow"]["completed_steps"]
    first_step = calls[0]["step_id"]
    assert finish_workflow(client, auth_headers, current["id"])["state"] == "succeeded"
    assert sum(call["step_id"] == first_step for call in calls) == 1

    legacy = queued(client, auth_headers, project, scenario="weekly")
    with SessionLocal.begin() as db:
        db.get(PMAIRun, legacy["id"]).workflow = None
    stopped = client.post(f"{ENDPOINT}/{legacy['id']}/cancel", headers=auth_headers).json()
    assert stopped["state"] == "cancelled" and stopped["workflow"] is None
    assert client.post(f"{ENDPOINT}/{legacy['id']}/resume", headers=auth_headers).status_code == 409


def test_unvalidated_stage_is_not_saved_or_used_as_derived_evidence(
    client, auth_headers, project_factory, monkeypatch
):
    project, _, material = meeting_project(project_factory)
    current = queued(client, auth_headers, project, scenario="meeting", material=material)
    calls = install_model(monkeypatch, current["id"])
    grounded_response = ai.request

    def invalid_second_stage(*args, **kwargs):
        response = grounded_response(*args, **kwargs)
        if len(calls) == 2:
            response["choices"][0]["message"]["content"] = json.dumps(
                {
                    "summary": "UNVALIDATED_STAGE_MUST_NOT_BE_SAVED",
                    "findings": [
                        {
                            "title": "伪造结论",
                            "detail": "不能作为后续证据",
                            "evidence_ids": ["derived:invented"],
                        }
                    ],
                    "draft_actions": [],
                }
            )
        return response

    monkeypatch.setattr(ai, "request", invalid_second_stage)
    assert pm_ai_runs.process_one()
    paused = read(client, auth_headers, current["id"])
    assert paused["state"] == "paused" and paused["result"] is None
    assert paused["workflow"]["completed_steps"] == 1
    assert len(calls) == 2
    assert "UNVALIDATED_STAGE" not in json.dumps(paused)
    with SessionLocal() as db:
        assert "UNVALIDATED_STAGE" not in json.dumps(db.get(PMAIRun, current["id"]).workflow)


def migration(number, connection):
    filename = next(VERSIONS.glob(f"*-{number}_*.py"))
    spec = importlib.util.spec_from_file_location(f"workflow_api_migration_{number}", filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.op = Operations(MigrationContext.configure(connection))
    return module


@pytest.fixture
def legacy_engine(tmp_path):
    engine = sa.create_engine(f"sqlite:///{tmp_path / 'workflow-upgrade.db'}")
    with engine.begin() as connection:
        connection.execute(sa.text("CREATE TABLE users (id VARCHAR(20) PRIMARY KEY)"))
        connection.execute(sa.text("INSERT INTO users VALUES ('legacy-owner')"))
        migration("028", connection).upgrade()
        table = sa.Table("pm_ai_runs", sa.MetaData(), autoload_with=connection)
        connection.execute(
            table.insert().values(
                id="legacy-workflow-run",
                created_by="legacy-owner",
                created_at=datetime.now(UTC),
                state="succeeded",
                request={"scenario": "weekly", "project_ids": ["preserved-project"]},
                context={"scope": {"project_ids": ["preserved-project"]}, "legacy": True},
                source={"refs": [{"id": "project:preserved-project"}]},
                result={"summary": "原历史周报", "findings": [], "draft_actions": []},
                usage={"completion_tokens": 42},
                error="",
            )
        )
    yield engine
    engine.dispose()


def test_workflow_migration_is_additive_idempotent_and_rollback_keeps_old_evidence(legacy_engine):
    with legacy_engine.begin() as connection:
        old_columns = {
            column["name"] for column in sa.inspect(connection).get_columns("pm_ai_runs")
        }
        upgrade = migration("031", connection)
        assert upgrade.down_revision == "030"
        upgrade.upgrade()
        upgrade.upgrade()
        columns = {
            column["name"]: column for column in sa.inspect(connection).get_columns("pm_ai_runs")
        }
        assert set(columns) == old_columns | {"workflow"}
        assert columns["workflow"]["nullable"]
        table = sa.Table("pm_ai_runs", sa.MetaData(), autoload_with=connection)
        row = connection.execute(sa.select(table)).mappings().one()
        assert row["workflow"] is None
        assert row["result"]["summary"] == "原历史周报"
        assert row["context"]["legacy"] is True
        assert row["usage"] == {"completion_tokens": 42}
        checkpoint = {"version": 1, "steps": [{"id": "saved-step", "state": "succeeded"}]}
        connection.execute(table.update().values(workflow=checkpoint))
        upgrade.upgrade()
        upgrade.downgrade()
        assert connection.execute(sa.select(table.c.workflow)).scalar_one() == checkpoint
        old_projection = connection.execute(
            sa.select(table.c.state, table.c.result, table.c.source, table.c.context)
        ).one()
        assert old_projection.state == "succeeded"
        assert old_projection.result["summary"] == "原历史周报"
        assert old_projection.source["refs"] == [{"id": "project:preserved-project"}]


@pytest.mark.skipif(
    application_test_engine.dialect.name != "postgresql",
    reason="Runs against the real isolated PostgreSQL service supplied by CI",
)
def test_postgres_additive_upgrade_keeps_old_json_ledger_and_old_application_projection(
    monkeypatch,
):
    schema = f"wf_upgrade_{uuid4().hex[:16]}"
    with application_test_engine.begin() as connection:
        connection.execute(sa.text(f'CREATE SCHEMA "{schema}"'))
    scoped_engine = sa.create_engine(
        application_test_engine.url,
        connect_args={"options": f"-csearch_path={schema}"},
    )
    old_context = {"scope": {"project_ids": ["synthetic-project"]}, "evidence": "保留原快照"}
    old_result = {"summary": "原有周报", "findings": [], "draft_actions": []}
    try:
        with scoped_engine.begin() as connection:
            connection.execute(
                sa.text("CREATE TABLE alembic_version (version_num VARCHAR(32) PRIMARY KEY)")
            )
            connection.execute(sa.text("INSERT INTO alembic_version VALUES ('019')"))
            connection.execute(
                sa.text("""
                CREATE TABLE pm_ai_runs (
                    id VARCHAR(40) PRIMARY KEY, created_by VARCHAR(20) NOT NULL,
                    created_at TIMESTAMP WITH TIME ZONE NOT NULL,
                    started_at TIMESTAMP WITH TIME ZONE, finished_at TIMESTAMP WITH TIME ZONE,
                    state VARCHAR(16) NOT NULL,
                    request JSON NOT NULL, context JSON NOT NULL, source JSON NOT NULL,
                    result JSON, provider VARCHAR(20), model VARCHAR(160),
                    usage JSON NOT NULL, error TEXT NOT NULL, claim VARCHAR(40)
                )
            """)
            )
            connection.execute(
                sa.text("""
                INSERT INTO pm_ai_runs (id,created_by,created_at,state,request,context,source,result,usage,error)
                VALUES ('preserved-run','legacy-owner',:created_at,'succeeded',CAST(:request AS JSON),CAST(:context AS JSON),
                        CAST(:source AS JSON),CAST(:result AS JSON),CAST(:usage AS JSON),'')
            """),
                {
                    "request": "{}",
                    "context": json.dumps(old_context),
                    "source": '{"refs":[]}',
                    "result": json.dumps(old_result),
                    "usage": '{"total_tokens":42}',
                    "created_at": datetime.now(UTC),
                },
            )
        monkeypatch.setattr(app_main, "engine", scoped_engine)
        app_main._ensure_schema()
        app_main._ensure_schema()
        with scoped_engine.begin() as connection:
            upgrade = migration("031", connection)
            upgrade.upgrade()
            upgrade.upgrade()
            columns = {
                item["name"]: item for item in sa.inspect(connection).get_columns("pm_ai_runs")
            }
            assert columns["workflow"]["nullable"]
            assert isinstance(columns["workflow"]["type"], sa.JSON)
            row = (
                connection.execute(
                    sa.text("SELECT state,context,result,usage,workflow FROM pm_ai_runs")
                )
                .mappings()
                .one()
            )
            assert row["workflow"] is None
            assert row["context"] == old_context and row["result"] == old_result
            assert row["usage"] == {"total_tokens": 42}
            assert (
                connection.execute(sa.text("SELECT version_num FROM alembic_version")).scalar_one()
                == "019"
            )
            connection.execute(
                sa.text("UPDATE pm_ai_runs SET workflow = CAST(:workflow AS JSON)"),
                {"workflow": json.dumps({"version": 1, "checkpoint": "保留"})},
            )
            upgrade.upgrade()
            upgrade.downgrade()
            assert (
                connection.execute(sa.text("SELECT workflow FROM pm_ai_runs")).scalar_one()[
                    "checkpoint"
                ]
                == "保留"
            )
            assert (
                connection.execute(
                    sa.text("SELECT result FROM pm_ai_runs WHERE state='succeeded'")
                ).scalar_one()
                == old_result
            )
    finally:
        scoped_engine.dispose()
        with application_test_engine.begin() as connection:
            connection.execute(sa.text(f'DROP SCHEMA "{schema}" CASCADE'))


def test_schema_fallback_adds_nullable_workflow_without_touching_old_rows(
    legacy_engine, monkeypatch
):
    assert ("pm_ai_runs", "workflow", "JSON") in app_main._ADDED_COLUMNS
    monkeypatch.setattr(app_main, "engine", legacy_engine)
    app_main._ensure_schema()
    app_main._ensure_schema()
    with legacy_engine.connect() as connection:
        table = sa.Table("pm_ai_runs", sa.MetaData(), autoload_with=connection)
        row = connection.execute(sa.select(table)).mappings().one()
        assert row["workflow"] is None
        assert row["result"] == {"summary": "原历史周报", "findings": [], "draft_actions": []}
        assert row["usage"] == {"completion_tokens": 42}
