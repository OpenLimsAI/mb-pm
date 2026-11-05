"""Organization-shared models: synthetic identities/credentials, no provider calls."""

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.db.base import Base
from app.schemas.solution_ai import SharedModelSettingsInput
from app.services import solution_ai


@pytest.fixture
def registry_db(token_factory, monkeypatch):
    from app.services import organization_ai

    monkeypatch.setattr(
        organization_ai, "legacy_bootstrap", lambda: {"profiles": [], "default_profile_id": None}
    )
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        yield db
    engine.dispose()


def member(subject="alice", org="shared-org", issuer="https://iam.example"):
    return {"iss": issuer, "owner": org, "sub": subject}


def draft(name="Shared research", revision=0):
    return SharedModelSettingsInput.model_validate(
        {
            "profiles": [
                {
                    "id": "shared-research",
                    "name": name,
                    "provider": "minimax",
                    "base_url": "https://api.minimaxi.com/v1",
                    "model": "MiniMax-M3",
                    "api_key": "synthetic-never-real-key",
                }
            ],
            "default_profile_id": "shared-research",
            "revision": revision,
        }
    )


def test_members_share_same_registry_default_and_revision(registry_db):
    first = solution_ai.save_settings(registry_db, member(), draft())
    second = solution_ai.settings(registry_db, member("bob"))
    assert second == first
    assert second["default_profile_id"] == "shared:shared-research"
    assert "synthetic-never-real-key" not in str(second)


def test_organization_and_issuer_are_independent_scopes(registry_db):
    solution_ai.save_settings(registry_db, member(), draft())
    assert solution_ai.settings(registry_db, member(org="other-org"))["profiles"] == []
    assert (
        solution_ai.settings(registry_db, member(issuer="https://other-iam.example"))["profiles"]
        == []
    )


def test_system_alias_and_omitted_model_use_one_shared_default(registry_db):
    solution_ai.save_settings(registry_db, member(), draft())
    for identity in (member(), member("bob")):
        for model_id in (None, "system", "shared:shared-research"):
            selected = solution_ai.select_model(registry_db, identity, model_id)
            assert selected["config"]["model"] == "MiniMax-M3"
            assert selected["config"]["api_key"] == "synthetic-never-real-key"


def test_missing_verified_organization_never_guesses_a_shared_scope(registry_db):
    with pytest.raises(HTTPException) as error:
        solution_ai.settings(registry_db, {"iss": "https://iam.example", "sub": "alice"})
    assert error.value.status_code == 403


def test_legacy_personal_profiles_remain_private_and_resolvable(registry_db):
    from app.core.security import seal, unseal
    from app.models.solution_ai import SolutionAISettings

    legacy = {
        "profiles": [
            {
                "id": "old-task-model",
                "name": "Owner only",
                "provider": "custom",
                "base_url": "https://private.example/v1",
                "model": "old",
                "api_key": "synthetic-private-key",
            }
        ],
        "default_profile_id": "old-task-model",
    }
    row = SolutionAISettings(
        issuer=member()["iss"], owner_id="alice", revision=4, encrypted_payload=seal(legacy)
    )
    registry_db.add(row)
    registry_db.commit()
    before = row.encrypted_payload
    solution_ai.save_settings(registry_db, member(), draft())
    assert all(
        "Owner only" != p["name"]
        for p in solution_ai.settings(registry_db, member("bob"))["profiles"]
    )
    assert (
        solution_ai.select_model(registry_db, member(), "old-task-model")["config"]["api_key"]
        == "synthetic-private-key"
    )
    with pytest.raises(HTTPException) as error:
        solution_ai.select_model(registry_db, member("bob"), "old-task-model")
    assert error.value.status_code == 404
    assert row.encrypted_payload == before and unseal(row.encrypted_payload) == legacy


def test_shared_default_drives_global_compatibility_reader(registry_db):
    from app.services import ai

    solution_ai.save_settings(registry_db, member(), draft())
    cfg = ai.load_settings(registry_db, member("bob"))
    assert cfg["provider"] == "minimax"
    assert cfg["providers"]["minimax"]["model"] == "MiniMax-M3"
    assert cfg["providers"]["minimax"]["api_key"] == "synthetic-never-real-key"


