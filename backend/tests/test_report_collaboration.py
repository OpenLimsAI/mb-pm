"""Report grants, stale writes and personal note snapshots have independent scopes."""

from datetime import UTC, datetime, timedelta

import test_solutions
from sqlalchemy import select
from test_solutions import PREFIX, add_source, body, create, reference

from app.models.note import PersonalNote
from app.models.solution import SolutionEvent

solution_client = test_solutions.solution_client


def collaboration_url(row, suffix=""):
    return f"{PREFIX}/{row['id']}/collaboration" + suffix


def register(f, *subjects):
    for subject in subjects:
        f.login(subject)
    f.login()


def grant(f, row, subject, role):
    response = f.client.put(collaboration_url(row, f"/members/{subject}"), json={"role": role})
    assert response.status_code == 204, response.text


def test_owner_editor_commenter_unrelated_and_revocation(solution_client):
    f = solution_client
    register(f, "editor", "commenter", "unrelated")
    row = create(f)
    grant(f, row, "editor", "editor")
    grant(f, row, "commenter", "commenter")
    f.login("editor")
    assert f.client.get(f"{PREFIX}/{row['id']}").json()["can_edit"] is True
    assert f.client.get(PREFIX).json()[0]["id"] == row["id"]
    saved = f.client.put(f"{PREFIX}/{row['id']}", json={**body(title="共同修改"), "revision": 1})
    assert saved.status_code == 200, saved.text
    assert f.client.put(f"{PREFIX}/{row['id']}", json={**body(), "revision": 1}).status_code == 409
    assert (
        f.client.put(
            collaboration_url(row, "/members/unrelated"), json={"role": "editor"}
        ).status_code
        == 403
    )
    f.login("commenter")
    assert f.client.get(f"{PREFIX}/{row['id']}").json()["can_edit"] is False
    assert f.client.put(f"{PREFIX}/{row['id']}", json={**body(), "revision": 2}).status_code == 403
    assert f.client.get(collaboration_url(row)).status_code == 200
    f.login("unrelated")
    assert f.client.get(f"{PREFIX}/{row['id']}").status_code == 404
    assert f.client.get(collaboration_url(row)).status_code == 404
    f.login()
    grant(f, row, "editor", "removed")
    f.login("editor")
    assert f.client.get(collaboration_url(row)).status_code == 404
    assert (
        f.client.put(collaboration_url(row, "/presence"), json={"section_id": "goal"}).status_code
        == 404
    )
    assert (
        f.client.post(
            collaboration_url(row, "/comments"), json={"section_id": "goal", "content": "x"}
        ).status_code
        == 404
    )


def test_comment_threads_quote_integrity_resolve_cas_and_presence_expiry(solution_client):
    f = solution_client
    register(f, "editor", "commenter")
    row = create(f)
    grant(f, row, "editor", "editor")
    grant(f, row, "commenter", "commenter")
    f.login("commenter")
    result = f.client.post(
        collaboration_url(row, "/comments"),
        json={"section_id": "goal", "quote": "专家判断", "content": "请补充依据"},
    )
    assert result.status_code == 201, result.text
    assert (
        f.client.post(
            collaboration_url(row, "/comments"),
            json={"section_id": "goal", "quote": "伪造不存在文字", "content": "x"},
        ).status_code
        == 409
    )
    comment = f.client.get(collaboration_url(row)).json()["comments"][0]
    assert (
        f.client.post(
            collaboration_url(row, "/comments"),
            json={"section_id": "goal", "parent_id": comment["id"], "content": "补充说明"},
        ).status_code
        == 201
    )
    f.login("editor")
    url = collaboration_url(row, f"/comments/{comment['id']}")
    assert (
        f.client.put(url, json={"revision": comment["revision"], "resolved": True}).status_code
        == 204
    )
    assert (
        f.client.put(url, json={"revision": comment["revision"], "resolved": False}).status_code
        == 409
    )
    state = f.client.put(collaboration_url(row, "/presence"), json={"section_id": "goal"}).json()
    assert (
        state["revision"] == 1
    )  # Comments/heartbeat never overwrite or increment report content revision.
    assert state["presence"][0]["actor_id"] == "editor"
    assert state["comments"][0]["resolved"] is True
    heartbeat = f.db.scalar(select(SolutionEvent).where(SolutionEvent.action == "report_presence"))
    heartbeat.created_at = datetime.now(UTC) - timedelta(seconds=80)
    f.db.commit()
    assert f.client.get(collaboration_url(row)).json()["presence"] == []


