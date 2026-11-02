"""Personal PM source boundaries with synthetic IAM and isolated application data."""

import json
from datetime import date
from uuid import uuid4

import pytest
import test_assistant
import test_solutions
from fastapi import HTTPException
from sqlalchemy import delete, func, select, text, update

from app.core.config import settings
from app.models import IAMIdentity, Project, ProjectMember, SubProject, Task, User
from app.models.assistant import AssistantMessage, AssistantTask
from app.services import (
    accounts,
    ai,
    assistant_projects,
    assistant_tool_chat,
    rollup,
    solution_knowledge,
)

solution_client = test_solutions.solution_client
assistant_client = test_assistant.assistant_client
PREFIX = test_assistant.PREFIX


def unavailable(*_args, **_kwargs):
    pytest.fail("unselected application dependency was called")


@pytest.fixture
def pm(assistant_client, monkeypatch):
    f = assistant_client
    for identifier, name in (("pm-author", "author"), ("pm-other", "other")):
        f.db.add(
            User(
                id=identifier,
                username=name,
                display_name=name.upper(),
                email=name + "@example.test",
                role="admin",
                is_active=True,
            )
        )
    f.db.flush()
    f.db.add(IAMIdentity(issuer=settings.casdoor_issuer, subject="author", user_id="pm-author"))
    f.db.commit()
    f.roles = set()
    monkeypatch.setattr(accounts, "live_roles", lambda subject: set(f.roles))
    return f


def project(f, number=1, *, member=True, name=None):
    identifier = f"project-{number:03}"
    row = Project(
        id=identifier,
        code=f"P{number:03}",
        name=name or f"VISIBLE-{number:03}",
        product_type="抗体",
        current_stage="研究",
        target_stage="验证",
        owner_id="pm-other",
        status="活跃",
        health="绿",
        progress=23,
        planned_start=date(2026, 1, 1),
        planned_end=date(2026, 12, 31),
        description="PRIVATE-DESCRIPTION-DO-NOT-SEND",
    )
    f.db.add(row)
    f.db.flush()
    if member:
        f.db.add(ProjectMember(project_id=identifier, user_id="pm-author"))
    f.db.commit()
    return identifier


def ask(f, task, **changes):
    return test_assistant.question(
        f,
        task,
        question="目前有哪些项目？",
        context="",
        data_sources=["projects"],
        answer_mode="auto",
        **changes,
    )


def evidence(f):
    return json.loads(f.calls[-1]["messages"][-1]["content"])["application_data"]


def stored_scope(f):
    return f.db.scalar(
        select(AssistantMessage).where(AssistantMessage.role == "assistant")
    ).application_scope


def no_knowledge(monkeypatch):
    monkeypatch.setattr(solution_knowledge, "paper_count", unavailable)
    monkeypatch.setattr(solution_knowledge, "check_access", unavailable)
    monkeypatch.setattr(assistant_tool_chat, "chat", unavailable)


def test_project_question_without_selected_source_never_reads_or_searches(
    assistant_client, monkeypatch
):
    f = assistant_client
    task = test_assistant.create(f)
    monkeypatch.setattr(assistant_projects, "access", unavailable)
    from app.services import web_search

    monkeypatch.setattr(web_search, "answer", unavailable)
    response = test_assistant.question(
        f,
        task,
        question="当前项目有哪些最新进展？",
        context="",
        answer_mode="auto",
        data_sources=[],
    )
    assert response.status_code == 422 and "勾选项目管理" in response.json()["detail"]
    assert f.calls == []


def test_project_permission_is_not_an_instruction_to_read_data(assistant_client, monkeypatch):
    f = assistant_client
    task = test_assistant.create(f)
    monkeypatch.setattr(assistant_projects, "access", unavailable)
    no_knowledge(monkeypatch)
    response = test_assistant.question(
        f,
        task,
        question="解释一下抗体是什么",
        context="",
        answer_mode="auto",
        data_sources=["projects", "knowledge"],
    )
    assert response.status_code == 200, response.text
    assert evidence(f) == {}
    assert response.json()["messages"][-1]["answer_mode"] == "general"
    assert stored_scope(f)["used_sources"] == []


