"""Private model configuration uses isolated SQLite and mocked model calls only."""

import importlib.util
import json
from pathlib import Path

import pytest
import test_solutions
from fastapi import HTTPException
from sqlalchemy import create_engine, inspect, select
from sqlalchemy.orm import Session
from test_solutions import PREFIX, add_source, create, question

from app.core import security
from app.core.config import settings
from app.db.base import Base
from app.models.solution import SolutionAnswer
from app.models.solution_ai import SolutionAISettings
from app.schemas.solution_ai import ModelSettingsInput
from app.services import ai, password_policy, solution_ai

SETTINGS = PREFIX + "/ai/settings"
TEST = PREFIX + "/ai/test"
FAKE_KEY = "fake-private-model-secret-for-tests"
solution_client = test_solutions.solution_client


def profile(**changes):
    return {
        "id": "personal-model-1",
        "name": "个人研究模型",
        "provider": "deepseek",
        "base_url": "https://model.example/v1",
        "model": "research-test",
        "api_key": FAKE_KEY,
        **changes,
    }


def save(f, profiles=None, *, revision=0, default="personal-model-1"):
    return f.client.put(
        SETTINGS,
        json={
            "profiles": profiles if profiles is not None else [profile()],
            "revision": revision,
            "default_profile_id": default,
        },
    )


def claims(subject="author", issuer=None):
    return {"iss": issuer or settings.casdoor_issuer, "sub": subject}


def stored(f):
    row = f.db.get(SolutionAISettings, (settings.casdoor_issuer, "author"))
    return security.unseal(row.encrypted_payload)


def test_private_settings_initial_encrypted_and_whitelisted(solution_client):
    f = solution_client
    assert f.client.get(SETTINGS).json() == {
        "profiles": [],
        "default_profile_id": None,
        "revision": 0,
    }
    response = save(f)
    assert response.status_code == 200
    assert response.json()["revision"] == 1
    assert response.json()["profiles"][0]["key_set"] is True
    assert set(response.json()["profiles"][0]) == {
        "id",
        "name",
        "provider",
        "base_url",
        "model",
        "key_set",
    }
    assert FAKE_KEY not in response.text
    assert FAKE_KEY not in f.client.get(SETTINGS).text
    row = f.db.get(SolutionAISettings, (settings.casdoor_issuer, "author"))
    assert FAKE_KEY not in row.encrypted_payload
    assert "model.example" not in row.encrypted_payload
    assert stored(f)["profiles"][0]["api_key"] == FAKE_KEY


def test_identity_and_issuer_isolation(solution_client):
    f = solution_client
    assert save(f).status_code == 200
    f.login("other")
    assert f.client.get(SETTINGS).json()["profiles"] == []
    with pytest.raises(HTTPException) as error:
        solution_ai.select_model(f.db, claims("other"), "personal-model-1")
    assert error.value.status_code == 404
    assert solution_ai.settings(f.db, claims(issuer="https://other-issuer"))["revision"] == 0
    # The same arbitrary ID is independent under another issuer, including its key.
    other = ModelSettingsInput(profiles=[profile(api_key="other-fake-key")], revision=0)
    solution_ai.save_settings(f.db, claims(issuer="https://other-issuer"), other)
    assert (
        solution_ai.select_model(f.db, claims(), "personal-model-1")["config"]["api_key"]
        == FAKE_KEY
    )
    assert save(f, [profile(api_key="second-fake-key")]).status_code == 200
    f.login()
    assert stored(f)["profiles"][0]["api_key"] == FAKE_KEY


def test_revision_prevents_overwrite_and_deletion_persists(solution_client):
    f = solution_client
    assert save(f).json()["revision"] == 1
    assert save(f, [profile(name="stale")]).status_code == 409
    assert f.client.get(SETTINGS).json()["profiles"][0]["name"] == "个人研究模型"
    assert save(f, [], revision=1, default=None).json()["revision"] == 2
    assert f.client.get(SETTINGS).json()["profiles"] == []


def test_database_compare_and_swap_rejects_a_stale_session(token_factory, tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'model-conflict.db'}")
    Base.metadata.create_all(engine)
    with Session(engine, expire_on_commit=False) as stale, Session(engine) as writer:
        initial = ModelSettingsInput(profiles=[profile()], revision=0)
        solution_ai.save_settings(stale, claims(), initial)
        cached = stale.get(SolutionAISettings, (settings.casdoor_issuer, "author"))
        current = ModelSettingsInput(profiles=[profile(name="current")], revision=1)
        solution_ai.save_settings(writer, claims(), current)
        assert cached.revision == 1
        with pytest.raises(HTTPException) as error:
            solution_ai.save_settings(stale, claims(), current)
        assert error.value.status_code == 409
        assert solution_ai.settings(writer, claims())["revision"] == 2
        assert solution_ai.settings(writer, claims())["profiles"][0]["name"] == "current"
    engine.dispose()


