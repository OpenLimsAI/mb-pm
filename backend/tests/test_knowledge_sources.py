# ruff: noqa: F811
"""Real portal/bridge contracts; imported pytest fixtures are intentionally parameters."""

import copy
from unittest.mock import Mock

import pytest
from test_information_api import live  # noqa: F401
from test_information_live import catalogue, store  # noqa: F401
from test_information_portal import information_portal  # noqa: F401

from app.core.config import settings
from app.services import knowledge_source_worker
from app.services.information import bridge
from app.services.information.ich import parse_catalogue
from app.services.information.store import Store, tenant_key

F1 = "11111111-1111-4111-8111-111111111111"
F2 = "22222222-2222-4222-8222-222222222222"
P1 = "sources/Existing_Paper.md"


@pytest.fixture
def ks(live, monkeypatch):
    client, db, session, role = live
    monkeypatch.setattr(settings, "INFORMATION_APP_ENABLED", False)
    monkeypatch.setattr(settings, "KNOWLEDGE_SOURCE_APP_ENABLED", True)
    monkeypatch.setattr(settings, "KNOWLEDGE_SOURCE_WORKER_ENABLED", True)
    state = {
        "revision": 0,
        "folders": [{"id": F1, "name": "ICH"}, {"id": F2, "name": "质量研究"}],
        "assignments": {P1: F1},
        "memberships": {P1: [F1]},
        "papers": [{"path": P1, "title": "Existing Paper", "url": "https://kb.example/?paper=x"}],
        "url": "https://kb.example",
        "canWrite": True,
    }
    calls = []

    def connector(operation, subject, **values):
        calls.append((operation, subject, values))
        if operation in ("library", "catalogue"):
            return copy.deepcopy(state)
        if operation == "createFolder":
            existing = next((f for f in state["folders"] if f["name"] == values["name"]), None)
            if existing:
                return existing
            created = {"id": "33333333-3333-4333-8333-333333333333", "name": values["name"]}
            state["folders"].append(created)
            state["revision"] += 1
            return created
        if operation == "folderMutation":
            mutation = values["mutation"]
            if mutation["operation"] != "move":
                assert "fromFolderId" not in mutation
            if mutation["revision"] != state["revision"]:
                raise bridge.BridgeError(409, "论文分类已更新")
            op = mutation["operation"]
            if op == "rename":
                next(f for f in state["folders"] if f["id"] == mutation["folderId"])["name"] = (
                    mutation["name"]
                )
            elif op == "create":
                state["folders"].append(
                    {"id": "33333333-3333-4333-8333-333333333333", "name": mutation["name"]}
                )
            else:
                for path in mutation["paths"]:
                    folders = set(state["memberships"].get(path, []))
                    if op == "move":
                        folders.discard(mutation.get("fromFolderId"))
                    if op == "remove":
                        folders -= set(mutation["folderIds"])
                    else:
                        folders |= set(mutation["folderIds"])
                    state["memberships"][path] = sorted(folders)
            state["revision"] += 1
            return copy.deepcopy(state)
        raise AssertionError(operation)

    monkeypatch.setattr(bridge, "call", connector)
    return client, db, session, role, state, calls


def headers(session, **claims):
    return {**session(**claims), "Origin": settings.portal_origin}


def records(db):
    return Store(db, tenant_key(settings.casdoor_issuer, settings.CASDOOR_ORG))


def saved_document(db, linked=False):
    s = records(db)
    source = s.ensure_source()
    s.apply_catalogue(source["id"], "Q", parse_catalogue(catalogue(), "Q"))
    doc = s.documents()[0]
    doc["folderIds"] = [F1]
    s.put("document", doc)
    version = s.archive(
        doc["id"], b"%PDF-actual-retained-original", "readable text", parse_status="ready"
    )
    if linked:
        version.update(kbPath=P1, kbUrl="https://kb.example/?paper=x", indexStatus="ready")
        s.put("version", version)
    db.commit()
    return s, source, doc, version