def test_project_only_uses_fresh_role_scope_without_touching_knowledge(pm, monkeypatch):
    f = pm
    project(f, 1, name="VISIBLE-PROJECT")
    project(f, 2, member=False, name="HIDDEN-PROJECT")
    task = test_assistant.create(f)
    no_knowledge(monkeypatch)
    response = ask(f, task)
    assert response.status_code == 200, response.text
    data = evidence(f)["projects"]
    assert data["total"] == data["returned"] == 1 and not data["truncated"]
    assert data["items"][0] == {
        "code": "P001",
        "name": "VISIBLE-PROJECT",
        "status": "活跃",
        "owner": "OTHER",
        "owned_by_current_user": False,
        "progress": 23,
        "planned_start": "2026-01-01",
        "planned_end": "2026-12-31",
    }
    prompt = json.dumps(f.calls[-1]["messages"], ensure_ascii=False)
    assert "HIDDEN-PROJECT" not in prompt and "PRIVATE-DESCRIPTION" not in prompt
    assert response.json()["messages"][-1]["answer_mode"] == "application"
    assert response.json()["messages"][-1]["used_sources"] == ["projects"]
    assert "application_scope" not in response.json()["messages"][-1]
    # Login-time admin is stale: live role set is empty, so ordinary employee
    # scope applies, and the derived role never overwrites the stored profile.
    assert f.db.execute(text("SELECT role FROM users WHERE id='pm-author'")).scalar() == "admin"


def test_two_permitted_sources_use_only_pm_for_a_pm_question(pm, monkeypatch):
    f = pm
    project(f)
    task = test_assistant.create(f)
    no_knowledge(monkeypatch)
    response = test_assistant.question(
        f,
        task,
        question="查询项目列表",
        context="",
        data_sources=["knowledge", "projects"],
        answer_mode="auto",
    )
    assert response.status_code == 200, response.text
    assert set(evidence(f)) == {"projects"}
    assert stored_scope(f)["used_sources"] == ["projects"]


def test_joint_question_is_the_only_pm_path_that_enables_kb_tools(pm, monkeypatch):
    f = pm
    project(f)
    task = test_assistant.create(f)
    counts, tools, checks = [], [], []
    monkeypatch.setattr(
        solution_knowledge, "paper_count", lambda claims: counts.append(claims) or 7
    )
    monkeypatch.setattr(solution_knowledge, "check_access", lambda claims: checks.append(claims))

    def tool_chat(provider, cfg, messages, claims, **kwargs):
        assert not f.db.in_transaction()
        data = json.loads(messages[-1]["content"])["application_data"]
        assert data["knowledge"]["active_paper_count"] == 7
        assert data["projects"]["returned"] == 1
        tools.append(data)
        return "依据本轮项目目录和知识库资料整理。"

    monkeypatch.setattr(assistant_tool_chat, "chat", tool_chat)
    response = test_assistant.question(
        f,
        task,
        question="结合项目管理系统的项目状态与知识库资料回答",
        context="",
        data_sources=["projects", "knowledge"],
        answer_mode="auto",
    )
    assert response.status_code == 200, response.text
    assert len(counts) == len(tools) == 1 and len(checks) >= 2
    assert stored_scope(f)["used_sources"] == ["projects", "knowledge"]
    assert f.calls == []


def test_explicit_knowledge_mode_does_not_read_permitted_pm_data(assistant_client, monkeypatch):
    f = assistant_client
    task = test_assistant.create(f)
    monkeypatch.setattr(assistant_projects, "access", unavailable)
    monkeypatch.setattr(solution_knowledge, "paper_count", lambda claims: 7)

    def tool_chat(provider, cfg, messages, claims, **kwargs):
        assert set(json.loads(messages[-1]["content"])["application_data"]) == {"knowledge"}
        return "仅依据知识库资料回答。"

    monkeypatch.setattr(assistant_tool_chat, "chat", tool_chat)
    response = test_assistant.question(
        f,
        task,
        question="项目管理有哪些研究方法",
        context="",
        data_sources=["projects", "knowledge"],
        answer_mode="knowledge",
    )
    assert response.status_code == 200, response.text
    assert response.json()["messages"][-1]["answer_mode"] == "knowledge"
    assert stored_scope(f)["used_sources"] == ["knowledge"]


