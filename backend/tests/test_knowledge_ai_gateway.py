"""Synthetic JWT/IAM/model fixtures only; no live accounts, provider calls or secrets."""

import copy
import time
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest
from jose import jwt
from sqlalchemy import delete

from app.core.config import settings
from app.db.session import SessionLocal
from app.models.organization_ai import OrganizationAISettings
from app.schemas.solution_ai import SharedModelSettingsInput
from app.services import ai, oidc_status, solution_ai

PREFIX = "/api/v1/integration/knowledge/ai"
SECRET = "synthetic-shared-provider-key-never-return"
SYSTEM_SECRET = "synthetic-system-provider-key-never-return"
DEEPSEEK_ENDPOINT = "https://api.deepseek.com/v1"
RESEARCH_SCHEMA = {
    "type": "json_schema",
    "json_schema": {
        "name": "research_answer",
        "strict": True,
        "schema": {"type": "object", "properties": {"answer": {"type": "string"}}},
    },
}


@pytest.fixture
def gateway(client, token_factory, monkeypatch):
    monkeypatch.setattr(settings, "KNOWLEDGE_AI_ENABLED", True)
    monkeypatch.setattr(settings, "KNOWLEDGE_AI_CLIENT_ID", "kb-test")
    monkeypatch.setattr(settings, "OIDC_GLOBAL_LOGOUT_ENABLED", True)
    monkeypatch.setattr(settings, "CASDOOR_ACCOUNT_STATUS_VISIBLE", True)
    monkeypatch.setattr(settings, "PORTAL_PUBLIC_URL", "https://portal.example.test")
    monkeypatch.setattr(settings, "PORTAL_CLIENT_ID", "portal-test")
    monkeypatch.setattr(settings, "PORTAL_CLIENT_SECRET", "synthetic-portal-secret")
    subject = "kb-gateway-" + uuid4().hex
    state = SimpleNamespace(
        subject=subject,
        role="kb_viewer",
        active=True,
        wrong_client=False,
        wrong_subject=False,
        forbidden=False,
        password_required=False,
        password_time="",
        unavailable=False,
        iam_calls=0,
        model_calls=[],
        result=None,
    )

    class IAM:
        def __init__(self, **kwargs):
            assert kwargs.get("trust_env") is False

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def post(self, url, **kwargs):
            assert url.endswith("/api/login/oauth/introspect")
            state.iam_calls += 1
            if state.unavailable:
                raise httpx.ConnectError("synthetic IAM offline")
            claims = jwt.get_unverified_claims(kwargs["data"]["token"])
            return httpx.Response(
                200,
                json={
                    "active": state.active,
                    "client_id": "other-client" if state.wrong_client else "kb-test",
                    "sub": "wrong-user" if state.wrong_subject else claims["sub"],
                },
            )

        def get(self, url, **kwargs):
            return httpx.Response(
                200,
                json={
                    "status": "ok",
                    "data": {
                        "id": kwargs["params"]["userId"],
                        "owner": settings.CASDOOR_ORG,
                        "isForbidden": state.forbidden,
                        "isDeleted": False,
                        "roles": [
                            {"owner": settings.CASDOOR_ORG, "name": state.role, "isEnabled": True}
                        ],
                        "needUpdatePassword": state.password_required,
                        "lastChangePasswordTime": state.password_time,
                    },
                },
            )

    monkeypatch.setattr(oidc_status.httpx, "Client", IAM)
    system = {
        "provider": "deepseek",
        "providers": {
            "deepseek": {
                "base_url": "https://api.deepseek.com",
                "model": "synthetic-system",
                "api_key": SYSTEM_SECRET,
            }
        },
        "offline_fallback": True,
    }
    monkeypatch.setattr(ai, "load_legacy_settings", lambda: copy.deepcopy(system))

    def transport(provider, cfg, path, body, timeout):
        state.model_calls.append((provider, copy.deepcopy(cfg), path, copy.deepcopy(body), timeout))
        return copy.deepcopy(
            state.result
            or {
                "choices": [
                    {
                        "message": {"role": "assistant", "content": "synthetic response"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 12, "completion_tokens": 4, "total_tokens": 16},
            }
        )

    monkeypatch.setattr(solution_ai, "pinned_request", transport)
    monkeypatch.setattr(ai, "request", transport)

    def token(**overrides):
        return token_factory(
            "kb_editor", sub=subject, aud=["kb-test"], iat=int(time.time()), **overrides
        )

    def headers(**overrides):
        return {"Authorization": "Bearer " + token(**overrides)}

    def save(
        *,
        member=subject,
        provider="deepseek",
        model="synthetic-shared",
        key=SECRET,
        revision=0,
        default="profile-1",
        base_url="https://model.example.test/v1",
    ):
        with SessionLocal() as db:
            solution_ai.save_settings(
                db,
                {"iss": settings.casdoor_issuer, "owner": settings.CASDOOR_ORG, "sub": member},
                SharedModelSettingsInput.model_validate(
                    {
                        "profiles": [
                            {
                                "id": "profile-1",
                                "name": "Shared research",
                                "provider": provider,
                                "base_url": base_url,
                                "model": model,
                                "api_key": key,
                            }
                        ],
                        "revision": revision,
                        "default_profile_id": default,
                    }
                ),
            )

    def clear_shared_scope():
        with SessionLocal() as db:
            db.execute(
                delete(OrganizationAISettings).where(
                    OrganizationAISettings.issuer == settings.casdoor_issuer,
                    OrganizationAISettings.organization == settings.CASDOOR_ORG,
                )
            )
            db.commit()

    clear_shared_scope()
    save()
    try:
        yield SimpleNamespace(
            client=client, state=state, token=token, headers=headers, save=save, system=system
        )
    finally:
        clear_shared_scope()


def ask(f, **changes):
    return f.client.post(
        PREFIX + "/chat/completions",
        headers=f.headers(),
        json={
            "messages": [{"role": "user", "content": "synthetic prompt"}],
            **changes,
        },
    )


def test_models_share_organization_default_and_never_return_keys_or_endpoints(gateway):
    f = gateway
    response = f.client.get(PREFIX + "/models", headers=f.headers())
    assert response.status_code == 200
    data = response.json()
    assert data["default_model_id"] == "shared:profile-1" and data["revision"] == 1
    assert data["settings_url"] == "https://portal.example.test/model-settings"
    assert data["models"][0] == {
        "id": "shared:profile-1",
        "name": "Shared research",
        "provider": "deepseek",
        "model": "synthetic-shared",
        "key_set": True,
        "available": True,
    }
    assert [item["id"] for item in data["models"]] == ["shared:profile-1"]
    assert SECRET not in response.text and SYSTEM_SECRET not in response.text
    assert "model.example.test" not in response.text
    assert response.headers["cache-control"] == "no-store"


def test_default_explicit_system_and_missing_profile_do_not_cross_fallback(gateway):
    f = gateway
    assert ask(f).status_code == 200
    assert f.state.model_calls[-1][1]["api_key"] == SECRET
    assert ask(f, model="system").status_code == 200
    assert f.state.model_calls[-1][1]["api_key"] == SECRET
    before = len(f.state.model_calls)
    assert ask(f, model="missing").status_code == 404
    assert ask(f, model="retrieval").status_code == 422
    assert ask(f, settings_revision=0).status_code == 409
    assert len(f.state.model_calls) == before


def test_unreadable_legacy_file_does_not_disable_saved_shared_models(gateway, monkeypatch):
    def broken():
        raise OSError("synthetic config unavailable")

    monkeypatch.setattr(ai, "load_legacy_settings", broken)
    response = gateway.client.get(PREFIX + "/models", headers=gateway.headers())
    assert response.status_code == 200
    assert response.json()["models"][0]["available"] is True
    assert [model["id"] for model in response.json()["models"]] == ["shared:profile-1"]
    assert ask(gateway).status_code == 200
    assert ask(gateway, model="system").status_code == 200
    assert gateway.state.model_calls[-1][1]["api_key"] == SECRET


def test_shared_profile_updates_are_visible_to_verified_members_of_the_same_organization(
    gateway, token_factory
):
    f = gateway
    other = "kb-other-" + uuid4().hex
    f.save(member=other, key="synthetic-updated-shared-key", revision=1)
    other_headers = {
        "Authorization": "Bearer "
        + token_factory("kb_viewer", sub=other, aud=["kb-test"], iat=int(time.time()))
    }
    response = f.client.post(
        PREFIX + "/chat/completions",
        headers=other_headers,
        json={
            "model": "shared:profile-1",
            "messages": [{"role": "user", "content": "other prompt"}],
        },
    )
    assert response.status_code == 200
    assert f.state.model_calls[-1][1]["api_key"] == "synthetic-updated-shared-key"
    assert ask(f).status_code == 200
    assert f.state.model_calls[-1][1]["api_key"] == "synthetic-updated-shared-key"
    # A bare legacy ID must not accidentally select the new shared profile.
    calls = len(f.state.model_calls)
    assert ask(f, model="profile-1").status_code == 404
    assert len(f.state.model_calls) == calls


@pytest.mark.parametrize(
    "setting,value",
    [
        ("KNOWLEDGE_AI_ENABLED", False),
        ("KNOWLEDGE_AI_CLIENT_ID", ""),
        ("KNOWLEDGE_AI_CLIENT_ID", "pms-test"),
        ("OIDC_GLOBAL_LOGOUT_ENABLED", False),
        ("CASDOOR_ACCOUNT_STATUS_VISIBLE", False),
    ],
)
def test_gateway_fails_closed_when_status_or_integration_is_disabled(
    gateway, monkeypatch, setting, value
):
    monkeypatch.setattr(settings, setting, value)
    assert gateway.client.get(PREFIX + "/models", headers=gateway.headers()).status_code == 503
    assert gateway.state.iam_calls == 0


@pytest.mark.parametrize(
    "change,status",
    [
        ({"active": False}, 401),
        ({"wrong_client": True}, 401),
        ({"wrong_subject": True}, 401),
        ({"forbidden": True}, 403),
        ({"role": "rd"}, 403),
        ({"password_required": True}, 403),
        ({"password_time": "2099-01-01T00:00:00Z"}, 401),
        ({"unavailable": True}, 503),
    ],
)
def test_current_iam_account_role_and_password_are_checked_every_call(gateway, change, status):
    f = gateway
    assert f.client.get(PREFIX + "/models", headers=f.headers()).status_code == 200
    for key, value in change.items():
        setattr(f.state, key, value)
    assert ask(f).status_code == status
    assert f.state.iam_calls == 2
    assert not f.state.model_calls


@pytest.mark.parametrize("role", ["kb_viewer", "kb_editor", "kb_manager"])
def test_kb_roles_can_generate_without_pm_business_membership(gateway, role):
    gateway.state.role = role
    assert ask(gateway).status_code == 200


def test_only_kb_audience_accepted_and_existing_workbench_api_does_not_accept_it(
    gateway, token_factory
):
    f = gateway
    assert f.client.get(PREFIX + "/models").status_code == 401
    pm = {"Authorization": "Bearer " + token_factory(sub=f.state.subject)}
    assert f.client.get(PREFIX + "/models", headers=pm).status_code == 401
    assert f.client.get("/api/v1/solutions/ai/settings", headers=f.headers()).status_code == 401
    assert (
        f.client.get(
            PREFIX + "/models",
            headers={"Authorization": "Bearer " + f.token(iss="https://wrong.example")},
        ).status_code
        == 401
    )
    assert (
        f.client.get(
            PREFIX + "/models",
            headers={"Authorization": "Bearer " + f.token(exp=int(time.time()) - 100)},
        ).status_code
        == 401
    )
    assert (
        f.client.get(PREFIX + "/models", headers=f.headers(owner="another-org")).status_code == 403
    )
    assert not f.state.model_calls


def test_tools_and_followup_results_are_forwarded_without_execution(gateway):
    f = gateway
    tool = {
        "type": "function",
        "function": {
            "name": "read_page",
            "description": "Read authorized page",
            "parameters": {"type": "object", "properties": {"path": {"type": "string"}}},
        },
    }
    call = {
        "id": "call_1",
        "type": "function",
        "function": {"name": "read_page", "arguments": '{"path":"synthetic"}'},
    }
    f.state.result = {
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [call],
                    "reasoning_content": "provider continuation",
                },
                "finish_reason": "tool_calls",
            }
        ],
        "usage": {"prompt_tokens": 5, "completion_tokens": 3},
    }
    first = ask(f, tools=[tool], tool_choice="auto")
    assert first.status_code == 200
    assert first.json()["choices"][0]["message"]["tool_calls"] == [call]
    assert first.json()["choices"][0]["finish_reason"] == "tool_calls"
    assert f.state.model_calls[-1][3]["tools"] == [tool]
    message = first.json()["choices"][0]["message"]
    f.state.result = None
    second = ask(
        f,
        tools=[tool],
        messages=[
            {"role": "user", "content": "read"},
            message,
            {"role": "tool", "tool_call_id": "call_1", "content": "authorized synthetic data"},
        ],
    )
    assert second.status_code == 200
    forwarded = f.state.model_calls[-1][3]["messages"]
    assert forwarded[-1]["tool_call_id"] == "call_1"
    assert forwarded[-2]["reasoning_content"] == "provider continuation"
    assert second.json()["usage"] == {
        "prompt_tokens": 12,
        "completion_tokens": 4,
        "total_tokens": 16,
    }