def test_snapshot_lists_all_authorized_kb_papers_without_seed_or_collection(ks):
    client, db, session, _, state, calls = ks
    response = client.get("/api/v1/knowledge-sources/snapshot", headers=session())
    assert response.status_code == 200
    data = response.json()
    assert data["papers"][0]["id"] == P1
    assert data["papers"][0]["folderIds"] == [F1]
    assert data["papers"][0]["saved"] is False
    assert data["papers"][0]["indexStatus"] == "unknown"
    assert data["documents"] == [] and data["jobs"] == []
    assert data["canOrganize"] is True
    assert data["integration"]["status"] == "ready"
    assert all(c[0] == "library" for c in calls)
    assert records(db).records("job") == []
    assert client.get("/api/v1/information/snapshot", headers=session()).status_code == 410
    assert response.headers["cache-control"] == "no-store"


def test_source_new_marker_is_durable_and_projected_to_the_selected_scopes(ks):
    client, db, session, _, _, _ = ks
    s = records(db)
    source = s.ensure_source()
    first = parse_catalogue(catalogue(), "Q")[0]
    s.apply_catalogue(source["id"], "Q", [first])
    s.finish_check(source["id"], {"Q": {"status": "ok", "count": 1}})
    added = {**first, "key": "new-guideline", "title": "New guideline"}
    s.apply_catalogue(source["id"], "Q", [first, added])
    source = s.source(source["id"])
    source["scopes"] = ["S"]
    s.put("source", source)
    # Old persisted records are valid without the new optional metadata.
    legacy = next(doc for doc in s.documents() if doc["key"] == first["key"])
    legacy.pop("newInScopes")
    s.put("document", legacy)
    db.commit()
    response = client.get("/api/v1/knowledge-sources/snapshot", headers=session())
    assert response.status_code == 200
    assert all(doc["isNew"] is False for doc in response.json()["documents"])
    source["scopes"] = ["Q"]
    s.put("source", source)
    db.commit()
    response = client.get("/api/v1/knowledge-sources/snapshot", headers=session())
    docs = {doc["title"]: doc for doc in response.json()["documents"]}
    assert docs["New guideline"]["isNew"] is True
    assert docs[first["title"]]["isNew"] is False
    assert response.json()["jobs"] == []
    assert len(response.json()["papers"]) == 1  # Discovery does not create a saved paper.


def test_live_role_same_origin_and_forced_password_guard(ks):
    client, db, session, role, state, _ = ks
    assert client.get("/api/v1/knowledge-sources/snapshot").status_code == 401
    path = "/api/v1/knowledge-sources/sources/missing/check"
    assert client.post(path, headers=session(), json={}).status_code == 403
    role["value"] = "kb_viewer"
    assert client.post(path, headers=headers(session), json={}).status_code == 403
    state["canWrite"] = False
    assert (
        client.post(
            "/api/v1/knowledge-sources/folders",
            headers=headers(session),
            json={"name": "X", "revision": 0},
        ).status_code
        == 403
    )
    from app.services import password_policy

    password_policy.require_change(db, "information-only", "temporary")
    db.commit()
    assert client.get("/api/v1/knowledge-sources/snapshot", headers=session()).status_code == 403


def test_bridge_permission_failure_is_visible_and_not_demo_fallback(ks, monkeypatch):
    client, _, session, _, _, _ = ks

    def unavailable(*args, **kwargs):
        raise bridge.BridgeError(403, "没有知识库阅读权限")

    monkeypatch.setattr(bridge, "call", unavailable)
    data = client.get("/api/v1/knowledge-sources/snapshot", headers=session()).json()
    assert data["papers"] == [] and data["folders"] == []
    assert data["integration"]["status"] == "error"
    assert "阅读权限" in data["integration"]["message"]


