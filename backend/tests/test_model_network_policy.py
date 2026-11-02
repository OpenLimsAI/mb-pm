import socket

import pytest
from pydantic import ValidationError

from app.schemas.ai import ConnectionInput
from app.schemas.model_network import enterprise_url
from app.schemas.solution_ai import model_url
from app.services import ai, solution_ai


@pytest.fixture(autouse=True)
def no_internal_defaults(monkeypatch):
    monkeypatch.delenv("AI_ALLOWED_INTERNAL_ORIGINS", raising=False)


@pytest.mark.parametrize(
    "url",
    [
        "http://169.254.169.254",
        "http://127.0.0.1:11434",
        "https://10.0.0.1",
        "http://public.example",
        "https://localhost",
    ],
)
def test_unapproved_targets_never_reach_transport(url, monkeypatch):
    monkeypatch.setattr(socket, "create_connection", lambda *a, **k: pytest.fail("no connection"))
    with pytest.raises(ValueError):
        model_url(url)
    with pytest.raises(ValidationError):
        ConnectionInput(provider="ollama", config={"base_url": url, "model": "test"})


def test_internal_approval_exact_and_metadata_still_denied(monkeypatch):
    monkeypatch.setenv(
        "AI_ALLOWED_INTERNAL_ORIGINS", "http://127.0.0.1:11434,http://169.254.169.254"
    )
    assert enterprise_url("ollama", "http://127.0.0.1:11434/v1") == "http://127.0.0.1:11434/v1"
    for url in ("http://127.0.0.1:11435", "http://169.254.169.254"):
        with pytest.raises(ValueError):
            model_url(url)


def test_public_domain_cannot_resolve_to_internal_address(monkeypatch):
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda *a, **k: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.1.2.3", 443))],
    )
    with pytest.raises(ai.AIError):
        solution_ai.resolved_addresses("api.deepseek.com", 443)
    assert solution_ai.resolved_addresses("approved-model", 443, allow_private=True) == ["10.1.2.3"]


def test_enterprise_cloud_host_cannot_be_changed_to_unapproved_host():
    assert (
        enterprise_url("deepseek", "https://api.deepseek.com/v1") == "https://api.deepseek.com/v1"
    )
    with pytest.raises(ValueError):
        enterprise_url("deepseek", "https://collector.example/v1")
    # An explicitly chosen private profile may still use a public HTTPS-compatible model.
    assert model_url("https://model.example/v1") == "https://model.example/v1"