@pytest.mark.parametrize(
    "change,expected",
    [
        ({"api_key": None}, FAKE_KEY),
        ({"api_key": "  "}, FAKE_KEY),
        ({"api_key": "", "name": "新名称", "model": "new-model"}, FAKE_KEY),
        ({"api_key": "", "base_url": "https://MODEL.example/v1/"}, FAKE_KEY),
        ({"api_key": "", "clear_key": True}, ""),
        ({"api_key": "new-fake-key", "clear_key": True}, ""),
        ({"api_key": "", "base_url": "https://other.example/v1"}, ""),
        ({"api_key": "", "provider": "glm"}, ""),
        ({"api_key": "new-fake-key", "provider": "glm"}, "new-fake-key"),
    ],
)
def test_key_retention_rules(solution_client, change, expected):
    f = solution_client
    assert save(f).status_code == 200
    response = save(f, [profile(**change)], revision=1)
    assert response.status_code == 200
    assert stored(f)["profiles"][0]["api_key"] == expected
    assert response.json()["profiles"][0]["key_set"] is bool(expected)


def test_omitted_key_is_preserved_and_same_provider_can_repeat(solution_client):
    f = solution_client
    assert save(f).status_code == 200
    draft = profile()
    draft.pop("api_key")
    response = save(f, [draft, profile(id="model-2", api_key="")], revision=1)
    assert response.status_code == 200
    assert [p["key_set"] for p in response.json()["profiles"]] == [True, False]


@pytest.mark.parametrize(
    "patch",
    [
        {"profiles": [profile(), profile()]},
        {"profiles": [profile(id="system")]},
        {"profiles": [profile(id="retrieval")]},
        {"profiles": [profile(base_url="https://u:secret@model.example")]},
        {"profiles": [profile(base_url="http://169.254.169.254")]},
        {"profiles": [profile(provider="unknown")]},
        {"profiles": [profile(name=" ")]},
        {"profiles": [profile(model="m" * 161)]},
        {"profiles": [profile(api_key=FAKE_KEY + "\nheader: value")]},
        {"profiles": [profile(api_key=FAKE_KEY * 100)]},
        {"profiles": [profile(id=f"model-{n}") for n in range(21)]},
        {"default_profile_id": "not-mine"},
        {"revision": -1},
        {"profiles": [profile(key_set=True)]},
    ],
)
def test_validation_never_echoes_secret(solution_client, patch):
    f = solution_client
    payload = {
        "profiles": [profile()],
        "revision": 0,
        "default_profile_id": "personal-model-1",
        **patch,
    }
    response = f.client.put(SETTINGS, json=payload)
    assert response.status_code == 422
    assert FAKE_KEY not in response.text
    assert "input" not in response.text
    assert f.client.get(SETTINGS).json()["revision"] == 0


def test_test_validation_and_malformed_json_are_redacted(solution_client):
    f = solution_client
    response = f.client.post(TEST, json={"profile": profile(base_url="bad")})
    assert response.status_code == 422 and FAKE_KEY not in response.text
    response = f.client.put(
        SETTINGS, content='{"api_key": "' + FAKE_KEY, headers={"Content-Type": "application/json"}
    )
    assert response.status_code == 422 and FAKE_KEY not in response.text


def test_authentication_same_origin_and_password_policy(solution_client, monkeypatch):
    f = solution_client
    monkeypatch.setattr(solution_ai, "chat", lambda *_a, **_kw: pytest.fail("must not call model"))
    f.client.cookies.clear()
    assert f.client.get(SETTINGS).status_code == 401
    assert save(f).status_code == 401
    assert f.client.post(TEST, json={"profile": profile()}).status_code == 401
    f.login()
    for method, path, payload in [
        ("put", SETTINGS, {"profiles": [], "revision": 0}),
        ("post", TEST, {"profile": profile()}),
    ]:
        assert (
            getattr(f.client, method)(
                path, json=payload, headers={"Origin": "https://evil.example"}
            ).status_code
            == 403
        )
    f.client.headers.pop("Origin")
    assert save(f).status_code == 403
    f.client.headers["Origin"] = settings.portal_origin
    password_policy.require_change(f.db, "author", "reset")
    assert f.client.get(SETTINGS).status_code == 403
    assert save(f).status_code == 403
    assert f.client.post(TEST, json={"profile": profile()}).status_code == 403


