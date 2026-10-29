"""Knowledge solution authorization, evidence integrity, concurrency and workflow tests."""

import importlib.util
import io
import time
import zipfile
from pathlib import Path
from types import SimpleNamespace
from xml.etree import ElementTree

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.api.v1 import portal, solutions
from app.core import security
from app.core.config import settings
from app.db.base import Base
from app.db.session import get_db
from app.models import PortalSession
from app.models.solution import KnowledgeSolution, SolutionActor, SolutionEvent
from app.services import ai, password_policy, solution_knowledge
from app.services import solutions as service

PREFIX = "/api/v1/solutions"


@pytest.fixture
def solution_client(token_factory, monkeypatch):
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    db = Session(engine)
    app = FastAPI()
    app.include_router(solutions.router, prefix="/api/v1")
    app.dependency_overrides[get_db] = lambda: db
    monkeypatch.setattr(solution_knowledge, "configured", lambda: False)
    monkeypatch.setattr(
        ai,
        "load_settings",
        lambda: {
            "provider": "deepseek",
            "providers": {"deepseek": {"model": "test", "api_key": ""}},
        },
    )
    with TestClient(app, base_url=settings.portal_origin, follow_redirects=False) as client:
        client.headers["Origin"] = settings.portal_origin

        def login(subject="author"):
            value = "solution-session-" + subject
            token = token_factory(sub=subject, name=subject, displayName=subject.upper())
            db.merge(
                PortalSession(
                    id=security.digest(value),
                    tokens=security.seal({"access_token": token}),
                    expires_at=int(time.time()) + 3600,
                )
            )
            db.merge(
                SolutionActor(issuer=settings.casdoor_issuer, subject=subject, name=subject.upper())
            )
            db.commit()
            client.cookies.set(portal.PORTAL_SESSION_COOKIE, value)

        login()
        yield SimpleNamespace(client=client, db=db, login=login)
    db.close()
    engine.dispose()


def body(**changes):
    return {
        "title": "抗体制剂研究方案",
        "project_name": "M01",
        "product_name": "研究用样品",
        "sections": [{"id": "goal", "title": "研究目标", "content": "专家判断与待验证事项"}],
        "formula": [],
        "references": [],
        **changes,
    }


def create(fixture, **changes):
    response = fixture.client.post(PREFIX, json=body(**changes))
    assert response.status_code == 201, response.text
    return response.json()