@pytest.mark.parametrize("provider", ["deepseek", "kimi"])
@pytest.mark.parametrize("metadata_level", ["index", "call", "function", "both"])
def test_provider_tool_metadata_is_projected_before_strict_validation(
    gateway, provider, metadata_level
):
    f = gateway
    f.save(provider=provider, revision=1)
    tool = {"type": "function", "function": {"name": "read_page", "parameters": {"type": "object"}}}
    expected = {
        "id": "call_1",
        "type": "function",
        "function": {"name": "read_page", "arguments": '{"path":"synthetic"}'},
    }
    supplied = copy.deepcopy(expected)
    if metadata_level in {"index", "call", "both"}:
        # Compatible providers may include index even in a non-streaming reply.
        supplied["index"] = 0
    if metadata_level in {"call", "both"}:
        supplied["provider_metadata"] = SECRET
    if metadata_level in {"function", "both"}:
        supplied["function"]["provider_metadata"] = SECRET
    f.state.result = {
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": None,
                    "reasoning_content": "synthetic reasoning",
                    "tool_calls": [supplied],
                },
                "finish_reason": "tool_calls",
            }
        ]
    }
    response = ask(f, tools=[tool], tool_choice="auto")
    assert response.status_code == 200
    assert SECRET not in response.text
    message = response.json()["choices"][0]["message"]
    assert message["tool_calls"] == [expected]
    assert message["reasoning_content"] == "synthetic reasoning"
    f.state.result = None
    followup = ask(
        f,
        tools=[tool],
        messages=[
            {"role": "user", "content": "synthetic prompt"},
            message,
            {"role": "tool", "tool_call_id": "call_1", "content": "authorized synthetic result"},
        ],
    )
    assert followup.status_code == 200
    assert f.state.model_calls[-1][3]["messages"][1]["tool_calls"] == [expected]


