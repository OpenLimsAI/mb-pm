# ruff: noqa: F811
"""No real model calls: prove fresh document access, scope, cache, receipts and evidence."""

import json

import pytest
from fastapi import HTTPException
from test_information_live import store  # noqa: F401

from app.services import knowledge_source_research_v3 as service

ACTOR = {"subject": "alice"}
PAPERS = [
    {"id": "sources/one.md", "title": "First", "folderIds": ["f"]},
    {"id": "sources/two.md", "title": "Second", "folderIds": ["f"]},
]
FOLDERS = [{"id": "f", "name": "Research"}]


@pytest.fixture
def research_fixture(monkeypatch):
    version = {"hash": "hash1", "revision": 1}
    calls, reads = [], []
    monkeypatch.setattr(
        service.knowledge_ai,
        "models",
        lambda *_: {
            "models": [{"id": "system", "available": True}],
            "default_model_id": "system",
            "revision": version["revision"],
        },
    )

    def complete(db, claims, payload):
        calls.append(payload)
        return {
            "model": "test-provider",
            "choices": [
                {
                    "message": {
                        "content": json.dumps(
                            {"answer": "结论 [E1]", "citations": ["E1"], "suggestions": []}
                        )
                    }
                }
            ],
            "usage": {"prompt_tokens": 51, "completion_tokens": 15, "total_tokens": 66},
        }

    monkeypatch.setattr(service.knowledge_ai, "complete", complete)

    def connect(operation, subject, **kwargs):
        assert operation == "readPaper" and subject == "alice"
        reads.append(kwargs["path"])
        return {
            "body": "Verified source paragraph.\n\nSecond paragraph.",
            "hash": version["hash"],
            "metadata": {"doi": "10.1234/test"},
            "url": "/read?paper=" + kwargs["path"],
        }

    return version, calls, reads, connect


def run(s, connect, **changes):
    return service.research(
        s,
        ACTOR,
        {"sub": "alice"},
        {"mode": "ask", "paperIds": [PAPERS[0]["id"]], "question": "What is verified?", **changes},
        papers=PAPERS,
        folders=FOLDERS,
        connect=connect,
    )


def test_cache_is_owner_model_revision_and_content_bound_with_fresh_access(store, research_fixture):
    s, _ = store
    version, calls, reads, connect = research_fixture
    first = run(s, connect)
    assert first["usage"]["total_tokens"] == 66 and first["cost"] is None
    assert first["evidence"][0]["excerpts"][0]["offset"] == 0
    cached = run(s, connect)
    assert cached["cached"] and not cached["providerCalledThisRequest"] and len(calls) == 1
    assert len(reads) == 3
    version["hash"] = "hash2"
    assert not run(s, connect)["cached"] and len(calls) == 2
    version["revision"] = 2
    run(s, connect)
    assert len(calls) == 3
    assert len(s.records("ks_research_call")) == 3


def test_cached_result_never_bypasses_revoked_document_access(store, research_fixture):
    s, _ = store
    _, calls, _, connect = research_fixture
    run(s, connect)

    def denied(*args, **kwargs):
        raise HTTPException(403, "revoked")

    with pytest.raises(HTTPException) as result:
        run(s, denied)
    assert result.value.status_code == 403 and len(calls) == 1


def test_folder_scope_and_missing_body_fail_before_model(store, research_fixture):
    s, _ = store
    _, calls, _, connect = research_fixture
    for changes in [
        {"paperIds": ["hidden"]},
        {"folderId": "gone"},
        {"paperIds": [], "folderId": None},
        {"mode": "compare"},
    ]:
        with pytest.raises(HTTPException):
            run(s, connect, **changes)
    with pytest.raises(HTTPException) as empty:
        run(s, lambda *args, **kwargs: {"body": "", "hash": "h"})
    assert empty.value.status_code == 422 and calls == []


