# ruff: noqa: F401, F811
"""Real authenticated routes, connector bearer isolation and resumable upload protocol."""

import hashlib
from pathlib import Path

import pytest
from test_folder_imports import pdf_bytes
from test_information_api import live
from test_information_live import catalogue, store
from test_information_portal import information_portal
from test_knowledge_sources import F1, headers, ks, records

from app.services import folder_imports as folders
from app.services.information import bridge

PREFIX = "/api/v1/knowledge-sources/v3/folder-imports"


@pytest.fixture
def folder_api(ks, monkeypatch):
    client, db, session, role, state, calls = ks
    old = bridge.call

    def connector(operation, subject, **values):
        if operation == "librarySummary":
            return {**state, "canWrite": state["canWrite"]}
        return old(operation, subject, **values)

    monkeypatch.setattr(bridge, "call", connector)
    monkeypatch.setattr(folders, "authority", lambda db, subject: None)
    return client, db, session, role, state, calls


def body(**updates):
    return {"name": "本机论文", "kind": "local", "folderId": F1, "path": "", **updates}


def test_connector_script_download_uses_packaged_runtime_layout(folder_api, monkeypatch, tmp_path):
    from app.api.v1 import knowledge_source_folder_imports as api

    client, *_ = folder_api
    filename = "knowledge-folder-connector.py"
    content = (Path(__file__).resolve().parents[2] / "scripts" / filename).read_bytes()
    image_root = tmp_path / "code"
    (image_root / "scripts").mkdir(parents=True)
    (image_root / "scripts" / filename).write_bytes(content)
    monkeypatch.setattr(api, "__file__", str(image_root / "app/api/v1/knowledge_source_folder_imports.py"))
    response = client.get(PREFIX + "/connector/script")
    assert response.status_code == 200
    assert response.content == content
    assert filename in response.headers["content-disposition"]


def test_manager_session_same_origin_and_connector_bearer_are_distinct(folder_api):
    client, _, session, _, _, _ = folder_api
    assert client.post(PREFIX + "/tasks", json=body()).status_code == 401
    assert client.post(PREFIX + "/tasks", headers=session(), json=body()).status_code == 403
    response = client.post(PREFIX + "/tasks", headers=headers(session), json=body())
    assert response.status_code == 201, response.text
    task = response.json()["task"]
    assert task["folderId"] == F1 and task["status"] == "offline"
    assert task["dailyFileLimit"] == task["usage"]["limit"] == 1000
    assert task["usage"]["remainingFiles"] == 1000
    measured = client.get(PREFIX + "/tasks/" + task["id"] + "/usage", headers=session())
    assert measured.status_code == 200 and measured.json()["days"] == []
    assert client.post(PREFIX + "/connector/poll", headers=session(), json={}).status_code == 401
    pairing = client.post(
        PREFIX + "/tasks/" + task["id"] + "/pairing", headers=headers(session), json={}
    ).json()
    response = client.post(
        PREFIX + "/connector/pair", json={"code": pairing["code"], "path": "/home/user/research"}
    )
    assert response.status_code == 200, response.text
    token = response.json()["token"]
    assert (
        client.post(
            PREFIX + "/connector/pair",
            json={"code": pairing["code"], "path": "/home/user/research"},
        ).status_code
        == 403
    )
    bearer = {"Authorization": "Bearer " + token}
    poll = client.post(PREFIX + "/connector/poll", headers=bearer, json={}).json()
    run = poll["run"]
    assert run["id"] and run["lease"]
    content = pdf_bytes(9)
    sha = hashlib.sha256(content).hexdigest()
    manifest = {
        "files": [
            {"relativePath": "research.pdf", "size": len(content), "mtime": 10000, "sha256": sha}
        ]
    }
    endpoint = PREFIX + "/connector/runs/" + run["id"]
    assert client.post(endpoint + "/manifest", headers=bearer, json=manifest).status_code == 403
    bearer["X-Folder-Run-Lease"] = run["lease"]
    response = client.post(endpoint + "/manifest", headers=bearer, json=manifest)
    assert response.status_code == 200, response.text
    assert response.json()["needFiles"] == ["research.pdf"]
    response = client.post(
        endpoint + "/files",
        headers=bearer,
        data={"relativePath": "research.pdf", "sha256": sha},
        files={"file": ("research.pdf", content, "application/pdf")},
    )
    assert response.status_code == 200, response.text
    assert response.json()["originalSaved"]
    assert client.post(endpoint + "/finish", headers=bearer, json={}).status_code == 202
    detail = client.get(PREFIX + "/runs/" + run["id"], headers=session()).json()
    assert detail["items"][0]["originalSaved"]
    assert "lease" not in detail["run"]
    assert "actorSubject" not in detail["run"]
    assert (
        client.post(
            endpoint + "/files",
            headers=bearer,
            data={"relativePath": "research.pdf", "sha256": sha},
            files={"file": ("research.pdf", content, "application/pdf")},
        ).status_code
        == 409
    )
    assert (
        client.delete(PREFIX + "/tasks/" + task["id"], headers=headers(session)).status_code == 200
    )
    assert client.post(PREFIX + "/connector/poll", headers=bearer, json={}).status_code in (
        401,
        404,
    )