def test_no_default_does_not_fall_back_to_a_different_saved_provider(registry_db):
    from app.schemas.solution_ai import SharedModelSettingsInput

    solution_ai.save_settings(
        registry_db,
        member(),
        SharedModelSettingsInput(profiles=[], default_profile_id=None, revision=0),
    )
    with pytest.raises(HTTPException) as error:
        solution_ai.select_model(registry_db, member(), "system")
    assert error.value.status_code == 422


def test_shared_minimax_import_is_explicit_idempotent_and_preserves_default(registry_db):
    from app.services import shared_ai_import

    solution_ai.save_settings(registry_db, member(), draft())
    source = {
        "scope": "service_shared",
        "provider": "minimax",
        "base_url": "https://api.minimaxi.com/anthropic",
        "model": "MiniMax-M3",
        "api_key": "synthetic-legacy-key",
    }
    before = dict(source)
    blocked = shared_ai_import.preflight(registry_db, member(), source)
    assert blocked["action"] == "protocol_confirmation_required" and not blocked["can_apply"]
    result = shared_ai_import.import_profile(
        registry_db,
        member(),
        source,
        destination_url="https://api.minimaxi.com/v1",
        expected_revision=1,
    )
    assert result["action"] == "imported" and result["credential_verified"] is False
    after = solution_ai.settings(registry_db, member("bob"))
    assert after["default_profile_id"] == "shared:shared-research" and len(after["profiles"]) == 2
    assert source == before and "synthetic-legacy-key" not in str(result)
    repeated = shared_ai_import.import_profile(
        registry_db,
        member(),
        source,
        destination_url="https://api.minimaxi.com/v1",
        expected_revision=2,
    )
    assert repeated["action"] == "already_imported" and repeated["revision"] == 2
    with pytest.raises(HTTPException):
        shared_ai_import.import_profile(
            registry_db,
            member(),
            {**source, "api_key": "different-key"},
            destination_url="https://api.minimaxi.com/v1",
            expected_revision=2,
        )
    with pytest.raises(HTTPException):
        shared_ai_import.preflight(
            registry_db, member(), source, destination_url="https://api.minimax.io/v1"
        )


def test_two_sessions_compare_and_swap_shared_updates(token_factory, tmp_path, monkeypatch):
    from app.services import organization_ai

    monkeypatch.setattr(
        organization_ai, "legacy_bootstrap", lambda: {"profiles": [], "default_profile_id": None}
    )
    engine = create_engine(f'sqlite:///{tmp_path / "shared.db"}')
    Base.metadata.create_all(engine)
    with Session(engine, expire_on_commit=False) as first, Session(engine) as second:
        solution_ai.save_settings(first, member(), draft())
        solution_ai.settings(first, member())
        solution_ai.save_settings(second, member("bob"), draft("Latest", revision=1))
        with pytest.raises(HTTPException) as error:
            solution_ai.save_settings(first, member(), draft("Stale", revision=1))
        assert error.value.status_code == 409
        assert solution_ai.settings(second, member())["profiles"][0]["name"] == "Latest"
    engine.dispose()


def test_global_compatibility_write_updates_same_shared_registry(
    registry_db, monkeypatch, tmp_path
):
    from app.core.config import settings
    from app.schemas.ai import AISettingsInput
    from app.services import ai

    monkeypatch.setattr(settings, "AI_SETTINGS_PATH", str(tmp_path / "legacy-global.json"))
    payload = AISettingsInput.model_validate(
        {
            "provider": "minimax",
            "revision": 0,
            "providers": {
                "minimax": {
                    "base_url": "https://api.minimaxi.com/v1",
                    "model": "MiniMax-M3",
                    "api_key": "synthetic-global-key",
                }
            },
        }
    )
    ai.save_settings(payload, registry_db, member())
    public = solution_ai.settings(registry_db, member("bob"))
    assert public["default_profile_id"] == "shared:system_minimax"
    assert (
        solution_ai.select_model(registry_db, member("bob"), "system")["config"]["api_key"]
        == "synthetic-global-key"
    )