def test_joint_knowledge_revocation_before_save_and_after_save_is_rechecked(pm, monkeypatch):
    f = pm
    project(f)
    task = test_assistant.create(f)
    blocked = []
    monkeypatch.setattr(solution_knowledge, "paper_count", lambda claims: 7)

    def check(claims):
        if blocked:
            raise HTTPException(403, "知识库权限已撤销")

    monkeypatch.setattr(solution_knowledge, "check_access", check)

    def tool_chat(*args, **kwargs):
        blocked.append(True)
        return "联合应用回答。"

    monkeypatch.setattr(assistant_tool_chat, "chat", tool_chat)
    payload = {
        "question": "结合项目管理系统和知识库资料回答",
        "context": "",
        "data_sources": ["projects", "knowledge"],
        "answer_mode": "auto",
    }
    denied = test_assistant.question(f, task, **payload)
    assert denied.status_code == 403
    assert f.db.scalar(select(func.count()).select_from(AssistantMessage)) == 0
    f.db.rollback()
    blocked.clear()
    monkeypatch.setattr(assistant_tool_chat, "chat", lambda *args, **kwargs: "联合应用回答。")
    request_id = str(uuid4())
    accepted = test_assistant.question(f, task, request_id=request_id, **payload)
    assert accepted.status_code == 200, accepted.text
    blocked.append(True)
    assert f.client.get(f"{PREFIX}/{task['id']}").status_code == 403
    assert test_assistant.question(f, task, request_id=request_id, **payload).status_code == 403


@pytest.mark.parametrize("change", ["membership", "inactive", "iam-disabled"])
def test_access_revoked_while_model_runs_does_not_save_a_pair(pm, monkeypatch, change):
    f = pm
    project(f)
    task = test_assistant.create(f)
    roles = accounts.live_roles
    disabled = []

    def live(subject):
        if disabled:
            raise HTTPException(403, "IAM 账号已停用")
        return roles(subject)

    monkeypatch.setattr(accounts, "live_roles", live)

    def chat(*args, **kwargs):
        assert not f.db.in_transaction()
        if change == "membership":
            f.db.execute(delete(ProjectMember).where(ProjectMember.user_id == "pm-author"))
            f.db.commit()
        elif change == "inactive":
            f.db.execute(update(User).where(User.id == "pm-author").values(is_active=False))
            f.db.commit()
        else:
            disabled.append(True)
        return "SHOULD-NOT-BE-SAVED", {}

    monkeypatch.setattr(ai, "chat", chat)
    response = ask(f, task)
    assert response.status_code == 403, response.text
    assert f.db.scalar(select(func.count()).select_from(AssistantMessage)) == 0


def test_detail_artifacts_and_completed_request_cannot_replay_revoked_projects(pm):
    f = pm
    project(f)
    task = test_assistant.create(f)
    request_id = str(uuid4())
    response = ask(f, task, request_id=request_id)
    assert response.status_code == 200, response.text
    assert response.json()["artifacts"]
    unchanged = ask(f, task, request_id=request_id)
    assert unchanged.status_code == 200 and len(f.calls) == 1
    f.db.execute(delete(ProjectMember).where(ProjectMember.user_id == "pm-author"))
    f.db.commit()
    assert f.client.get(f"{PREFIX}/{task['id']}").status_code == 403
    replay = ask(f, task, request_id=request_id)
    assert replay.status_code == 403 and "SHOULD" not in replay.text
    assert len(f.calls) == 1