def test_invalid_schedule_and_unknown_fields_do_not_create_task(folder_api):
    client, _, session, _, _, _ = folder_api
    for invalid in (
        {"schedule": {"time": "25:99"}},
        {"schedule": {"timezone": "Invalid/Zone"}},
        {"maxFileMb": 101},
        {"dailyFileLimit": 0},
        {"dailyFileLimit": 50001},
        {"dailyFileLimit": True},
        {"serverSecret": "not-accepted"},
    ):
        response = client.post(PREFIX + "/tasks", headers=headers(session), json=body(**invalid))
        assert response.status_code == 422, response.text
    assert client.get(PREFIX + "/bootstrap", headers=session()).json()["tasks"] == []


def test_pair_reconnect_after_manifest_revokes_old_token_and_keeps_saved_originals(folder_api):
    client, _, session, _, _, _ = folder_api
    task = client.post(PREFIX + "/tasks", headers=headers(session), json=body()).json()["task"]

    def pair():
        pairing = client.post(
            PREFIX + "/tasks/" + task["id"] + "/pairing", headers=headers(session), json={}
        ).json()
        return client.post(
            PREFIX + "/connector/pair", json={"code": pairing["code"], "path": "/research"}
        ).json()["token"]

    first = pair()
    one = {"Authorization": "Bearer " + first}
    run = client.post(PREFIX + "/connector/poll", headers=one, json={}).json()["run"]
    one["X-Folder-Run-Lease"] = run["lease"]
    content = pdf_bytes(1)
    sha = hashlib.sha256(content).hexdigest()
    manifest = {
        "files": [{"relativePath": "a.pdf", "size": len(content), "mtime": 1000, "sha256": sha}]
    }
    path = PREFIX + "/connector/runs/" + run["id"]
    assert client.post(path + "/manifest", headers=one, json=manifest).status_code == 200
    assert (
        client.post(
            path + "/files",
            headers=one,
            data={"relativePath": "a.pdf", "sha256": sha},
            files={"file": ("a.pdf", content, "application/pdf")},
        ).status_code
        == 200
    )
    second = pair()
    assert client.post(PREFIX + "/connector/poll", headers=one, json={}).status_code == 401
    two = {"Authorization": "Bearer " + second}
    resumed = client.post(PREFIX + "/connector/poll", headers=two, json={}).json()["run"]
    assert resumed["id"] == run["id"] and resumed["lease"] != run["lease"]
    two["X-Folder-Run-Lease"] = resumed["lease"]
    assert client.post(path + "/manifest", headers=two, json=manifest).json()["needFiles"] == []
    assert client.post(path + "/finish", headers=two, json={}).status_code == 202