def test_shared_ids_do_not_accept_ambiguous_duplicates(registry_db):
    profiles = [
        draft().profiles[0],
        draft().profiles[0].model_copy(update={"id": "shared:shared-research"}),
    ]
    with pytest.raises(HTTPException) as error:
        solution_ai.save_settings(
            registry_db, member(), type(draft())(profiles=profiles, revision=0)
        )
    assert error.value.status_code == 422


def test_prompt_only_compatibility_does_not_replace_shared_default(
    registry_db, monkeypatch, tmp_path
):
    from app.core.config import settings
    from app.schemas.ai import AISettingsInput
    from app.services import ai

    monkeypatch.setattr(settings, "AI_SETTINGS_PATH", str(tmp_path / "prompts.json"))
    solution_ai.save_settings(registry_db, member(), draft())
    current = ai.load_settings(registry_db, member())
    payload = AISettingsInput.model_validate(
        {
            "provider": "minimax",
            "providers": {
                "minimax": {
                    "base_url": current["providers"]["minimax"]["base_url"],
                    "model": current["providers"]["minimax"]["model"],
                }
            },
            "analysis_prompt": "A changed prompt",
            "revision": current["revision"],
        }
    )
    ai.save_settings(payload, registry_db, member())
    assert (
        solution_ai.settings(registry_db, member())["default_profile_id"]
        == "shared:shared-research"
    )
    assert solution_ai.settings(registry_db, member())["revision"] == 2
    only_prompts = AISettingsInput.model_validate(
        {
            "provider": "deepseek",
            "providers": {},
            "preserve_shared_models": True,
            "analysis_prompt": "Prompt-only compatibility",
            "revision": 2,
        }
    )
    ai.save_settings(only_prompts, registry_db, member())
    assert solution_ai.settings(registry_db, member())["revision"] == 3
    assert ai.load_settings(registry_db, member())["analysis_prompt"] == "Prompt-only compatibility"


@pytest.fixture
def solution_client(request):
    # Reuse the authenticated fixture without changing its production guards.
    return request.getfixturevalue("base_solution_client")


from test_solutions import solution_client as base_solution_client  # noqa: E402,F401


def test_authenticated_api_and_kb_catalog_share_the_same_default(solution_client):
    from app.core.config import settings
    from app.services import knowledge_ai

    f = solution_client
    response = f.client.put(
        "/api/v1/solutions/ai/settings",
        json={
            **draft().model_dump(mode="json"),
            "profiles": [
                {**draft().profiles[0].model_dump(mode="json"), "api_key": "synthetic-api-key"}
            ],
        },
    )
    assert response.status_code == 200
    first = response.json()
    f.login("bob")
    assert f.client.get("/api/v1/solutions/ai/settings").json() == first
    catalog = knowledge_ai.models(
        f.db, {"iss": settings.casdoor_issuer, "owner": settings.CASDOOR_ORG, "sub": "bob"}
    )
    assert catalog["default_model_id"] == first["default_profile_id"]
    assert catalog["revision"] == first["revision"]
    assert all("base_url" not in model and "api_key" not in model for model in catalog["models"])


def test_ollama_uses_existing_protocol_without_sending_api_key(monkeypatch):
    calls = []

    def request(provider, cfg, path, body=None, timeout=60):
        calls.append((provider, path, body))
        return {"message": {"content": "synthetic Ollama response"}}

    monkeypatch.setattr(solution_ai, "pinned_request", request)
    profile = {
        "provider": "ollama",
        "base_url": "http://localhost:11434",
        "model": "synthetic-model",
        "api_key": "",
    }
    text, _ = solution_ai.chat(profile, [{"role": "user", "content": "test"}])
    assert text == "synthetic Ollama response"
    assert calls[0][0:2] == ("ollama", "/api/chat")


def test_prefixed_reserved_ids_cannot_create_unreadable_registry(registry_db):
    payload = draft().model_copy(
        update={
            "profiles": [draft().profiles[0].model_copy(update={"id": "shared:system"})],
            "default_profile_id": None,
        }
    )
    with pytest.raises(HTTPException) as error:
        solution_ai.save_settings(registry_db, member(), payload)
    assert error.value.status_code == 422
    assert solution_ai.settings(registry_db, member())["revision"] == 0