def test_multiple_folders_reuse_same_paper_and_stale_revision_is_rejected(ks):
    client, _, session, _, state, _ = ks
    body = {"paperIds": [P1], "folderIds": [F2], "mode": "add", "revision": 0}
    assert (
        client.post(
            "/api/v1/knowledge-sources/papers/folders", headers=headers(session), json=body
        ).status_code
        == 200
    )
    assert state["memberships"][P1] == [F1, F2]
    assert (
        client.post(
            "/api/v1/knowledge-sources/papers/folders", headers=headers(session), json=body
        ).status_code
        == 409
    )
    body.update(folderIds=[], fromFolderId=F1, mode="remove", revision=1)
    assert (
        client.post(
            "/api/v1/knowledge-sources/papers/folders", headers=headers(session), json=body
        ).status_code
        == 200
    )
    assert state["memberships"][P1] == [F2] and len(state["papers"]) == 1
    body.update(paperIds=["sources/unknown.md"], folderIds=[F1], mode="add", revision=2)
    assert (
        client.post(
            "/api/v1/knowledge-sources/papers/folders", headers=headers(session), json=body
        ).status_code
        == 404
    )


def test_archived_unindexed_paper_is_readable_and_can_be_classified(ks):
    client, db, session, _, _, _ = ks
    s, _, doc, version = saved_document(db)
    data = client.get("/api/v1/knowledge-sources/snapshot", headers=session()).json()
    paper = next(p for p in data["papers"] if p.get("documentId") == doc["id"])
    assert paper["saved"] is True and paper["indexStatus"] == "not_requested"
    path = paper["originalUrl"]
    assert client.get(path).status_code == 401
    assert client.get(path, headers=session()).content == b"%PDF-actual-retained-original"
    assert client.get(path.replace(version["id"], "a" * 64), headers=session()).status_code == 404
    body = {"paperIds": [paper["id"]], "folderIds": [F2], "mode": "add", "revision": 0}
    assert (
        client.post(
            "/api/v1/knowledge-sources/papers/folders", headers=headers(session), json=body
        ).status_code
        == 200
    )
    data = client.get("/api/v1/knowledge-sources/snapshot", headers=session()).json()
    assert next(p for p in data["papers"] if p["id"] == paper["id"])["folderIds"] == [F1, F2]
    assert s.archive_path(version).read_bytes() == b"%PDF-actual-retained-original"


def test_linked_archive_does_not_duplicate_or_resurrect_deleted_core_paper(ks):
    client, db, session, _, state, _ = ks
    _, _, _, version = saved_document(db, linked=True)
    data = client.get("/api/v1/knowledge-sources/snapshot", headers=session()).json()
    assert len(data["papers"]) == 1 and data["papers"][0]["indexStatus"] == "ready"
    original_url = data["papers"][0]["originalUrl"]
    assert client.get(original_url, headers=session()).status_code == 200
    state["papers"] = []
    assert (
        client.get("/api/v1/knowledge-sources/snapshot", headers=session()).json()["papers"] == []
    )
    assert records(db).get("version", version["id"])["size"] > 0
    assert client.get(original_url, headers=session()).status_code == 404


def test_source_defaults_to_same_name_folder_and_deduplicates_ich(ks):
    client, db, session, _, state, _ = ks
    body = {"name": "ICH", "url": "https://www.ich.org/page/quality-guidelines", "enabled": False}
    response = client.post("/api/v1/knowledge-sources/sources", headers=headers(session), json=body)
    assert response.status_code == 201
    assert records(db).source(response.json()["id"])["folderId"] == F1
    assert len(state["folders"]) == 2
    assert (
        client.post(
            "/api/v1/knowledge-sources/sources", headers=headers(session), json=body
        ).json()["id"]
        == response.json()["id"]
    )
    assert len(records(db).records("source")) == 1
    body.update(name="FDA", url="https://www.fda.gov")
    assert (
        client.post(
            "/api/v1/knowledge-sources/sources", headers=headers(session), json=body
        ).status_code
        == 201
    )
    unsupported = next(s for s in records(db).records("source") if s["adapter"] == "unsupported")
    assert (
        client.post(
            f'/api/v1/knowledge-sources/sources/{unsupported["id"]}/check',
            headers=headers(session),
            json={},
        ).status_code
        == 400
    )
    assert records(db).records("job") == []