def test_known_revoked_history_blocks_save_but_allows_owner_soft_delete(pm):
    f = pm
    identifier = project(f)
    task = test_assistant.create(f)
    saved = ask(f, task).json()
    f.db.execute(delete(ProjectMember).where(ProjectMember.project_id == identifier))
    f.db.commit()
    response = f.client.put(
        f"{PREFIX}/{task['id']}",
        json={"revision": saved["revision"], "title": "SHOULD-NOT-CHANGE", "instructions": ""},
    )
    assert response.status_code == 403
    removed = f.client.post(f"{PREFIX}/{task['id']}/trash", json={"revision": saved["revision"]})
    assert removed.status_code == 200
    assert "messages" not in removed.json() and "artifacts" not in removed.json()
    f.db.expire_all()
    stored = f.db.get(AssistantTask, task["id"])
    assert stored.title == task["title"] and stored.revision == saved["revision"] + 1
    assert stored.deleted_at is not None
    restored = f.client.post(f"{PREFIX}/{task['id']}/restore", json={"revision": stored.revision})
    assert restored.status_code == 200 and "messages" not in restored.json()
    assert f.client.get(f"{PREFIX}/{task['id']}").status_code == 403


def test_legacy_project_history_without_lineage_is_not_returned(pm):
    f = pm
    task = test_assistant.create(f)
    request_id = str(uuid4())
    for position, role in enumerate(("user", "assistant")):
        f.db.add(
            AssistantMessage(
                id=str(uuid4()),
                task_id=task["id"],
                request_id=request_id,
                position=position,
                role=role,
                content="LEGACY-PROJECT-SECRET",
                data_sources='["projects"]',
                application_scope={},
            )
        )
    f.db.commit()
    response = f.client.get(f"{PREFIX}/{task['id']}")
    assert response.status_code == 403 and "LEGACY-PROJECT-SECRET" not in response.text


def test_empty_directory_is_an_authorized_zero_not_missing_kb(pm, monkeypatch):
    f = pm
    task = test_assistant.create(f)
    no_knowledge(monkeypatch)
    response = ask(f, task)
    assert response.status_code == 200, response.text
    data = evidence(f)["projects"]
    assert data["total"] == data["returned"] == 0 and data["items"] == []
    assert not data["truncated"]


def test_bounded_directory_count_lineage_covers_unlisted_projects(pm):
    f = pm
    f.roles = {"admin"}
    for number in range(55):
        project(f, number, member=False)
    task = test_assistant.create(f)
    response = ask(f, task)
    assert response.status_code == 200, response.text
    data = evidence(f)["projects"]
    assert data["total"] == 55 and data["returned"] == 50 and data["truncated"]
    assert len(data["items"]) == data["limit"] == 50
    metadata = stored_scope(f)
    assert metadata["visible_count"] == 55 and len(metadata["project_ids"]) == 50
    assert len(metadata["scope_hash"]) == 64
    # The removed project was outside the fifty returned rows. Its contribution
    # to the total still has lineage, so the saved aggregate is no longer read.
    f.db.execute(delete(Project).where(Project.id == "project-054"))
    f.db.commit()
    assert f.client.get(f"{PREFIX}/{task['id']}").status_code == 403


def test_directory_dates_match_project_rollup_without_sending_task_contents(pm, monkeypatch):
    f = pm
    visible = project(f, 1)
    hidden = project(f, 2, member=False)
    for identifier, start, end in (
        (visible, date(2026, 3, 4), date(2026, 9, 21)),
        (hidden, date(2020, 1, 1), date(2030, 1, 1)),
    ):
        sub = SubProject(
            id=identifier + "-sub",
            project_id=identifier,
            name="PRIVATE-SUBPROJECT",
            stage="研究",
            module="制剂",
            status="进行中",
        )
        f.db.add(sub)
        f.db.flush()
        f.db.add(
            Task(
                id=identifier + "-task",
                code="SECRET-CODE",
                name="PRIVATE-TASK-TITLE",
                sub_project_id=sub.id,
                owner_id="pm-other",
                status="进行中",
                priority="中",
                planned_start=start,
                planned_end=end,
                notes="PRIVATE-TASK-NOTES",
                actual_cost=9999,
            )
        )
    f.db.commit()
    seen = []
    original = rollup.live_span

    def spans(db, rows):
        seen.append([row.id for row in rows])
        return original(db, rows)

    monkeypatch.setattr(rollup, "live_span", spans)
    response = ask(f, test_assistant.create(f))
    assert response.status_code == 200, response.text
    item = evidence(f)["projects"]["items"][0]
    assert item["planned_start"] == "2026-03-04" and item["planned_end"] == "2026-09-21"
    assert seen == [[visible]]
    prompt = json.dumps(f.calls[-1]["messages"])
    assert "PRIVATE-TASK" not in prompt and "PRIVATE-SUBPROJECT" not in prompt
    assert "9999" not in prompt and "2030-01-01" not in prompt


