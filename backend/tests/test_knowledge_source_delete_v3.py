# ruff: noqa: F811
"""Deletion bridge contract; no actual customer files or Core service."""

import pytest
from test_information_api import live  # noqa: F401
from test_information_live import catalogue, store  # noqa: F401
from test_information_portal import information_portal  # noqa: F401
from test_knowledge_sources import headers, ks  # noqa: F401

from app.services.information import bridge

ROOT = "/api/v1/knowledge-sources/v3/library"
PLAN = "12345678-1234-1234-1234-123456789012"
PATH = "sources/a.md"


@pytest.fixture
def deletion(ks, monkeypatch):
    client, db, session, role, state, calls = ks

    def connect(operation, subject, **values):
        calls.append((operation, subject, values))
        if operation == "deletePaperPreview":
            return {
                "planId": PLAN,
                "path": PATH,
                "title": "A",
                "expiresAt": "2026-12-01T00:00:00Z",
                "pages": [],
                "sharedCount": 0,
                "unverifiedCount": 0,
            }
        return {"operationId": PLAN, "path": PATH, "status": "running", "completed": 0, "total": 1}

    monkeypatch.setattr(bridge, "call", connect)
    return client, session, calls


def test_preview_confirm_and_status_forward_only_exact_authenticated_values(deletion):
    client, session, calls = deletion
    preview = client.post(
        ROOT + "/delete-preview", headers=headers(session), json={"paperId": PATH}
    )
    assert preview.status_code == 200 and preview.json()["planId"] == PLAN
    result = client.post(
        ROOT + "/delete", headers=headers(session), json={"paperId": PATH, "planId": PLAN}
    )
    assert result.status_code == 200 and result.json()["status"] == "running"
    status = client.get(ROOT + "/delete-status", headers=session(), params={"operationId": PLAN})
    assert status.status_code == 200 and status.json()["operationId"] == PLAN
    assert [(op, values) for op, _, values in calls] == [
        ("deletePaperPreview", {"path": PATH}),
        ("deletePaper", {"path": PATH, "planId": PLAN}),
        ("deletePaperStatus", {"operationId": PLAN}),
    ]
    assert len({subject for _, subject, _ in calls}) == 1


@pytest.mark.parametrize(
    "paper",
    [
        "archive:abc",
        "sources/../secret.md",
        "knowledge/a.md",
        "sources/a\\b.md",
        "sources/a.md\x00",
        "sources//a.md",
    ],
)
def test_invalid_or_unregistered_paths_do_not_reach_bridge(deletion, paper):
    client, session, calls = deletion
    assert (
        client.post(
            ROOT + "/delete-preview", headers=headers(session), json={"paperId": paper}
        ).status_code
        == 422
    )
    assert calls == []


def test_delete_requires_origin_session_and_strict_plan_id(deletion):
    client, session, calls = deletion
    assert client.post(ROOT + "/delete-preview", json={"paperId": PATH}).status_code == 401
    assert (
        client.post(ROOT + "/delete-preview", headers=session(), json={"paperId": PATH}).status_code
        == 403
    )
    assert (
        client.post(
            ROOT + "/delete", headers=headers(session), json={"paperId": PATH, "planId": "invalid"}
        ).status_code
        == 422
    )
    assert (
        client.post(
            ROOT + "/delete",
            headers=headers(session),
            json={"paperId": PATH, "planId": PLAN, "subject": "someone-else"},
        ).status_code
        == 422
    )
    assert (
        client.get(
            ROOT + "/delete-status", headers=session(), params={"operationId": "bad"}
        ).status_code
        == 422
    )
    assert calls == []


def test_deleted_owner_or_stale_plan_errors_remain_explicit(deletion, monkeypatch):
    client, session, _ = deletion
    for code in (403, 409):

        def denied(*args, code=code, **kwargs):
            raise bridge.BridgeError(code, "No longer allowed")

        monkeypatch.setattr(bridge, "call", denied)
        result = client.post(
            ROOT + "/delete", headers=headers(session), json={"paperId": PATH, "planId": PLAN}
        )
        assert result.status_code == code


def test_expired_plan_keeps_explicit_code_for_safe_repreview(deletion, monkeypatch):
    client, session, _ = deletion

    def expired(*args, **kwargs):
        raise bridge.BridgeError(409, "Plan expired", "paper_delete_plan_expired")

    monkeypatch.setattr(bridge, "call", expired)
    result = client.post(
        ROOT + "/delete", headers=headers(session), json={"paperId": PATH, "planId": PLAN}
    )
    assert result.status_code == 409
    assert result.json()["detail"]["code"] == "paper_delete_plan_expired"