def test_import_never_promotes_a_personal_configuration(registry_db):
    from app.services import shared_ai_import

    source = {
        "scope": "personal",
        "owner": "alice",
        "provider": "minimax",
        "base_url": "https://api.minimaxi.com/v1",
        "model": "MiniMax-M3",
        "api_key": "synthetic-private-key",
    }
    with pytest.raises(HTTPException) as error:
        shared_ai_import.preflight(registry_db, member(), source)
    assert error.value.status_code == 422
    assert solution_ai.settings(registry_db, member())["revision"] == 0


def test_legacy_catalog_lookup_is_explicit_and_only_for_the_owner(registry_db):
    from app.core.security import seal
    from app.models.solution_ai import SolutionAISettings
    from app.services import knowledge_ai

    row = SolutionAISettings(
        issuer=member()["iss"],
        owner_id="alice",
        revision=1,
        encrypted_payload=seal(
            {
                "profiles": [
                    {
                        "id": "legacy-task",
                        "name": "Old private task",
                        "provider": "custom",
                        "base_url": "https://private.example/v1",
                        "model": "old",
                        "api_key": "old-synthetic-key",
                    }
                ],
                "default_profile_id": "legacy-task",
            }
        ),
    )
    registry_db.add(row)
    registry_db.commit()
    assert knowledge_ai.models(registry_db, member())["models"] == []
    exact = knowledge_ai.models(registry_db, member(), "legacy-task")["models"][0]
    assert exact["id"] == "legacy-task" and "api_key" not in exact and "base_url" not in exact
    with pytest.raises(HTTPException) as error:
        knowledge_ai.models(registry_db, member("bob"), "legacy-task")
    assert error.value.status_code == 404


def test_automatic_unconfigured_default_uses_retrieval_without_another_provider(registry_db):
    configured = draft().model_copy(
        update={"profiles": [draft().profiles[0].model_copy(update={"api_key": None})]}
    )
    solution_ai.save_settings(registry_db, member(), configured)
    assert solution_ai.select_model(registry_db, member(), None) == {"kind": "retrieval"}
    with pytest.raises(HTTPException):
        solution_ai.select_model(registry_db, member(), "shared:shared-research")


def test_shared_provider_tuning_preserves_legacy_private_transport(registry_db):
    solution_ai.save_settings(registry_db, member(), draft())
    shared = solution_ai.select_model(registry_db, member("bob"), "shared:shared-research")
    assert solution_ai.transport_provider(shared["config"]) == "minimax"
    assert solution_ai.transport_provider({"provider": "minimax"}) == "custom"


@pytest.mark.parametrize("submitted_revision", [None, 0, 1])
def test_legacy_form_cannot_replace_a_newer_shared_default(registry_db, submitted_revision):
    from app.schemas.ai import AISettingsInput
    from app.services import ai

    first = draft().model_copy(
        update={
            "profiles": [
                draft()
                .profiles[0]
                .model_copy(
                    update={
                        "provider": "deepseek",
                        "base_url": "https://api.deepseek.com",
                        "model": "old-model",
                    }
                )
            ]
        }
    )
    solution_ai.save_settings(registry_db, member(), first)
    old = ai.public_settings(ai.load_settings(registry_db, member()))
    newer = draft(revision=1)
    solution_ai.save_settings(registry_db, member("bob"), newer)
    old.update(revision=submitted_revision, analysis_prompt="stale form prompt")
    # Legacy forms support only four provider slots.
    old["providers"] = {key: value for key, value in old["providers"].items() if key in ai.DEFAULTS}
    with pytest.raises(HTTPException) as error:
        ai.save_settings(AISettingsInput.model_validate(old), registry_db, member())
    assert error.value.status_code == 409
    current = solution_ai.settings(registry_db, member())
    assert current["revision"] == 2
    assert current["default_profile_id"] == "shared:shared-research"
    assert current["profiles"][0]["model"] == "MiniMax-M3"