def test_storage_encryption_errors_are_safe(solution_client, monkeypatch):
    f = solution_client
    assert save(f).status_code == 200
    row = f.db.get(SolutionAISettings, (settings.casdoor_issuer, "author"))
    row.encrypted_payload = "damaged-" + FAKE_KEY
    f.db.commit()
    response = f.client.get(SETTINGS)
    assert response.status_code == 503 and FAKE_KEY not in response.text
    row.encrypted_payload = security.seal({"profiles": [{"api_key": FAKE_KEY}]})
    f.db.commit()
    response = f.client.get(SETTINGS)
    assert response.status_code == 503 and FAKE_KEY not in response.text
    monkeypatch.setattr(settings, "APP_SECRET", "")
    with pytest.raises(HTTPException) as error:
        solution_ai.save_settings(
            f.db, claims("new-person"), ModelSettingsInput(profiles=[profile()], revision=0)
        )
    assert error.value.status_code == 503
    assert "IAM" not in error.value.detail


def test_connection_is_explicit_fixed_prompt_unsaved_and_whitelisted(solution_client, monkeypatch):
    f = solution_client
    calls = []
    monkeypatch.setattr(
        solution_ai,
        "chat",
        lambda cfg, messages, **kw: calls.append((cfg, messages, kw))
        or ("provider output contains " + FAKE_KEY, {}),
    )
    assert save(f).status_code == 200
    assert calls == []
    response = f.client.post(TEST, json={"profile": profile(api_key="", name="draft name")})
    assert response.status_code == 200
    assert set(response.json()) == {"ok", "model", "ms"}
    assert FAKE_KEY not in response.text
    assert calls[0][0]["api_key"] == FAKE_KEY
    assert calls[0][1] == [{"role": "user", "content": "连接测试。请只回复：连接成功。"}]
    assert calls[0][2] == {"timeout": 25}
    assert f.client.get(SETTINGS).json()["profiles"][0]["name"] == "个人研究模型"
    assert f.client.get(SETTINGS).json()["revision"] == 1
    assert (
        f.client.post(
            TEST, json={"profile": profile(api_key="", base_url="https://changed.example")}
        ).status_code
        == 422
    )
    assert len(calls) == 1


@pytest.mark.parametrize("provider", ["deepseek", "minimax", "glm", "openai"])
def test_keyless_cloud_saves_but_test_and_ask_reject(solution_client, monkeypatch, provider):
    f = solution_client
    monkeypatch.setattr(solution_ai, "chat", lambda *_a, **_kw: pytest.fail("must not call model"))
    assert save(f, [profile(provider=provider, api_key="")]).status_code == 200
    assert (
        f.client.post(TEST, json={"profile": profile(provider=provider, api_key="")}).status_code
        == 422
    )
    doc = create(f)
    assert question(f, doc).status_code == 422


def test_custom_keyless_connection_and_error_redaction(solution_client, monkeypatch):
    f = solution_client
    monkeypatch.setattr(solution_ai, "chat", lambda *_a, **_kw: ("OK", {}))
    response = f.client.post(
        TEST,
        json={
            "profile": profile(provider="custom", api_key="", base_url="http://127.0.0.1:11434/v1")
        },
    )
    assert response.status_code == 200

    def failed(*_a, **_kw):
        raise ai.AIError("upstream request Authorization: " + FAKE_KEY)

    monkeypatch.setattr(solution_ai, "chat", failed)
    response = f.client.post(TEST, json={"profile": profile()})
    assert response.status_code == 503
    assert FAKE_KEY not in response.text and "Authorization" not in response.text


@pytest.mark.parametrize("provider", ["deepseek", "minimax", "glm", "openai", "custom"])
def test_all_private_providers_use_minimal_compatible_body(monkeypatch, provider):
    calls = []

    def request(actual_provider, cfg, path, body, **kw):
        calls.append((actual_provider, cfg, path, body, kw))
        return {"choices": [{"message": {"content": "OK"}}]}

    monkeypatch.setattr(solution_ai, "pinned_request", request)
    cfg = profile(provider=provider)
    messages = [{"role": "user", "content": "test"}]
    assert solution_ai.chat(cfg, messages, timeout=25)[0] == "OK"
    assert calls == [
        (
            "custom",
            cfg,
            "/chat/completions",
            {
                "model": "research-test",
                "messages": messages,
                "stream": False,
            },
            {"timeout": 25},
        )
    ]