def test_editor_keeps_immutable_shared_quotes_but_cannot_forge_or_read_private_sources(
    solution_client,
):
    f = solution_client
    register(f, "editor")
    source = add_source(f)
    row = create(f, references=[reference(source)])
    grant(f, row, "editor", "editor")
    f.login("editor")
    result = f.client.put(
        f"{PREFIX}/{row['id']}",
        json={
            **body(
                title="协作稿",
                references=[
                    {**row["references"][0], "anchor_text": "专家判断", "applicability": "共同判断"}
                ],
            ),
            "revision": 1,
        },
    )
    assert result.status_code == 200, result.text
    assert f.client.get(f"{PREFIX}/sources/{source['id']}").status_code == 404
    snapshot = f.client.get(f"{PREFIX}/sources/{source['id']}", params={"solution_id": row["id"]})
    assert snapshot.status_code == 200
    assert snapshot.json()["content"] == row["references"][0]["excerpt"]
    assert f.client.get(f"{PREFIX}/{row['id']}/history").status_code == 403
    forged = {**row["references"][0], "excerpt": "伪造结论"}
    assert (
        f.client.put(
            f"{PREFIX}/{row['id']}", json={**body(references=[forged]), "revision": 2}
        ).status_code
        == 403
    )
    # Frozen report remains immutable to an invited editor.
    f.login()
    f.client.post(f"{PREFIX}/{row['id']}/review", json={"revision": 2, "action": "submit"})
    f.login("editor")
    assert f.client.get(f"{PREFIX}/{row['id']}").json()["can_edit"] is False
    assert (
        f.client.put(
            f"{PREFIX}/{row['id']}", json={**body(references=row["references"]), "revision": 3}
        ).status_code
        == 409
    )


def test_personal_note_links_snapshot_and_do_not_leak_between_members(solution_client):
    f = solution_client
    register(f, "editor")
    note = PersonalNote(
        id="note1",
        issuer=test_solutions.settings.casdoor_issuer,
        owner_id="author",
        title="个人想法",
        content="笔记正文",
        source_app="manual",
        source_title="",
        source_url="",
    )
    f.db.add(note)
    f.db.commit()
    row = create(f)
    grant(f, row, "editor", "editor")
    url = f"{PREFIX}/{row['id']}/note-links"
    result = f.client.post(url, json={"note_id": "note1", "section_id": "goal"})
    assert result.status_code == 201, result.text
    assert result.json()["note_revision"] == 1 and result.json()["content"] == "笔记正文"
    note.content = "更新正文"
    note.revision += 1
    f.db.commit()
    assert f.client.get(url).json()[0]["content"] == "笔记正文"
    f.login("editor")
    assert f.client.get(url).json() == []
    assert f.client.post(url, json={"note_id": "note1", "section_id": "goal"}).status_code == 404
    f.login()
    assert (
        f.client.post(url, json={"note_id": "note1", "section_id": "goal"}).json()["content"]
        == "更新正文"
    )


def test_template_optional_guidance_and_reference_annotations_persist(solution_client):
    f = solution_client
    response = f.client.post(
        PREFIX + "/templates",
        json={
            "name": "方法模板",
            "sections": [{"id": "g", "title": "方法", "content": "写作要求：列出实验条件"}],
        },
    )
    assert response.status_code == 201, response.text
    assert response.json()["sections"][0]["content"] == "写作要求：列出实验条件"
    source = add_source(f)
    row = create(
        f,
        references=[
            {**reference(source), "anchor_text": "专家判断", "applicability": "适用于当前研究条件"}
        ],
    )
    assert row["references"][0]["anchor_text"] == "专家判断"
    assert row["references"][0]["applicability"] == "适用于当前研究条件"