@pytest.mark.parametrize(
    "invalid",
    [
        "not_object",
        "no_id",
        "invalid_type",
        "no_function",
        "no_name",
        "no_arguments",
        "object_arguments",
        "long_arguments",
        "undeclared",
        "disabled",
        "wrong_finish",
        "secret",
    ],
)
def test_tool_metadata_projection_preserves_validation_boundaries(gateway, invalid):
    tool = {"type": "function", "function": {"name": "read_page", "parameters": {"type": "object"}}}
    call = {
        "id": "call_1",
        "type": "function",
        "index": 0,
        "function": {"name": "read_page", "arguments": "{}", "provider_metadata": "ignored"},
    }
    if invalid == "not_object":
        call = None
    elif invalid == "no_id":
        del call["id"]
    elif invalid == "invalid_type":
        call["type"] = "custom"
    elif invalid == "no_function":
        del call["function"]
    elif invalid == "no_name":
        del call["function"]["name"]
    elif invalid == "no_arguments":
        del call["function"]["arguments"]
    elif invalid == "object_arguments":
        call["function"]["arguments"] = {}
    elif invalid == "long_arguments":
        call["function"]["arguments"] = "x" * 200_001
    elif invalid == "undeclared":
        call["function"]["name"] = "undeclared_tool"
    elif invalid == "secret":
        call["function"]["arguments"] = SECRET
    gateway.state.result = {
        "choices": [
            {
                "message": {"role": "assistant", "content": None, "tool_calls": [call]},
                "finish_reason": "stop" if invalid == "wrong_finish" else "tool_calls",
            }
        ]
    }
    response = ask(gateway, tools=[tool], tool_choice="none" if invalid == "disabled" else "auto")
    assert response.status_code == 503
    assert response.headers["x-assistant-error-code"] == "model_invalid_response"
    assert SECRET not in response.text