def test_ask_default_and_explicit_private_models_with_valid_evidence(solution_client, monkeypatch):
    f = solution_client
    add_source(f)
    doc = create(f)
    profiles = [profile(), profile(id="model-2", provider="glm", model="second-model")]
    assert save(f, profiles).status_code == 200
    calls = []

    def answer(cfg, messages, **kw):
        calls.append((cfg, messages, kw))
        return "研究条件需复核 [1]", {}

    monkeypatch.setattr(solution_ai, "chat", answer)
    monkeypatch.setattr(ai, "load_settings", lambda: pytest.fail("private must not load global"))
    first = question(f, doc)
    assert first.status_code == 200 and first.json()["mode"] == "ai"
    assert first.json()["model"] == "research-test"
    second = question(f, doc, model_profile_id="model-2")
    assert second.status_code == 200 and second.json()["model"] == "second-model"
    assert [entry[0]["model"] for entry in calls] == ["research-test", "second-model"]
    assert calls[0][2] == {"timeout": 60}
    prompt = json.loads(calls[0][1][1]["content"])
    assert prompt["evidence"][0]["source_id"] == first.json()["references"][0]["source_id"]
    history = f.client.get(f"{PREFIX}/{doc['id']}/history")
    assert FAKE_KEY not in history.text
    assert {item["model"] for item in history.json()} == {"research-test", "second-model"}


def test_system_compatibility_and_retrieval_override(solution_client, monkeypatch):
    f = solution_client
    add_source(f)
    doc = create(f)
    cfg = {"model": "global-test", "api_key": "global-fake-key"}
    monkeypatch.setattr(
        ai, "load_settings", lambda: {"provider": "deepseek", "providers": {"deepseek": cfg}}
    )
    calls = []
    monkeypatch.setattr(
        ai,
        "chat",
        lambda provider, actual, *_a, **_kw: calls.append((provider, actual)) or ("global [1]", {}),
    )
    assert question(f, doc).json()["model"] == "global-test"
    assert save(f, [profile(api_key="")]).status_code == 200
    assert question(f, doc, model_profile_id="system").json()["model"] == "global-test"
    assert calls == [("deepseek", cfg), ("deepseek", cfg)]
    monkeypatch.setattr(ai, "load_settings", lambda: pytest.fail("retrieval must not load global"))
    monkeypatch.setattr(
        solution_ai, "_load", lambda *_a: pytest.fail("retrieval must not load private")
    )
    response = question(f, doc, model_profile_id="retrieval")
    assert response.status_code == 200 and response.json()["mode"] == "retrieval"
    assert "本次选择仅检索" in response.json()["content"]


def test_unknown_or_other_users_model_rejected_even_without_evidence(solution_client, monkeypatch):
    f = solution_client
    assert save(f).status_code == 200
    f.login("other")
    doc = create(f)
    monkeypatch.setattr(solution_ai, "chat", lambda *_a, **_kw: pytest.fail("no model request"))
    for selected in ("personal-model-1", "missing"):
        assert question(f, doc, model_profile_id=selected).status_code == 404
    assert f.db.scalars(select(SolutionAnswer)).all() == []


def test_no_evidence_skips_model_and_generation_failures_do_not_persist(
    solution_client, monkeypatch
):
    f = solution_client
    assert save(f).status_code == 200
    doc = create(f)
    monkeypatch.setattr(
        solution_ai, "chat", lambda *_a, **_kw: pytest.fail("no evidence no request")
    )
    response = question(f, doc)
    assert response.status_code == 200 and response.json()["references"] == []
    assert response.json()["mode"] == "retrieval"
    add_source(f)
    for text in ("no valid references", "incorrect citation [99]"):
        monkeypatch.setattr(solution_ai, "chat", lambda *_a, text=text, **_kw: (text, {}))
        assert question(f, doc).status_code == 503
    assert len(f.db.scalars(select(SolutionAnswer)).all()) == 1


def test_migration_matches_model_and_is_idempotent():
    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    path = (
        Path(__file__).parents[1] / "alembic/versions/2026_10_25_0000-007_solution_ai_settings.py"
    )
    spec = importlib.util.spec_from_file_location("solution_ai_migration", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        with Operations.context(MigrationContext.configure(connection)):
            migration.upgrade()
            migration.upgrade()
            columns = inspect(connection).get_columns("solution_ai_settings")
            assert {column["name"] for column in columns} == set(
                SolutionAISettings.__table__.columns.keys()
            )
            assert inspect(connection).get_pk_constraint("solution_ai_settings")[
                "constrained_columns"
            ] == ["issuer", "owner_id"]
            migration.downgrade()
            assert not inspect(connection).has_table("solution_ai_settings")
    engine.dispose()