def add_source(fixture, **changes):
    response = fixture.client.post(
        PREFIX + "/sources",
        json={
            "title": "缓冲液实验",
            "kind": "practice",
            "authors": "研究员",
            "project_name": "M01",
            "content": "缓冲液稳定性试验记录。条件为研究用样品，结果仍需复核。",
            "locator": "实验记录第2节",
            **changes,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def reference(source, **changes):
    return {
        "id": "ref1",
        "source_id": source["id"],
        "title": source["title"],
        "excerpt": source["content"],
        "source_version": source["version"],
        "locator": source["locator"],
        "section_id": "goal",
        **changes,
    }


def review(fixture, solution, action, **changes):
    return fixture.client.post(
        f"{PREFIX}/{solution['id']}/review",
        json={
            "action": action,
            "revision": solution["revision"],
            "note": "已核对研究限制",
            **changes,
        },
    )


def question(fixture, solution, **changes):
    return fixture.client.post(
        f"{PREFIX}/{solution['id']}/ask",
        json={
            "question": "缓冲液稳定性有什么实践？",
            "context": "",
            "source_ids": [],
            "project_name": "",
            "section_id": "goal",
            **changes,
        },
    )


def test_authentication_and_same_origin_are_required(solution_client):
    f = solution_client
    f.client.cookies.clear()
    assert f.client.get(PREFIX).status_code == 401
    f.login()
    assert (
        f.client.post(PREFIX, json=body(), headers={"Origin": "https://evil.example"}).status_code
        == 403
    )
    f.client.headers.pop("Origin")
    assert f.client.post(PREFIX, json=body()).status_code == 403


def test_persistence_conflict_and_other_identity(solution_client):
    f = solution_client
    row = create(f)
    changed = f.client.put(
        f"{PREFIX}/{row['id']}", json={**body(title="更新"), "revision": row["revision"]}
    )
    assert changed.status_code == 200
    assert changed.json()["revision"] == 2
    stale = f.client.put(f"{PREFIX}/{row['id']}", json={**body(title="旧页面"), "revision": 1})
    assert stale.status_code == 409
    assert f.client.get(f"{PREFIX}/{row['id']}").json()["title"] == "更新"
    f.login("outsider")
    assert f.client.get(PREFIX).json() == []
    for suffix in ("", "/versions", "/history", "/export"):
        assert f.client.get(f"{PREFIX}/{row['id']}{suffix}").status_code == 404
    assert f.client.put(f"{PREFIX}/{row['id']}", json={**body(), "revision": 2}).status_code == 404


def test_issuer_is_part_of_permission_boundary(solution_client):
    f = solution_client
    row = create(f)
    with pytest.raises(HTTPException) as error:
        service.get_solution(f.db, row["id"], {"iss": "https://other-issuer", "sub": "author"})
    assert error.value.status_code == 404


@pytest.mark.parametrize(
    "patch,code",
    [
        ({"source_version": "99"}, 409),
        ({"title": "伪造论文"}, 422),
        ({"excerpt": "不存在的结果"}, 422),
        ({"locator": "虚构第30页"}, 422),
    ],
)
def test_new_references_cannot_forge_source_metadata(solution_client, patch, code):
    f = solution_client
    source = add_source(f)
    response = f.client.post(PREFIX, json=body(references=[reference(source, **patch)]))
    assert response.status_code == code


def test_private_source_cannot_be_stolen_via_reference_or_ask(solution_client):
    f = solution_client
    source = add_source(f)
    f.login("outsider")
    assert f.client.get(PREFIX + "/sources").json() == []
    assert f.client.get(f"{PREFIX}/sources/{source['id']}").status_code == 404
    assert f.client.post(PREFIX, json=body(references=[reference(source)])).status_code == 403
    row = create(f)
    assert question(f, row, source_ids=[source["id"]]).status_code == 403


def test_scoped_retrieval_and_history(solution_client):
    f = solution_client
    target = add_source(f)
    other = add_source(
        f, title="另一个项目", project_name="M02", content="缓冲液稳定性观察，但属于其他项目"
    )
    row = create(f)
    response = question(f, row, project_name="M01")
    assert response.status_code == 200, response.text
    answer = response.json()
    assert answer["mode"] == "retrieval"
    assert {ref["source_id"] for ref in answer["references"]} == {target["id"]}
    assert "未进行模型推理" in answer["content"]
    only_selected = question(f, row, source_ids=[other["id"]]).json()
    assert {ref["source_id"] for ref in only_selected["references"]} == {other["id"]}
    assert "字符" in answer["references"][0]["locator"]
    adopted = f.client.put(
        f"{PREFIX}/{row['id']}",
        json={**body(references=answer["references"]), "revision": row["revision"]},
    )
    assert adopted.status_code == 200, adopted.text
    history = f.client.get(f"{PREFIX}/{row['id']}/history").json()
    assert len(history) == 2
    another = create(f)
    assert f.client.get(f"{PREFIX}/{another['id']}/history").json() == []


def test_context_is_not_evidence_and_no_results_does_not_call_model(solution_client, monkeypatch):
    f = solution_client
    row = create(f)
    monkeypatch.setattr(
        ai, "chat", lambda *a, **kw: pytest.fail("No evidence must not trigger generation")
    )
    answer = question(
        f, row, question="ZebraQuantum材料", context="ZebraQuantum材料是优选材料"
    ).json()
    assert not answer["references"]
    assert "未检索到" in answer["content"]
    assert "优选材料" not in answer["content"]


def test_configured_ai_is_grounded_and_failure_is_not_no_results(solution_client, monkeypatch):
    f = solution_client
    add_source(f)
    row = create(f)
    monkeypatch.setattr(
        ai,
        "load_settings",
        lambda: {
            "provider": "deepseek",
            "providers": {"deepseek": {"model": "test", "api_key": "fake-test-key"}},
        },
    )

    def chat(provider, cfg, messages, **kwargs):
        assert kwargs["timeout"] == 60
        assert "writing_context_not_evidence" in messages[1]["content"]
        assert "缓冲液稳定性试验记录" in messages[1]["content"]
        return "资料记录了试验，仍需复核。[1]", {}

    monkeypatch.setattr(ai, "chat", chat)
    answer = question(f, row).json()
    assert answer["mode"] == "ai" and answer["model"] == "test"

    def failed(*args, **kwargs):
        raise ai.NetworkError("timeout")

    monkeypatch.setattr(ai, "chat", failed)
    response = question(f, row)
    assert response.status_code == 503
    assert "生成失败" in response.json()["detail"]
    assert len(f.client.get(f"{PREFIX}/{row['id']}/history").json()) == 1


def test_invalid_ai_citations_rejected(solution_client, monkeypatch):
    f = solution_client
    add_source(f)
    row = create(f)
    monkeypatch.setattr(
        ai,
        "load_settings",
        lambda: {
            "provider": "deepseek",
            "providers": {"deepseek": {"model": "test", "api_key": "fake"}},
        },
    )
    monkeypatch.setattr(ai, "chat", lambda *args, **kwargs: ("虚构引用 [99]", {}))
    assert question(f, row).status_code == 503


def test_independent_reviewer_only_sees_submission_and_granted_quotes(solution_client):
    f = solution_client
    source = add_source(f, content="允许引用的句子。\n未引用的私有内容。")
    row = create(f, references=[reference(source, excerpt="允许引用的句子。")])
    f.login("reviewer")
    assert f.client.get(f"{PREFIX}/{row['id']}").status_code == 404
    f.login()
    row = review(f, row, "submit", reviewer_id="reviewer").json()
    assert not row["can_edit"]
    assert review(f, row, "approve").status_code == 403
    assert (
        f.client.put(
            f"{PREFIX}/{row['id']}", json={**body(), "revision": row["revision"]}
        ).status_code
        == 409
    )
    f.login("reviewer")
    assert f.client.get(f"{PREFIX}/{row['id']}").status_code == 200
    assert f.client.get(f"{PREFIX}/{row['id']}/history").status_code == 403
    assert question(f, row).status_code == 403
    assert f.client.get(f"{PREFIX}/sources/{source['id']}").status_code == 404
    partial = f.client.get(
        f"{PREFIX}/sources/{source['id']}", params={"solution_id": row["id"]}
    ).json()
    assert partial["content"] == "允许引用的句子。"
    approved = review(f, row, "approve")
    assert approved.status_code == 200, approved.text
    assert approved.json()["status"] == "final"
    f.login()
    revised = review(f, approved.json(), "revise").json()
    assert revised["version"] == 2 and revised["status"] == "draft"
    f.login("reviewer")
    assert f.client.get(f"{PREFIX}/{row['id']}").status_code == 404


def test_author_confirmation_publish_idempotent_and_export_is_docx(solution_client):
    f = solution_client
    source = add_source(f)
    row = create(
        f,
        references=[reference(source)],
        formula=[
            {
                "id": "f1",
                "material": "待研究物料",
                "unit": "mg",
                "basis": "每单位",
                "rationale": "待验证",
                "evidence_ids": ["ref1"],
            }
        ],
    )
    draft = f.client.get(f"{PREFIX}/{row['id']}/export")
    assert draft.status_code == 200
    with zipfile.ZipFile(io.BytesIO(draft.content)) as archive:
        document = archive.read("word/document.xml")
        ElementTree.fromstring(document)
        assert "草稿 / 非定稿" in document.decode()
        assert "配方表" in document.decode()
        assert "参考资料" in document.decode()
    assert f.client.post(f"{PREFIX}/{row['id']}/publish").status_code == 409
    submitted = review(f, row, "submit").json()
    assert review(f, submitted, "approve", note="").status_code == 422
    final = review(f, submitted, "approve").json()
    assert final["status"] == "final" and final["review_notes"].startswith("作者确认：")
    first = f.client.post(f"{PREFIX}/{row['id']}/publish")
    second = f.client.post(f"{PREFIX}/{row['id']}/publish")
    assert first.status_code == second.status_code == 200
    assert first.json()["id"] == second.json()["id"]
    assert first.json()["kind"] == "solution"
    versions = f.client.get(f"{PREFIX}/{row['id']}/versions").json()
    final_snapshot = next(v for v in versions if v["status"] == "final")
    restored = review(f, final, "restore", version_id=final_snapshot["id"]).json()
    assert restored["version"] == 2 and restored["status"] == "draft"
    assert final_snapshot["snapshot"]["status"] == "final"
    actions = set(
        f.db.scalars(select(SolutionEvent.action).where(SolutionEvent.solution_id == row["id"]))
    )
    assert {"create", "submit", "approve", "export", "publish", "restore"} <= actions


def test_return_withdraw_archive_and_conflict_state(solution_client):
    f = solution_client
    row = create(f)
    submitted = review(f, row, "submit").json()
    assert review(f, row, "withdraw").status_code == 409
    returned = review(f, submitted, "return").json()
    assert returned["status"] == "draft"
    submitted = review(f, returned, "submit").json()
    withdrawn = review(f, submitted, "withdraw").json()
    archived = review(f, withdrawn, "archive").json()
    assert archived["status"] == "archived"
    assert (
        f.client.put(
            f"{PREFIX}/{row['id']}", json={**body(), "revision": archived["revision"]}
        ).status_code
        == 409
    )
    assert review(f, archived, "restore").json()["version"] == 2


def mock_kb(monkeypatch):
    record = {
        "id": "kb:sources/paper/example.md",
        "title": "企业文献",
        "kind": "paper",
        "authors": "",
        "date": "",
        "project_name": "M01",
        "tags": [],
        "content": "缓冲液稳定性研究，但有条件限制。",
        "locator": "原文",
        "version": "oldhash",
        "url": "https://kb.example",
        "updated_at": "2026-10-23",
    }
    monkeypatch.setattr(solution_knowledge, "configured", lambda: True)
    monkeypatch.setattr(solution_knowledge, "check_access", lambda claims: None)
    monkeypatch.setattr(solution_knowledge, "list_sources", lambda *args, **kwargs: [record])
    monkeypatch.setattr(solution_knowledge, "get_source", lambda claims, source_id: record)
    return record


def test_external_sources_ai_scope_historical_quotes_and_revocation(solution_client, monkeypatch):
    f = solution_client
    record = mock_kb(monkeypatch)
    assert f.client.get(PREFIX + "/knowledge/status").json()["available"]
    row = create(f)
    answer = question(f, row, source_ids=[record["id"]]).json()
    assert {ref["source_id"] for ref in answer["references"]} == {record["id"]}
    assert (
        question(f, row, project_name="Other", source_ids=[record["id"]]).json()["references"] == []
    )
    saved = f.client.put(
        f"{PREFIX}/{row['id']}",
        json={**body(references=answer["references"]), "revision": row["revision"]},
    )
    assert saved.status_code == 200, saved.text
    row = saved.json()
    record.update(content="新版内容已变化", version="newhash")
    read = f.client.get(f"{PREFIX}/{row['id']}")
    assert read.status_code == 200
    assert read.json()["references"][0]["source_version"] == "oldhash"
    # Removing citations does not remove the permanent knowledge permission lineage.
    saved = f.client.put(f"{PREFIX}/{row['id']}", json={**body(), "revision": row["revision"]})
    assert saved.status_code == 200
    assert f.db.get(KnowledgeSolution, row["id"]).requires_kb

    def revoked(*args, **kwargs):
        raise HTTPException(403, "知识权限已撤销")

    monkeypatch.setattr(solution_knowledge, "check_access", revoked)
    monkeypatch.setattr(solution_knowledge, "get_source", revoked)
    assert f.client.get(PREFIX).json() == []
    for suffix in ("", "/history", "/versions", "/export"):
        assert f.client.get(f"{PREFIX}/{row['id']}{suffix}").status_code == 403
    assert (
        f.client.put(
            f"{PREFIX}/{row['id']}", json={**body(), "revision": saved.json()["revision"]}
        ).status_code
        == 403
    )


def test_kb_lineage_cannot_be_published_as_unrestricted_private_copy(solution_client, monkeypatch):
    f = solution_client
    record = mock_kb(monkeypatch)
    row = create(f, references=[reference(record)])
    row = review(f, row, "submit").json()
    row = review(f, row, "approve").json()
    assert f.client.post(f"{PREFIX}/{row['id']}/publish").status_code == 409


def test_migration_schema_matches_models_and_is_idempotent():
    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    path = Path(__file__).parents[1] / "alembic/versions/2026_10_23_0000-006_knowledge_solutions.py"
    spec = importlib.util.spec_from_file_location("solution_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    topic_path = (
        Path(__file__).parents[1] / "alembic/versions/2026_10_25_0100-008_solution_conversations.py"
    )
    topic_spec = importlib.util.spec_from_file_location("topic_migration", topic_path)
    topic_module = importlib.util.module_from_spec(topic_spec)
    topic_spec.loader.exec_module(topic_module)
    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        with Operations.context(MigrationContext.configure(connection)):
            module.upgrade()
            module.upgrade()
            topic_module.upgrade()
            topic_module.upgrade()
            inspector = inspect(connection)
            for name in [*module.SCHEMAS, "solution_actors"]:
                actual = {column["name"]: column for column in inspector.get_columns(name)}
                expected = Base.metadata.tables[name]
                assert set(actual) == set(expected.columns.keys())
                for column in expected.columns:
                    assert actual[column.name]["nullable"] == column.nullable
            assert "ix_solution_answers_solution_conversation" in {
                index["name"] for index in inspector.get_indexes("solution_answers")
            }
            topic_module.downgrade()
            module.downgrade()
            assert not inspect(connection).get_table_names()
    engine.dispose()


def test_temporary_password_flag_blocks_direct_solution_api(solution_client):
    f = solution_client
    password_policy.require_change(f.db, "author", "reset")
    f.db.commit()
    for path in (PREFIX, PREFIX + "/reviewers", PREFIX + "/sources", PREFIX + "/knowledge/status"):
        response = f.client.get(path)
        assert response.status_code == 403
        assert "临时密码" in response.json()["detail"]
    assert f.client.post(PREFIX, json=body()).status_code == 403


def test_long_external_metadata_and_question_fit_public_contract(solution_client, monkeypatch):
    f = solution_client
    record = mock_kb(monkeypatch)
    record.update(title="文" * 900, locator="sources/" + "a" * 850 + ".md")
    seen = []

    def list_sources(claims, query="", project_name=""):
        seen.append(query)
        assert len(query) <= 1000
        return [record]

    monkeypatch.setattr(solution_knowledge, "list_sources", list_sources)
    row = create(f)
    response = question(f, row, question="缓冲液" * 600)
    assert response.status_code == 200
    assert seen and len(seen[0]) == 1000
    saved = f.client.put(
        f"{PREFIX}/{row['id']}",
        json={**body(references=response.json()["references"]), "revision": row["revision"]},
    )
    assert saved.status_code == 200, saved.text


@pytest.mark.parametrize("external", [False, True])
def test_generic_question_uses_context_for_retrieval_but_not_evidence(
    solution_client, monkeypatch, external
):
    f = solution_client
    source_text = "Trehalose observations require further verification under controlled conditions."
    queries = []
    if external:
        record = mock_kb(monkeypatch)
        record.update(title="Trehalose study", content=source_text)

        def list_sources(claims, query="", project_name=""):
            queries.append(query)
            assert len(query) <= 1000
            return [record] if "Trehalose" in query else []

        monkeypatch.setattr(solution_knowledge, "list_sources", list_sources)
    else:
        record = add_source(f, title="Trehalose study", content=source_text)
    row = create(f)
    generic = "当前章节有哪些相关知识？"
    without_context = question(f, row, question=generic)
    assert without_context.status_code == 200
    assert without_context.json()["references"] == []
    with_context = question(
        f, row, question=generic, context="研究 Trehalose。作者待证假设：保证全部稳定。"
    )
    assert with_context.status_code == 200, with_context.text
    answer = with_context.json()
    assert {ref["source_id"] for ref in answer["references"]} == {record["id"]}
    assert answer["references"][0]["excerpt"] == source_text
    assert "保证全部稳定" not in answer["content"]
    assert all(ref["excerpt"] in record["content"] for ref in answer["references"])
    if external:
        assert queries == [generic, generic + " 研究 Trehalose。作者待证假设：保证全部稳定。"]