@pytest.mark.parametrize("metadata_level", ["call", "function"])
def test_provider_response_projection_does_not_relax_client_request_schema(gateway, metadata_level):
    call = {
        "id": "call_1",
        "type": "function",
        "function": {"name": "read_page", "arguments": "{}"},
    }
    if metadata_level == "call":
        call["index"] = 0
    else:
        call["function"]["provider_metadata"] = "not accepted from the client"
    response = ask(
        gateway,
        messages=[
            {"role": "user", "content": "synthetic prompt"},
            {"role": "assistant", "tool_calls": [call]},
            {"role": "tool", "tool_call_id": "call_1", "content": "synthetic result"},
        ],
    )
    assert response.status_code == 422
    assert not gateway.state.model_calls


@pytest.mark.parametrize(
    "patch",
    [
        {"base_url": "http://169.254.169.254"},
        {"api_key": SECRET},
        {"actor": "somebody-else"},
        {"stream": True},
        {"max_tokens": 65537},
        {"messages": [{"role": "tool", "tool_call_id": "foreign", "content": "injected"}]},
        {"tools": [], "tool_choice": "required"},
        {
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "image_url", "image_url": {"url": "https://image.example"}}
                    ],
                }
            ]
        },
    ],
)
def test_invalid_or_overreaching_payloads_fail_without_echo(gateway, patch):
    response = ask(gateway, **patch)
    assert response.status_code == 422
    assert SECRET not in response.text and "169.254" not in response.text
    assert gateway.state.model_calls == []