def test_new_manual_jobs_are_tagged_and_old_jobs_cannot_resume(ks):
    client, db, session, _, _, _ = ks
    s, source, doc, _ = saved_document(db)
    old = s.create_job(source["id"], "information-only", kind="monitor")
    db.commit()
    response = client.post(
        f'/api/v1/knowledge-sources/sources/{source["id"]}/check', headers=headers(session), json={}
    )
    assert response.status_code == 202
    assert s.get("job", response.json()["id"])["app"] == "knowledge-sources"
    assert s.get("job", old["id"])["status"] == "queued"
    assert (
        client.post(
            f'/api/v1/knowledge-sources/jobs/{old["id"]}/control',
            headers=headers(session),
            json={"action": "pause"},
        ).status_code
        == 404
    )
    path = f'/api/v1/knowledge-sources/jobs/{response.json()["id"]}/control'
    assert client.post(path, headers=headers(session), json={"action": "pause"}).status_code == 200
    assert client.post(path, headers=headers(session), json={"action": "cancel"}).status_code == 200
    body = {"sourceId": source["id"], "documentIds": [doc["id"]], "parse": False}
    response = client.post("/api/v1/knowledge-sources/jobs", headers=headers(session), json=body)
    assert response.status_code == 202
    job = s.get("job", response.json()["id"])
    assert job["folderId"] == F1 and job["app"] == "knowledge-sources" and job["parse"] is False


def test_stars_are_personal_and_only_authorized_papers_are_accepted(ks):
    client, _, session, _, _, _ = ks
    body = {"paperId": P1, "enabled": True}
    assert (
        client.post(
            "/api/v1/knowledge-sources/stars", headers=headers(session, sub="alice"), json=body
        ).status_code
        == 200
    )
    assert client.get("/api/v1/knowledge-sources/snapshot", headers=session(sub="alice")).json()[
        "starred"
    ] == [P1]
    assert (
        client.get("/api/v1/knowledge-sources/snapshot", headers=session(sub="bob")).json()[
            "starred"
        ]
        == []
    )
    body["paperId"] = "sources/unauthorized.md"
    assert (
        client.post(
            "/api/v1/knowledge-sources/stars", headers=headers(session), json=body
        ).status_code
        == 404
    )


def test_separate_worker_does_not_open_database_when_disabled(monkeypatch):
    monkeypatch.setattr(settings, "KNOWLEDGE_SOURCE_APP_ENABLED", True)
    monkeypatch.setattr(settings, "KNOWLEDGE_SOURCE_WORKER_ENABLED", False)
    factory = Mock()
    knowledge_source_worker.tick(factory, Mock())
    factory.assert_not_called()


def test_new_app_gate_does_not_reenable_old_information(ks, monkeypatch):
    client, db, session, _, _, _ = ks
    monkeypatch.setattr(settings, "KNOWLEDGE_SOURCE_APP_ENABLED", False)
    assert client.get("/api/v1/knowledge-sources/snapshot").status_code == 401
    assert client.get("/api/v1/knowledge-sources/snapshot", headers=session()).status_code == 410
    assert client.get("/api/v1/information/snapshot", headers=session()).status_code == 410
    entries = client.get("/api/v1/portal/me", headers=session()).json()["applications"]
    assert next(v for v in entries if v["id"] == "knowledge-sources")["enabled"] is False
    assert records(db).records("job") == []


