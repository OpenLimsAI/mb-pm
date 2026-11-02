"""Real API persistence, scope boundaries, recovery, and export regression coverage."""

import base64
import importlib.util
import io
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

import test_solutions
from sqlalchemy import inspect, select
from test_solutions import PREFIX, add_source, body, create, question, reference

from app.models.solution import SolutionAnswer, SolutionTopic

solution_client = test_solutions.solution_client


def save(f, row, **changes):
    return f.client.put(
        f"{PREFIX}/{row['id']}", json={**body(), "revision": row["revision"], **changes}
    )


def test_outline_organization_and_template_owner_scope(solution_client):
    f = solution_client
    sections = [
        {"id": "goal", "title": "目标", "content": "正文"},
        {"id": "child", "parent_id": "goal", "title": "子章", "content": "子章正文"},
    ]
    row = create(f, sections=sections, pinned=True, tags=["配方", "配方", "研发"])
    assert row["pinned"] is True and row["tags"] == ["配方", "研发"]
    assert row["sections"][1]["parent_id"] == "goal"
    invalid = [{**sections[0], "parent_id": "child"}, sections[1]]
    assert save(f, row, sections=invalid).status_code == 422
    template = {
        "name": "研究结构",
        "sections": [{k: v for k, v in s.items() if k != "content"} for s in sections],
    }
    response = f.client.post(PREFIX + "/templates", json=template)
    assert response.status_code == 201, response.text
    ident = response.json()["id"]
    assert len(f.client.get(PREFIX + "/templates").json()) == 1
    f.login("other")
    assert f.client.get(PREFIX + "/templates").json() == []
    assert f.client.delete(PREFIX + "/templates/" + ident).status_code == 404
    assert f.client.put(f"{PREFIX}/{row['id']}", json={**body(), "revision": 1}).status_code == 404
    f.login()
    assert f.client.delete(PREFIX + "/templates/" + ident).status_code == 204


def test_autosnapshot_named_version_and_section_restore_preserve_other_changes(solution_client):
    f = solution_client
    source = add_source(f)
    row = create(f, references=[reference(source)])
    changed = save(
        f,
        row,
        sections=[
            {"id": "goal", "title": "新目标", "content": "新正文"},
            {"id": "second", "title": "第二章", "content": "其他修改"},
        ],
        references=[],
    ).json()
    versions = f.client.get(f"{PREFIX}/{row['id']}/versions").json()
    assert len(versions) == 1
    assert versions[0]["snapshot"]["references"][0]["id"] == "ref1"
    named = f.client.post(
        f"{PREFIX}/{row['id']}/versions", json={"revision": changed["revision"], "name": "阶段一"}
    )
    assert named.status_code == 201, named.text
    revision = named.json()["snapshot"]["revision"]
    assert revision == changed["revision"] + 1
    assert (
        f.client.post(
            f"{PREFIX}/{row['id']}/versions", json={"revision": changed["revision"], "name": "过期"}
        ).status_code
        == 409
    )
    result = f.client.post(
        f"{PREFIX}/{row['id']}/versions/{versions[0]['id']}/restore-section",
        json={"revision": revision, "section_id": "goal"},
    )
    assert result.status_code == 200, result.text
    restored = result.json()
    assert restored["sections"][0]["content"] == row["sections"][0]["content"]
    assert restored["sections"][1]["content"] == "其他修改"
    assert restored["references"][0]["excerpt"] == source["content"]
    other = create(f)
    assert (
        f.client.post(
            f"{PREFIX}/{other['id']}/versions/{versions[0]['id']}/restore-section",
            json={"revision": 1, "section_id": "goal"},
        ).status_code
        == 404
    )
    f.login("other")
    assert f.client.get(f"{PREFIX}/{row['id']}/versions").status_code == 404


def test_topic_rename_archive_delete_and_cas(solution_client):
    f = solution_client
    row = create(f)
    assert question(f, row, conversation_id="topic").status_code == 200
    topics = f.client.get(f"{PREFIX}/{row['id']}/topics").json()
    assert topics[0]["revision"] == 0
    url = f"{PREFIX}/{row['id']}/topics/topic"
    renamed = f.client.put(url, json={"revision": 0, "title": "稳定性", "archived": True})
    assert renamed.status_code == 200
    assert question(f, row, conversation_id="topic").status_code == 409
    assert f.client.put(url, json={"revision": 0, "title": "覆盖"}).status_code == 409
    f.login("other")
    assert f.client.get(f"{PREFIX}/{row['id']}/topics").status_code == 404
    f.login()
    assert f.client.request("DELETE", url, json={"revision": 1}).status_code == 204
    assert f.client.get(f"{PREFIX}/{row['id']}/topics").json() == []
    assert f.client.get(f"{PREFIX}/{row['id']}/history").json() == []
    assert len(list(f.db.scalars(select(SolutionAnswer)))) == 1  # logical deletion retains evidence
    assert question(f, row, conversation_id="topic").status_code == 409


def test_deleted_topic_cannot_reappear_after_model_finishes(solution_client, monkeypatch):
    from app.services import ai

    f = solution_client
    row = create(f)
    add_source(f)
    monkeypatch.setattr(
        ai,
        "load_settings",
        lambda: {
            "provider": "deepseek",
            "providers": {"deepseek": {"model": "test", "api_key": "test"}},
        },
    )

    def finish(*args, **kwargs):
        f.db.add(SolutionTopic(solution_id=row["id"], id="pending", deleted=True, revision=1))
        f.db.commit()
        return "研究结果[1]", 0

    monkeypatch.setattr(ai, "chat", finish)
    result = question(f, row, conversation_id="pending")
    assert result.status_code == 409, result.text
    assert f.client.get(f"{PREFIX}/{row['id']}/history").json() == []