def test_invalid_evidence_keeps_real_token_receipt_and_releases_lease(
    store, research_fixture, monkeypatch
):
    s, _ = store
    _, _, _, connect = research_fixture
    monkeypatch.setattr(
        service.knowledge_ai,
        "complete",
        lambda *args: {
            "model": "real-model",
            "choices": [{"message": {"content": '{"answer":"伪造 [E99]","citations":["E99"]}'}}],
            "usage": {"total_tokens": 77},
        },
    )
    with pytest.raises(HTTPException) as invalid:
        run(s, connect)
    assert invalid.value.status_code == 502
    receipt = s.records("ks_research_call")[-1]
    assert receipt["status"] == "failed_validation" and receipt["usage"]["total_tokens"] == 77
    assert s.records("ks_research") == []
    lease = service._acquire(s, ACTOR["subject"])
    with pytest.raises(HTTPException) as occupied:
        service._acquire(s, ACTOR["subject"])
    assert occupied.value.status_code == 409
    service._release(s, lease)


def test_classification_rejects_unknown_folders_and_wrong_paper_evidence():
    evidence = [{"id": "E1", "paperId": "sources/one.md"}]
    for suggestion in [
        {"paperId": "sources/one.md", "folderIds": ["gone"], "evidenceIds": ["E1"]},
        {"paperId": "sources/two.md", "folderIds": ["f"], "evidenceIds": ["E1"]},
    ]:
        raw = json.dumps({"answer": "理由 [E1]", "citations": ["E1"], "suggestions": [suggestion]})
        with pytest.raises(HTTPException):
            service._parse_response(raw, evidence, PAPERS, FOLDERS, "classify")


def test_hourly_limit_and_single_flight_do_not_use_collector_lease(store, research_fixture):
    s, _ = store
    _, calls, _, connect = research_fixture
    for i in range(20):
        s.put(
            "ks_research_call",
            {
                "id": s.key("ks_research_call", str(i)),
                "subject": "alice",
                "timestamp": service.time.time(),
            },
        )
    s.db.commit()
    with pytest.raises(HTTPException) as limited:
        run(s, connect)
    assert limited.value.status_code == 429 and not calls


def test_access_revoked_during_model_turn_is_not_returned_or_cached(
    store, research_fixture, monkeypatch
):
    s, _ = store
    _, _, _, connect = research_fixture
    count = 0

    def revoked_after(*args, **kwargs):
        nonlocal count
        count += 1
        if count > 1:
            raise HTTPException(403, "access revoked during generation")
        return connect(*args, **kwargs)

    with pytest.raises(HTTPException) as revoked:
        run(s, revoked_after)
    assert revoked.value.status_code == 403
    assert s.records("ks_research") == []
    assert s.records("ks_research_call")[-1]["usage"]["total_tokens"] == 66


def test_large_folder_research_retrieves_relevant_evidence_not_first_twenty(
    store, research_fixture
):
    s, _ = store
    _, calls, _, connect = research_fixture
    all_papers = [
        {"id": "sources/" + str(i) + ".md", "title": "Paper " + str(i), "folderIds": ["f"]}
        for i in range(300)
    ]

    def retrieve(operation, subject, **values):
        if operation == "retrieveLibrary":
            assert values["folderIds"] == ["f"] and values["limit"] == 20
            return {
                "totalCandidates": 300,
                "matchedPapers": 1,
                "searchIndex": {"complete": True},
                "incomplete": False,
                "evidence": [
                    {
                        "path": "sources/299.md",
                        "title": "Relevant last paper",
                        "hash": "hash1",
                        "offset": 410,
                        "text": "Relevant actual paragraph",
                    }
                ],
            }
        return connect(operation, subject, **values)

    result = service.research(
        s,
        ACTOR,
        {"sub": "alice"},
        {"mode": "ask", "folderId": "f", "paperIds": [], "question": "Relevant"},
        papers=all_papers,
        folders=FOLDERS,
        connect=retrieve,
    )
    assert result["scope"]["paperIds"] == ["sources/299.md"]
    assert result["evidence"][0]["excerpts"][0]["offset"] == 410
    prompt = json.loads(calls[0].messages[1].content)
    assert prompt["evidence"][0]["excerpts"][0]["text"] == "Relevant actual paragraph"
    assert result["retrieval"]["totalCandidates"] == 300