def test_worker_executes_only_new_manual_jobs_and_ignores_old_monitor(store, monkeypatch):
    s, db = store
    monkeypatch.setattr(settings, "KNOWLEDGE_SOURCE_APP_ENABLED", True)
    monkeypatch.setattr(settings, "KNOWLEDGE_SOURCE_WORKER_ENABLED", True)
    source = s.ensure_source()
    source.update(enabled=True, managerSubject="manager", nextCheckAt=0)
    s.put("source", source)
    old = s.create_job(source["id"], "manager", kind="monitor")
    new = s.create_job(source["id"], "manager", kind="check", app="knowledge-sources")
    db.commit()
    called = []

    class SessionProxy:
        def __getattr__(self, key):
            return getattr(db, key)

        def close(self):
            pass

    def step(store, official, **kwargs):
        called.append(kwargs["job_id"])
        job = store.get("job", kwargs["job_id"])
        job["status"] = "completed"
        store.put("job", job)
        store.db.commit()

    monkeypatch.setattr(knowledge_source_worker, "run_step", step)
    official = Mock()
    knowledge_source_worker.tick(lambda: SessionProxy(), lambda: official)
    assert called == [new["id"]]
    assert s.get("job", old["id"])["status"] == "queued"
    official.catalogue.assert_not_called()
    assert len(s.records("job")) == 2


@pytest.mark.parametrize("state", ["paused", "cancelled"])
def test_target_paused_between_selection_and_run_never_falls_back_to_old_jobs(
    store, monkeypatch, state
):
    from app.services.information import worker

    s, db = store
    source = s.ensure_source()
    old = s.create_job(source["id"], "manager", kind="monitor")
    new = s.create_job(source["id"], "manager", kind="check", app="knowledge-sources")
    new["status"] = state
    s.put("job", new)
    db.commit()
    check_authority = Mock()
    monkeypatch.setattr(worker, "authority", check_authority)
    official = Mock()
    assert worker.run_step(s, official, job_id=new["id"], app="knowledge-sources") is False
    assert worker.run_step(s, official, job_id="missing", app="knowledge-sources") is False
    check_authority.assert_not_called()
    official.catalogue.assert_not_called()
    assert s.get("job", old["id"])["status"] == "queued"


def test_new_manual_import_archives_bytes_without_resuming_legacy_queue(store, monkeypatch):
    from app.services.information import worker

    s, db = store
    source = s.ensure_source()
    s.apply_catalogue(source["id"], "Q", parse_catalogue(catalogue(), "Q"))
    doc = s.documents()[0]
    old = s.create_job(source["id"], "manager", kind="monitor")
    new = s.create_job(
        source["id"],
        "manager",
        kind="import",
        document_ids=[doc["id"]],
        folder_id=F1,
        app="knowledge-sources",
        parse=False,
    )
    db.commit()
    monkeypatch.setattr(worker, "authority", lambda *_: None)
    official = Mock()
    content = b"%PDF-native-text-fixture"
    official.pdf.return_value = content
    connector = Mock(
        return_value={
            "path": P1,
            "indexStatus": "not_requested",
            "url": "https://kb.example/?paper=x",
        }
    )
    assert worker.run_step(
        s,
        official,
        job_id=new["id"],
        app="knowledge-sources",
        extract=lambda *_: "Readable native PDF contents",
        connector=connector,
    )
    version = s.get("version", s.get("job", new["id"])["items"][0]["versionId"])
    assert s.archive_path(version).read_bytes() == content
    assert version["indexStatus"] == "not_requested"
    assert s.get("job", new["id"])["status"] == "completed"
    assert s.get("job", old["id"])["status"] == "queued"
    assert connector.call_args.args[0] == "import"
    assert connector.call_args.kwargs["parse"] is False