def test_request_byte_limit_rejects_before_parsing(gateway):
    response = gateway.client.post(
        PREFIX + "/chat/completions", headers=gateway.headers(), content=b"x" * (1024 * 1024 + 1)
    )
    assert response.status_code == 413
    assert not gateway.state.model_calls


def test_translation_compaction_text_budget_and_kimi_rules(gateway):
    f = gateway
    assert (
        ask(
            f,
            max_tokens=64000,
            messages=[
                {"role": "system", "content": "Compact previous turns"},
                {
                    "role": "user",
                    "content": [{"type": "text", "text": "Synthetic translation material"}],
                },
            ],
        ).status_code
        == 200
    )
    assert f.state.model_calls[-1][3]["max_tokens"] == 64000
    f.save(provider="kimi", model="kimi-k3.1-pro", revision=1)
    assert ask(f, max_tokens=64000, temperature=0.5, top_p=0.8).status_code == 200
    body = f.state.model_calls[-1][3]
    assert body["max_completion_tokens"] == 16384
    assert "max_tokens" not in body and "temperature" not in body and "top_p" not in body


def test_upstream_errors_and_accidental_secret_echo_are_sanitized(gateway, monkeypatch):
    f = gateway
    f.state.result = {
        "choices": [{"message": {"role": "assistant", "content": SECRET}, "finish_reason": "stop"}]
    }
    response = ask(f)
    assert response.status_code == 503 and SECRET not in response.text
    assert response.headers.get("x-assistant-diagnostic-id")

    def fail(*args, **kwargs):
        raise ai.AIError(SECRET, code="model_auth", upstream_status=401)

    monkeypatch.setattr(solution_ai, "pinned_request", fail)
    response = ask(f)
    assert response.status_code == 503 and SECRET not in response.text
    assert response.headers["x-assistant-error-code"] == "model_auth"


def test_length_finish_and_unknown_usage_are_preserved_without_fabricated_cost(gateway):
    gateway.state.result = {
        "choices": [
            {"message": {"role": "assistant", "content": "partial"}, "finish_reason": "length"}
        ]
    }
    response = ask(gateway)
    assert response.status_code == 200
    assert response.json()["choices"][0]["finish_reason"] == "length"
    assert response.json()["usage"] == {}