@pytest.mark.parametrize("provider", ["custom", "ollama"])
def test_global_status_accepts_the_same_keyless_default_as_runtime(registry_db, provider):
    from app.api.v1.ai import get_status
    from app.core.config import settings

    configured = draft().model_copy(
        update={
            "profiles": [
                draft()
                .profiles[0]
                .model_copy(
                    update={
                        "provider": provider,
                        "base_url": "https://model.example/v1",
                        "api_key": None,
                    }
                )
            ]
        }
    )
    identity = member(org=settings.CASDOOR_ORG, issuer=settings.casdoor_issuer)
    solution_ai.save_settings(registry_db, identity, configured)
    assert (
        solution_ai.select_model(registry_db, identity, "system")["config"]["provider"] == provider
    )
    assert get_status(None, registry_db)["ready"] is True


def test_compatibility_save_uses_one_database_commit_without_writing_bootstrap_file(
    registry_db, monkeypatch
):
    from app.schemas.ai import AISettingsInput
    from app.services import ai, shared_ai_import

    def unwritable(*args, **kwargs):
        pytest.fail("active shared settings must not write the old bootstrap file")

    monkeypatch.setattr(ai.tempfile, "mkstemp", unwritable)
    solution_ai.save_settings(registry_db, member(), draft())
    payload = AISettingsInput.model_validate(
        {
            "provider": "deepseek",
            "revision": 1,
            "providers": {
                "deepseek": {
                    "base_url": "https://api.deepseek.com",
                    "model": "new-model",
                    "api_key": "synthetic-key",
                }
            },
            "analysis_prompt": "atomic prompt",
        }
    )
    ai.save_settings(payload, registry_db, member())
    assert (
        solution_ai.settings(registry_db, member())["default_profile_id"]
        == "shared:system_deepseek"
    )
    assert ai.load_settings(registry_db, member())["analysis_prompt"] == "atomic prompt"
    source = {
        "scope": "service_shared",
        "provider": "minimax",
        "base_url": "https://api.minimaxi.com/v1",
        "model": "MiniMax-M3",
        "api_key": "synthetic-import",
    }
    shared_ai_import.import_profile(registry_db, member(), source, expected_revision=2)
    assert ai.load_settings(registry_db, member())["analysis_prompt"] == "atomic prompt"


def test_compatibility_database_failure_rolls_back_model_and_preferences_together(registry_db):
    from sqlalchemy import event
    from sqlalchemy.exc import SQLAlchemyError

    from app.schemas.ai import AISettingsInput
    from app.services import ai

    solution_ai.save_settings(registry_db, member(), draft())
    before = solution_ai.settings(registry_db, member())

    def fail_commit(session):
        raise SQLAlchemyError("synthetic unavailable database")

    event.listen(registry_db, "before_commit", fail_commit, once=True)
    payload = AISettingsInput.model_validate(
        {
            "provider": "deepseek",
            "revision": 1,
            "providers": {
                "deepseek": {
                    "base_url": "https://api.deepseek.com",
                    "model": "new-model",
                    "api_key": "synthetic-key",
                }
            },
            "analysis_prompt": "should not commit",
        }
    )
    with pytest.raises(HTTPException) as error:
        ai.save_settings(payload, registry_db, member())
    assert error.value.status_code == 503
    assert solution_ai.settings(registry_db, member()) == before
    assert ai.load_settings(registry_db, member())["analysis_prompt"] != "should not commit"


def test_runtime_never_uses_legacy_file_keys_for_another_organization(registry_db, monkeypatch):
    from app.services import ai

    monkeypatch.setattr(
        ai,
        "load_legacy_settings",
        lambda: pytest.fail("must not read another organization's bootstrap keys"),
    )
    loaded = ai.load_settings(registry_db, member(org="unconfigured-other-org"))
    assert loaded["provider"] == "custom"
    assert all(not config.get("api_key") for config in loaded["providers"].values())


def test_file_only_legacy_utility_keeps_private_permissions(monkeypatch, tmp_path):
    import os
    import stat

    from app.core.config import settings
    from app.schemas.ai import AISettingsInput
    from app.services import ai

    path = tmp_path / "old-bootstrap.json"
    monkeypatch.setattr(settings, "AI_SETTINGS_PATH", str(path))
    payload = AISettingsInput.model_validate(
        {
            "provider": "deepseek",
            "providers": {
                "deepseek": {
                    "base_url": "https://api.deepseek.com",
                    "model": "test",
                    "api_key": "synthetic-only",
                }
            },
        }
    )
    ai.save_settings(payload)
    if os.name == "posix":
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