def test_pre_index_classification_syncs_without_copying_papers(ks, monkeypatch):
    _, db, _, _, state, _ = ks
    s, _, doc, version = saved_document(db, linked=True)
    classification = {
        "id": s.key("ks_classification", doc["id"]),
        "documentId": doc["id"],
        "folderIds": [F2],
        "removedFolderIds": [F1],
    }
    s.put("ks_classification", classification)
    db.commit()
    monkeypatch.setattr(knowledge_source_worker, "authority", lambda *_: None)
    knowledge_source_worker.synchronize_classification(
        s, {"actorSubject": "manager", "items": [{"versionId": version["id"]}]}, bridge.call
    )
    assert state["memberships"][P1] == [F2]
    assert len(state["papers"]) == 1
    assert s.archive_path(version).read_bytes() == b"%PDF-actual-retained-original"
    assert s.get("ks_classification", classification["id"])["syncedVersions"] == [version["id"]]


@pytest.mark.parametrize("index_status", ["not_requested", "pending", "failed"])
def test_receipted_import_before_core_registration_remains_an_archive(ks, index_status):
    client, db, session, _, state, calls = ks
    s, _, doc, version = saved_document(db, linked=True)
    version["indexStatus"] = index_status
    s.put("version", version)
    db.commit()
    state["papers"] = []
    state["pendingArchives"] = [
        {
            "documentId": doc["id"],
            "sha256": version["sha256"],
            "path": P1,
            "indexStatus": index_status,
        }
    ]
    data = client.get("/api/v1/knowledge-sources/snapshot", headers=session()).json()
    assert len(data["papers"]) == 1
    paper = data["papers"][0]
    assert paper["id"] == "archive:" + version["id"]
    assert paper["saved"] is True and paper["indexStatus"] == index_status
    assert paper["kbUrl"] is None
    assert calls[-1][2]["imports"] == [{"documentId": doc["id"], "sha256": version["sha256"]}]
    assert (
        client.get(paper["originalUrl"], headers=session()).content
        == b"%PDF-actual-retained-original"
    )
    body = {"paperIds": [paper["id"]], "folderIds": [F2], "mode": "add", "revision": 0}
    assert (
        client.post(
            "/api/v1/knowledge-sources/papers/folders", headers=headers(session), json=body
        ).status_code
        == 200
    )
    assert not any(op == "folderMutation" for op, _, _ in calls)
    body = {"paperId": paper["id"], "enabled": True}
    assert (
        client.post(
            "/api/v1/knowledge-sources/stars", headers=headers(session), json=body
        ).status_code
        == 200
    )
    current = client.get("/api/v1/knowledge-sources/snapshot", headers=session()).json()
    assert current["starred"] == [paper["id"]]
    assert current["papers"][0]["folderIds"] == [F1, F2]


@pytest.mark.parametrize(
    "field,value",
    [
        ("documentId", "a" * 64),
        ("sha256", "b" * 64),
        ("path", "sources/different.md"),
        ("indexStatus", "ready"),
    ],
)
def test_missing_core_path_needs_exact_nonready_receipt_proof(ks, field, value):
    client, db, session, _, state, _ = ks
    s, _, doc, version = saved_document(db, linked=True)
    version["indexStatus"] = "pending"
    s.put("version", version)
    db.commit()
    proof = {
        "documentId": doc["id"],
        "sha256": version["sha256"],
        "path": P1,
        "indexStatus": "pending",
    }
    proof[field] = value
    state["papers"] = []
    state["pendingArchives"] = [proof]
    assert (
        client.get("/api/v1/knowledge-sources/snapshot", headers=session()).json()["papers"] == []
    )
    path = f'/api/v1/knowledge-sources/documents/{doc["id"]}/versions/{version["id"]}/original'
    assert client.get(path, headers=session()).status_code == 404