def test_rendered_quote_verified_against_current_authorized_text(solution_client):
    f = solution_client
    source = add_source(f, content="前文。\n\n## 实验\n**缓冲条件** 是研究重点。\n后文。")
    ref = reference(
        source, excerpt="缓冲条件 是研究重点。", locator=source["locator"] + " · 原文选段"
    )
    row = create(f, references=[ref])
    assert row["references"][0]["excerpt"] == ref["excerpt"]
    bad = {**ref, "excerpt": "不存在的疗效结论"}
    assert f.client.post(PREFIX, json=body(references=[bad])).status_code == 422
    bad_page = {**ref, "locator": "第999页"}
    assert f.client.post(PREFIX, json=body(references=[bad_page])).status_code == 422


def test_word_export_contains_editable_styles_tables_images_and_page_fields(solution_client):
    f = solution_client
    png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1sAAAAASUVORK5CYII="
    content = (
        "# 小标题\n**粗体** 与 *斜体*\n- 项目\n\n| 项目 | 结果 |\n| --- | --- |\n| A | 1 |\n\n![实验图](data:image/png;base64,"
        + png
        + ")\n[来源](https://example.org/paper)"
    )
    row = create(f, sections=[{"id": "goal", "title": "研究目标", "content": content}])
    response = f.client.get(f"{PREFIX}/{row['id']}/export")
    assert response.status_code == 200
    with zipfile.ZipFile(io.BytesIO(response.content)) as z:
        for name in z.namelist():
            if name.endswith((".xml", ".rels")):
                ET.fromstring(z.read(name))
        doc = z.read("word/document.xml").decode()
        assert "<w:b/>" in doc and "<w:i/>" in doc and "<w:tbl>" in doc
        assert "TOC " in doc and "footerReference" in doc and "<w:drawing>" in doc
        assert "**粗体**" not in doc and "| ---" not in doc
        assert z.read("word/media/image1.png") == base64.b64decode(png)
        assert "PAGE" in z.read("word/footer.xml").decode()


def test_image_payload_limits_and_template_cycles(solution_client):
    f = solution_client
    response = f.client.post(
        PREFIX, json=body(sections=[{"id": "g", "title": "章", "content": "x" * 50001}])
    )
    assert response.status_code == 422
    response = f.client.post(
        PREFIX,
        json=body(
            sections=[{"id": "g", "title": "章", "content": "![x](data:image/png;base64,ZmFrZQ==)"}]
        ),
    )
    assert response.status_code == 422
    response = f.client.post(
        PREFIX + "/templates",
        json={
            "name": "循环",
            "sections": [
                {"id": "a", "title": "A", "parent_id": "b"},
                {"id": "b", "title": "B", "parent_id": "a"},
            ],
        },
    )
    assert response.status_code == 422


def test_workbench_migration_is_idempotent(solution_client):
    from sqlalchemy import create_engine, text

    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    path = Path(__file__).parents[1] / "alembic/versions/2026_11_02_0400-019_report_workbench.py"
    spec = importlib.util.spec_from_file_location("report_workbench_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.revision == "019" and module.down_revision == "018"
    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE knowledge_solutions (id VARCHAR(64) PRIMARY KEY)"))
        connection.execute(text("INSERT INTO knowledge_solutions (id) VALUES ('existing-report')"))
        with Operations.context(MigrationContext.configure(connection)):
            module.upgrade()
            module.upgrade()
        assert {"pinned", "tags"} <= {
            c["name"] for c in inspect(connection).get_columns("knowledge_solutions")
        }
        assert {"solution_templates", "solution_topics"} <= set(
            inspect(connection).get_table_names()
        )
        preserved = connection.execute(
            text("SELECT id, pinned, tags FROM knowledge_solutions")
        ).one()
        assert preserved == ("existing-report", 0, "[]")
        from app.db.base import Base

        for name in ("solution_templates", "solution_topics"):
            assert {c["name"] for c in inspect(connection).get_columns(name)} == set(
                Base.metadata.tables[name].columns.keys()
            )
        assert {i["name"] for i in inspect(connection).get_indexes("solution_templates")} == {
            "ix_solution_templates_issuer",
            "ix_solution_templates_owner_id",
        }
        with Operations.context(MigrationContext.configure(connection)):
            module.downgrade()
        assert (
            connection.execute(text("SELECT id FROM knowledge_solutions")).scalar_one()
            == "existing-report"
        )
        assert "solution_topics" not in inspect(connection).get_table_names()

    engine.dispose()


def test_disconnected_request_does_not_persist_answer(solution_client, monkeypatch):
    from app.api.v1 import solutions

    f = solution_client
    row = create(f)
    monkeypatch.setattr(solutions.from_thread, "run", lambda *args: True)
    result = question(f, row, conversation_id="cancelled")
    assert result.status_code == 499
    assert f.client.get(f"{PREFIX}/{row['id']}/history").json() == []


def test_quote_normalization_does_not_remove_literal_scientific_symbols(solution_client):
    f = solution_client
    source = add_source(f, content="使用 H_2O 与 2*3 对照。pH < 5 > 2。")
    forged = reference(source, excerpt="H2O 与 23", locator=source["locator"] + " · 原文选段")
    response = f.client.post(PREFIX, json=body(references=[forged]))
    assert response.status_code == 422
    forged_math = reference(source, excerpt="pH 2。", locator=source["locator"] + " · 原文选段")
    assert f.client.post(PREFIX, json=body(references=[forged_math])).status_code == 422