@pytest.mark.parametrize("truncated", [False, True], ids=["full-directory", "truncated-directory"])
def test_catalogue_gains_during_generation_preserve_scope_policy(pm, monkeypatch, truncated):
    f = pm
    f.roles = {"admin"}
    for number in range(55 if truncated else 1):
        project(f, number, member=False)
    task = test_assistant.create(f)

    def chat(*args, **kwargs):
        assert not f.db.in_transaction()
        project(f, 100, member=False)
        return "本轮项目目录摘要。", {}

    monkeypatch.setattr(ai, "chat", chat)
    response = ask(f, task)
    if truncated:
        assert response.status_code == 403, response.text
        assert f.db.scalar(select(func.count()).select_from(AssistantMessage)) == 0
    else:
        assert response.status_code == 200, response.text
        assert f.client.get(f"{PREFIX}/{task['id']}").status_code == 200


def test_unused_project_permission_does_not_block_general_history_after_pm_disablement(pm):
    f = pm
    task = test_assistant.create(f)
    request_id = str(uuid4())
    response = test_assistant.question(
        f,
        task,
        request_id=request_id,
        question="解释抗体是什么",
        context="",
        data_sources=["projects"],
        answer_mode="general",
    )
    assert response.status_code == 200, response.text
    assert stored_scope(f)["used_sources"] == []
    f.db.execute(update(User).where(User.id == "pm-author").values(is_active=False))
    f.db.commit()
    assert f.client.get(f"{PREFIX}/{task['id']}").status_code == 200
    replay = test_assistant.question(
        f,
        task,
        request_id=request_id,
        question="解释抗体是什么",
        context="",
        data_sources=["projects"],
        answer_mode="general",
    )
    assert replay.status_code == 200 and len(f.calls) == 1


def test_unbound_named_account_is_never_bound_or_created_while_reading(
    assistant_client, monkeypatch
):
    f = assistant_client
    f.db.add(
        User(
            id="same-name",
            username="author",
            display_name="AUTHOR",
            email="author@example.test",
            role="admin",
            is_active=True,
        )
    )
    f.db.commit()
    monkeypatch.setattr(accounts, "live_roles", lambda subject: {"admin"})
    task = test_assistant.create(f)
    response = ask(f, task)
    assert response.status_code == 403
    assert f.db.scalar(select(func.count()).select_from(User)) == 1
    assert f.db.scalar(select(func.count()).select_from(IAMIdentity)) == 0
    assert f.calls == []


def test_same_subject_from_another_issuer_cannot_resolve_pm_identity(pm, monkeypatch):
    f = pm
    monkeypatch.setattr(accounts, "live_roles", unavailable)
    claims = {
        "iss": "https://different-issuer.test",
        "owner": settings.CASDOOR_ORG,
        "sub": "author",
    }
    with pytest.raises(HTTPException) as exc:
        assistant_projects.access(f.db, claims)
    assert exc.value.status_code == 403


def test_restored_source_does_not_restore_task_project_fields(assistant_client):
    response = assistant_client.client.post(
        PREFIX, json={"id": str(uuid4()), "title": "任务", "project_name": "Not-A-Task-Field"}
    )
    assert response.status_code == 422


def test_application_lineage_cannot_be_supplied_by_the_client(assistant_client):
    f = assistant_client
    task = test_assistant.create(f)
    response = test_assistant.question(
        f, task, application_scope={"version": 1, "used_sources": []}
    )
    assert response.status_code == 422 and f.calls == []


def test_scope_fingerprint_is_unambiguous_for_non_uuid_project_ids():
    first = assistant_projects.Access("member", frozenset({"a\nb", "c"}))
    second = assistant_projects.Access("member", frozenset({"a", "b\nc"}))
    assert assistant_projects.fingerprint(first) != assistant_projects.fingerprint(second)