def test_folder_without_matching_evidence_does_not_call_provider(store, research_fixture):
    s, _ = store
    _, calls, _, _ = research_fixture

    def retrieve(operation, subject, **values):
        assert operation == "retrieveLibrary"
        return {
            "evidence": [],
            "totalCandidates": 2,
            "matchedPapers": 0,
            "incomplete": True,
            "searchIndex": {"indexing": True},
        }

    result = run(s, retrieve, paperIds=[], folderId="f")
    assert result["noEvidence"] and not result["providerCalledThisRequest"] and not calls
    assert result["retrieval"]["incomplete"]


def test_long_research_question_is_not_sent_as_short_reader_highlight_query(
    store, research_fixture
):
    s, _ = store
    _, calls, _, original = research_fixture

    def connect(operation, subject, **values):
        assert len(values.get("query", "")) <= 500
        return original(operation, subject, **values)

    question = "How does this verified evidence apply? " * 40
    result = run(s, connect, question=question)
    assert (
        result["answer"]
        and json.loads(calls[0].messages[1].content)["question"] == question.strip()
    )


@pytest.mark.parametrize("change_during_model", ["none", "revoke", "reparse"])
def test_pending_original_research_checks_signed_receipt_again_before_returning(
    store, research_fixture, monkeypatch, change_during_model
):
    s, _ = store
    _, calls, _, _ = research_fixture
    s.put("document", {"id": "manual-doc", "title": "Uploaded evidence"})
    version = s.archive(
        "manual-doc", b"%PDF-verified", "Verified original paragraph.", parse_status="ready"
    )
    version.update(kbPath="sources/manual.md", kbDocumentId="kb-receipt", kbPending=True)
    s.put("version", version)
    s.db.commit()
    paper = {
        "id": "archive:" + version["id"],
        "versionId": version["id"],
        "documentId": "manual-doc",
        "title": "Uploaded evidence",
        "folderIds": ["f"],
    }
    permitted, reads = {"value": True}, []

    def connect(operation, subject, **values):
        assert operation == "librarySummary" and subject == "alice"
        reads.append(operation)
        if not permitted["value"]:
            raise HTTPException(403, "revoked")
        return {
            "pendingArchives": [
                {
                    "documentId": "kb-receipt",
                    "sha256": version["sha256"],
                    "path": "sources/manual.md",
                    "indexStatus": "not_requested",
                }
            ]
        }

    original_complete = service.knowledge_ai.complete

    def complete(*args):
        result = original_complete(*args)
        if change_during_model == "revoke":
            permitted["value"] = False
        elif change_during_model == "reparse":
            s.put("version", {**version, "text": "Newly parsed replacement text."})
            s.db.commit()
        return result

    monkeypatch.setattr(service.knowledge_ai, "complete", complete)

    def request():
        return service.research(
            s,
            ACTOR,
            {"sub": "alice"},
            {"mode": "ask", "paperIds": [paper["id"]], "question": "Verified?"},
            papers=[paper],
            folders=FOLDERS,
            connect=connect,
        )

    if change_during_model != "none":
        with pytest.raises(HTTPException) as error:
            request()
        assert error.value.status_code == (403 if change_during_model == "revoke" else 409)
        assert s.records("ks_research_call")[0]["status"] == "failed_validation"
        assert not s.records("ks_research")
    else:
        result = request()
        assert result["evidence"][0]["excerpts"][0]["text"] == "Verified original paragraph."
        assert request()["cached"]
        permitted["value"] = False
        with pytest.raises(HTTPException) as error:
            request()
        assert error.value.status_code == 403 and len(calls) == 1
    assert len(reads) >= 2


def test_core_evidence_offsets_select_the_actual_text_in_utf16_reader(store):
    s, _ = store
    body = "𝛼 introduction.\n\nRelevant evidence with 𝛽."

    def connect(*args, **values):
        return {"body": body, "hash": "actual-body-hash"}

    evidence = service.evidence_for(s, ACTOR, PAPERS[0], connect, "Relevant")
    encoded = body.encode("utf-16-le")
    for excerpt in evidence["excerpts"]:
        selected = encoded[
            excerpt["offset"] * 2 : (excerpt["offset"] + excerpt["length"]) * 2
        ].decode("utf-16-le")
        assert selected == excerpt["text"]
    assert evidence["excerpts"][1]["offset"] == 18