def test_previously_ready_or_newly_active_paper_never_duplicates_from_stale_proof(ks):
    client, db, session, _, state, _ = ks
    s, _, doc, version = saved_document(db, linked=True)
    state["pendingArchives"] = [
        {"documentId": doc["id"], "sha256": version["sha256"], "path": P1, "indexStatus": "pending"}
    ]
    state["papers"] = []
    # Once ready, a missing Core source can be a deletion, even if a stale proof is present.
    assert (
        client.get("/api/v1/knowledge-sources/snapshot", headers=session()).json()["papers"] == []
    )
    path = f'/api/v1/knowledge-sources/documents/{doc["id"]}/versions/{version["id"]}/original'
    assert client.get(path, headers=session()).status_code == 404
    version["indexStatus"] = "pending"
    s.put("version", version)
    db.commit()
    state["papers"] = [{"path": P1, "title": "Existing Paper"}]
    data = client.get("/api/v1/knowledge-sources/snapshot", headers=session()).json()
    assert len(data["papers"]) == 1 and data["papers"][0]["id"] == P1


def test_pending_receipt_defers_classification_until_core_registers_paper(ks, monkeypatch):
    _, db, _, _, state, _ = ks
    s, _, doc, version = saved_document(db, linked=True)
    version["indexStatus"] = "not_requested"
    s.put("version", version)
    classification = {
        "id": s.key("ks_classification", doc["id"]),
        "documentId": doc["id"],
        "folderIds": [F2],
        "removedFolderIds": [F1],
    }
    s.put("ks_classification", classification)
    db.commit()
    state["papers"] = []
    state["pendingArchives"] = [
        {
            "documentId": doc["id"],
            "sha256": version["sha256"],
            "path": P1,
            "indexStatus": "not_requested",
        }
    ]
    monkeypatch.setattr(knowledge_source_worker, "authority", lambda *_: None)
    job = {"actorSubject": "manager", "items": [{"versionId": version["id"]}]}
    knowledge_source_worker.synchronize_classification(s, job, bridge.call)
    retained = s.get("ks_classification", classification["id"])
    assert "error" not in retained and not retained.get("syncedVersions")
    state["papers"] = [{"path": P1, "title": "Existing Paper"}]
    state["pendingArchives"] = []
    knowledge_source_worker.synchronize_classification(s, job, bridge.call)
    assert state["memberships"][P1] == [F2]
    assert s.get("ks_classification", classification["id"])["syncedVersions"] == [version["id"]]


def test_archive_star_survives_core_registration_and_can_be_removed(ks):
    client, db, session, _, state, _ = ks
    s, _, doc, version = saved_document(db, linked=True)
    version["indexStatus"] = "pending"
    s.put("version", version)
    db.commit()
    state["papers"] = []
    state["pendingArchives"] = [
        {"documentId": doc["id"], "sha256": version["sha256"], "path": P1, "indexStatus": "pending"}
    ]
    path = "/api/v1/knowledge-sources/stars"
    assert (
        client.post(
            path,
            headers=headers(session),
            json={"paperId": "archive:" + version["id"], "enabled": True},
        ).status_code
        == 200
    )
    state["papers"] = [{"path": P1, "title": "Existing Paper"}]
    state["pendingArchives"] = []
    version["indexStatus"] = "ready"
    s.put("version", version)
    db.commit()
    assert client.get("/api/v1/knowledge-sources/snapshot", headers=session()).json()[
        "starred"
    ] == [P1]
    assert (
        client.post(
            path, headers=headers(session), json={"paperId": P1, "enabled": False}
        ).status_code
        == 200
    )
    assert (
        client.get("/api/v1/knowledge-sources/snapshot", headers=session()).json()["starred"] == []
    )
    assert s.preferences("information-only")["knowledgeSourceStars"] == []


def test_snapshot_hides_deleted_folder_references_without_changing_originals(ks):
    client, db, session, _, state, _ = ks
    store, _, doc, version = saved_document(db)
    state["folders"] = []
    response = client.get("/api/v1/knowledge-sources/snapshot", headers=session())
    assert response.status_code == 200
    assert all(p["folderIds"] == [] for p in response.json()["papers"])
    assert store.archive_path(version).read_bytes() == b"%PDF-actual-retained-original"
    assert store.get("document", doc["id"])["folderIds"] == [F1]