@pytest.mark.parametrize(
    "base_url,capability",
    [(DEEPSEEK_ENDPOINT, True), ("https://api.deepseek.com.example.test/v1", False)],
)
def test_structured_deepseek_uses_official_json_mode_only(gateway, base_url, capability):
    f = gateway
    f.save(model="deepseek-v4-pro", base_url=base_url, revision=1)
    catalog = f.client.get(PREFIX + "/models", headers=f.headers())
    assert catalog.status_code == 200
    assert catalog.json()["models"][0].get("supports_json_object") is (True if capability else None)
    assert base_url not in catalog.text and SECRET not in catalog.text

    messages = [{"role": "user", "content": 'Return JSON like {"answer":"ok"}.'}]
    response = ask(
        f, response_format=RESEARCH_SCHEMA, max_completion_tokens=4096, messages=messages
    )
    assert response.status_code == 200
    assert len(f.state.model_calls) == 1
    _, _, path, body, _ = f.state.model_calls[-1]
    assert path == "/chat/completions"
    assert body["messages"] == messages
    if capability:
        assert body["response_format"] == {"type": "json_object"}
        assert body["reasoning_effort"] == "none"
        assert body["max_tokens"] == 4096 and "max_completion_tokens" not in body
    else:
        assert body["response_format"] == RESEARCH_SCHEMA
        assert "reasoning_effort" not in body and body["max_completion_tokens"] == 4096


@pytest.mark.parametrize("finish,content", [("length", None), ("stop", "  ")])
def test_structured_deepseek_preserves_incomplete_reply_without_reasoning(gateway, finish, content):
    f = gateway
    f.save(model="deepseek-v4-pro", base_url=DEEPSEEK_ENDPOINT, revision=1)
    f.state.result = {
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": content,
                    "reasoning_content": "private provider reasoning",
                },
                "finish_reason": finish,
            }
        ],
        "usage": {"completion_tokens_details": {"reasoning_tokens": 4096}},
    }
    response = ask(f, response_format=RESEARCH_SCHEMA)
    assert response.status_code == 200
    assert response.json()["choices"][0] == {
        "index": 0,
        "message": {"role": "assistant", "content": content or ""},
        "finish_reason": finish,
    }
    assert response.json()["usage"] == {"completion_tokens_details": {"reasoning_tokens": 4096}}
    assert len(f.state.model_calls) == 1


def test_deepseek_tool_and_plain_turns_keep_their_existing_wire_contract(gateway):
    f = gateway
    f.save(model="deepseek-v4-pro", base_url=DEEPSEEK_ENDPOINT, revision=1)
    assert ask(f, max_tokens=4096).status_code == 200
    assert "reasoning_effort" not in f.state.model_calls[-1][3]
    tool = {"type": "function", "function": {"name": "read_page", "parameters": {"type": "object"}}}
    assert ask(f, tools=[tool], response_format={"type": "json_object"}).status_code == 200
    body = f.state.model_calls[-1][3]
    assert body["tools"] == [tool] and body["response_format"] == {"type": "json_object"}
    assert "reasoning_effort" not in body


def test_ollama_structured_turn_keeps_native_json_schema(gateway):
    f = gateway
    f.save(provider="ollama", model="synthetic-local", key="", revision=1)
    f.state.result = {"message": {"role": "assistant", "content": "{}"}, "done_reason": "stop"}
    assert ask(f, response_format=RESEARCH_SCHEMA, max_tokens=4096).status_code == 200
    _, _, path, body, _ = f.state.model_calls[-1]
    assert path == "/api/chat"
    assert body["format"] == RESEARCH_SCHEMA["json_schema"]["schema"]
    assert body["options"] == {"num_predict": 4096}


def test_shared_default_ollama_tool_protocol_conversion(gateway):
    f = gateway
    f.save(provider="ollama", model="synthetic-local", key="", revision=1)
    f.state.result = {
        "message": {
            "role": "assistant",
            "content": "",
            "tool_calls": [{"function": {"name": "read_page", "arguments": {"path": "synthetic"}}}],
        },
        "done_reason": "stop",
        "prompt_eval_count": 7,
        "eval_count": 2,
    }
    tool = {"type": "function", "function": {"name": "read_page", "parameters": {"type": "object"}}}
    response = ask(f, model="system", tools=[tool])
    assert response.status_code == 200
    message = response.json()["choices"][0]["message"]
    assert message["tool_calls"][0]["function"]["arguments"] == '{"path": "synthetic"}'
    assert f.state.model_calls[-1][2] == "/api/chat"
    f.state.result = {"message": {"role": "assistant", "content": "done"}, "done_reason": "stop"}
    assert (
        ask(
            f,
            model="system",
            tools=[tool],
            messages=[
                {"role": "user", "content": "read"},
                message,
                {
                    "role": "tool",
                    "tool_call_id": message["tool_calls"][0]["id"],
                    "content": "synthetic result",
                },
            ],
        ).status_code
        == 200
    )
    assert f.state.model_calls[-1][3]["messages"][-1]["tool_name"] == "read_page"
