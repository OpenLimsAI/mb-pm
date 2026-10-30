"""Selected-text editing is owner-only, does not invent evidence or save the report."""

import json

import pytest
import test_solutions
from sqlalchemy import select
from test_solution_ai import FAKE_KEY, profile, save
from test_solutions import PREFIX, create

from app.models.solution import KnowledgeSolution, SolutionAnswer
from app.services import ai, solution_ai, solutions

solution_client = test_solutions.solution_client


def polish(f, report, **changes):
    return f.client.post(
        f"{PREFIX}/{report['id']}/polish",
        json={"section_id": "goal", "text": "在 pH 5.5 条件下，尚需验证稳定性 [1]。", **changes},
    )


def test_personal_model_polishes_only_supplied_text_and_never_saves_report(
    solution_client, monkeypatch
):
    f = solution_client
    report = create(f)
    assert save(f).status_code == 200
    calls = []

    def chat(cfg, messages, **kwargs):
        calls.append((cfg, messages, kwargs))
        return "在 pH 5.5 条件下，稳定性仍需验证 [1]。", {}

    monkeypatch.setattr(solution_ai, "chat", chat)
    monkeypatch.setattr(solutions, "retrieve", lambda *_: pytest.fail("polish must not retrieve"))
    response = polish(f, report, instruction="更简洁")
    assert response.status_code == 200, response.text
    assert response.json() == {
        "content": "在 pH 5.5 条件下，稳定性仍需验证 [1]。",
        "model": "research-test",
        "mode": "ai",
    }
    cfg, messages, kwargs = calls[0]
    assert cfg["api_key"] == FAKE_KEY
    assert kwargs == {"timeout": 60}
    assert "严禁新增事实" in messages[0]["content"]
    assert json.loads(messages[1]["content"]) == {
        "text": "在 pH 5.5 条件下，尚需验证稳定性 [1]。",
        "preference": "更简洁",
    }
    row = f.db.get(KnowledgeSolution, report["id"])
    assert row.revision == report["revision"]
    assert row.sections == report["sections"]
    assert f.db.scalars(select(SolutionAnswer)).all() == []
    assert FAKE_KEY not in response.text


def test_explicit_model_uses_same_personal_configuration(solution_client, monkeypatch):
    f = solution_client
    report = create(f)
    assert save(f, [profile(), profile(id="review-model", model="review-id")]).status_code == 200
    seen = []
    monkeypatch.setattr(
        solution_ai,
        "chat",
        lambda cfg, *_args, **_kwargs: (seen.append(cfg["model"]) or "润色后的文字", {}),
    )
    assert polish(f, report, model_profile_id="review-model").status_code == 200
    assert seen == ["review-id"]


def test_system_model_and_unconfigured_model(solution_client, monkeypatch):
    f = solution_client
    report = create(f)
    assert polish(f, report, model_profile_id="system").status_code == 422
    monkeypatch.setattr(
        ai,
        "load_settings",
        lambda: {"provider": "ollama", "providers": {"ollama": {"model": "local-editor"}}},
    )
    calls = []
    monkeypatch.setattr(
        ai,
        "chat",
        lambda provider, *_args, **_kwargs: (calls.append(provider) or "润色后的文字", {}),
    )
    response = polish(f, report, model_profile_id="system")
    assert response.status_code == 200
    assert response.json()["model"] == "local-editor"
    assert calls == ["ollama"]


@pytest.mark.parametrize(
    "changes",
    [
        {"text": " "},
        {"text": "a" * 5001},
        {"section_id": "unknown"},
        {"instruction": "a" * 1001},
        {"model_profile_id": "retrieval"},
    ],
)
def test_rejects_invalid_selection_without_model_calls(solution_client, monkeypatch, changes):
    f = solution_client
    report = create(f)
    monkeypatch.setattr(
        solution_ai, "chat", lambda *_args, **_kwargs: pytest.fail("invalid selection")
    )
    assert polish(f, report, **changes).status_code == 422


def test_other_account_missing_model_and_frozen_report(solution_client, monkeypatch):
    f = solution_client
    report = create(f)
    assert polish(f, report, model_profile_id="missing").status_code == 404
    f.login("other")
    assert polish(f, report).status_code == 404
    f.login()
    row = f.db.get(KnowledgeSolution, report["id"])
    row.status = "in_review"
    f.db.commit()
    assert polish(f, report).status_code == 409


@pytest.mark.parametrize("result", ["", "a" * 16001, None])
def test_invalid_provider_result_or_failure_keeps_original(solution_client, monkeypatch, result):
    f = solution_client
    report = create(f)
    assert save(f).status_code == 200

    def chat(*_args, **_kwargs):
        if result is None:
            raise ai.AIError("secret upstream details " + FAKE_KEY)
        return result, {}

    monkeypatch.setattr(solution_ai, "chat", chat)
    response = polish(f, report)
    assert response.status_code == 503
    assert FAKE_KEY not in response.text
    assert f.db.get(KnowledgeSolution, report["id"]).sections == report["sections"]


def test_evidence_access_is_rechecked_after_generation(solution_client, monkeypatch):
    f = solution_client
    report = create(f)
    assert save(f).status_code == 200
    seen = []
    monkeypatch.setattr(solution_ai, "chat", lambda *_args, **_kwargs: ("润色结果", {}))
    monkeypatch.setattr(solutions, "check_solution_evidence", lambda *_args: seen.append(True))
    assert polish(f, report).status_code == 200
    assert len(seen) == 2


def test_polish_requires_same_origin_and_session(solution_client):
    f = solution_client
    report = create(f)
    f.client.headers["Origin"] = "https://outside.invalid"
    assert polish(f, report).status_code == 403
    f.client.headers["Origin"] = str(f.client.base_url).rstrip("/")
    f.client.cookies.clear()
    assert polish(f, report).status_code == 401
