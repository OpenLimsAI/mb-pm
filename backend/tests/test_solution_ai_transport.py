"""Private-model destination and HTTP boundaries; every socket/DNS operation is mocked."""

import http.client
import io
import json
import socket
import ssl

import pytest

from app.schemas.solution_ai import allowed_address, model_url
from app.services import ai, solution_ai


@pytest.fixture(autouse=True)
def no_real_network(monkeypatch):
    def unexpected(*args, **kwargs):
        pytest.fail("transport tests must not perform real network operations")

    monkeypatch.setattr(solution_ai.socket, "getaddrinfo", unexpected)
    monkeypatch.setattr(solution_ai.socket, "create_connection", unexpected)


@pytest.mark.parametrize(
    "address",
    [
        "8.8.8.8",
        "2606:4700:4700::1111",
        "10.0.0.1",
        "172.16.0.1",
        "172.31.255.254",
        "192.168.1.1",
        "127.0.0.1",
        "::1",
        "fc00::1",
        "fd12:3456::1",
    ],
)
def test_public_and_explicit_self_hosted_networks_are_allowed(address):
    assert allowed_address(address)


@pytest.mark.parametrize(
    "address",
    [
        "169.254.169.254",  # Common cloud instance metadata.
        "169.254.0.1",
        "168.63.129.16",  # Azure platform endpoint.
        "100.100.100.200",  # Alibaba instance metadata.
        "100.64.0.1",
        "0.0.0.0",
        "0.1.2.3",
        "192.0.2.1",
        "198.51.100.1",
        "203.0.113.1",
        "198.18.0.1",
        "224.0.0.1",
        "240.0.0.1",
        "255.255.255.255",
        "::",
        "fe80::1",
        "ff02::1",
        "2001:db8::1",
        "fd00:ec2::254",  # AWS IMDS must not be admitted by the ULA exception.
        "fd20:ce::254",
        "::ffff:169.254.169.254",
        "::ffff:127.0.0.1",  # Mapped IPv4 is denied instead of parsed differently downstream.
        "2002:a9fe:a9fe::1",  # 6to4 address carrying metadata IPv4.
        "2001:0:4136:e378:8000:63bf:3fff:fdd2",  # Teredo tunnel.
    ],
)
def test_special_and_metadata_networks_are_denied(address):
    assert not allowed_address(address)


@pytest.mark.parametrize(
    "supplied,expected",
    [
        (" HTTPS://Model.Example./v1/ ", "https://model.example/v1"),
        ("http://localhost:11434/v1", "http://localhost:11434/v1"),
        ("http://192.168.1.9:8080/v1", "http://192.168.1.9:8080/v1"),
        ("https://[fd12:3456::1]:8443/v1", "https://[fd12:3456::1]:8443/v1"),
        ("http://[::1]:8000/", "http://[::1]:8000"),
        ("https://模型.example/v1", "https://xn--xgs754b.example/v1"),
    ],
)
def test_valid_urls_are_canonicalized_without_changing_destination(supplied, expected, monkeypatch):
    from urllib.parse import urlsplit
    parts = urlsplit(expected)
    monkeypatch.setenv("AI_ALLOWED_INTERNAL_ORIGINS", f"{parts.scheme}://{parts.netloc}")
    assert model_url(supplied) == expected


@pytest.mark.parametrize(
    "value",
    [
        "file:///etc/passwd",
        "ftp://model.example/v1",
        "https://user:fake-secret@model.example/v1",
        "https://model.example/v1?api_key=fake-secret",
        "https://model.example/v1?",
        "https://model.example/v1#fragment",
        "https://model.example/v1#",
        "https://model.example\\@169.254.169.254/v1",
        "https://model.example/\r\nx-injected:value",
        "https://model.example/has space",
        "https://model.example:0/v1",
        "https://model.example:65536/v1",
        "https://metadata/v1",
        "https://METADATA.GOOGLE.INTERNAL./v1",
        "https://nested.metadata.google.internal/v1",
        "https://instance-data.ec2.internal/v1",
        "http://169.254.169.254/v1",
        "http://[fd00:ec2::254]/v1",
        "http://[::ffff:127.0.0.1]/v1",
        "http://[fe80::1%25eth0]/v1",
        "http://[fd12::1%25eth0]/v1",
        "http://2130706433/v1",
        "http://127.1/v1",
        "http://0177.0.0.1/v1",
        "http://0x7f000001/v1",
        "http://%31%32%37.0.0.1/v1",
        "https:///missing-host",
    ],
)
def test_unsafe_or_ambiguous_urls_fail_without_echoing_supplied_value(value):
    with pytest.raises(ValueError) as error:
        model_url(value)
    assert value not in str(error.value)
    assert "fake-secret" not in str(error.value)


def dns_records(*addresses):
    return [
        (
            socket.AF_INET6 if ":" in address else socket.AF_INET,
            socket.SOCK_STREAM,
            socket.IPPROTO_TCP,
            "",
            (address, 443),
        )
        for address in addresses
    ]


@pytest.mark.parametrize("blocked", ["169.254.169.254", "fd00:ec2::254", "168.63.129.16"])
def test_any_forbidden_dns_answer_rejects_entire_destination(monkeypatch, blocked):
    monkeypatch.setattr(
        solution_ai.socket, "getaddrinfo", lambda *a, **k: dns_records("8.8.8.8", blocked)
    )
    with pytest.raises(ai.AIError, match="禁止访问"):
        solution_ai.pinned_request("custom", config(), "/chat/completions", {})


def test_dns_resolution_deduplicates_and_preserves_safe_addresses(monkeypatch):
    calls = []

    def lookup(host, port, **kwargs):
        calls.append((host, port, kwargs))
        return dns_records("8.8.8.8", "8.8.8.8", "192.168.1.5")

    monkeypatch.setattr(solution_ai.socket, "getaddrinfo", lookup)
    assert solution_ai.resolved_addresses("model.example", 8443, allow_private=True) == ["8.8.8.8", "192.168.1.5"]
    assert calls == [("model.example", 8443, {"type": socket.SOCK_STREAM})]


@pytest.mark.parametrize("failure", [[], socket.gaierror("private-host fake-secret")])
def test_dns_failure_is_safe_and_does_not_open_socket(monkeypatch, failure):
    def lookup(*args, **kwargs):
        if isinstance(failure, Exception):
            raise failure
        return failure

    monkeypatch.setattr(solution_ai.socket, "getaddrinfo", lookup)
    with pytest.raises(ai.AIError) as error:
        solution_ai.pinned_request("custom", config(), "/chat/completions", {})
    assert "private-host" not in str(error.value)
    assert "fake-secret" not in str(error.value)


class WireSocket:
    """Exercise stdlib HTTP request/header parsing without creating an OS socket."""

    def __init__(self, payload=b'{"choices": []}', *, status=200, extra_headers=b""):
        self.raw = (
            f"HTTP/1.1 {status} Test\r\nContent-Length: {len(payload)}\r\n".encode()
            + extra_headers
            + b"\r\n"
            + payload
        )
        self.sent = bytearray()
        self.timeouts = []
        self.closed = False

    def sendall(self, data):
        self.sent.extend(data)

    def makefile(self, *args, **kwargs):
        return io.BytesIO(self.raw)

    def settimeout(self, timeout):
        self.timeouts.append(timeout)

    def close(self):
        self.closed = True


def config(base_url="https://model.example:8443/api/v1"):
    return {"base_url": base_url, "model": "self-hosted", "api_key": "fake-secret"}


def mock_wire(monkeypatch, wire, *, resolved="8.8.8.8"):
    dns_calls, socket_calls, tls_calls = [], [], []

    def lookup(host, port, **kwargs):
        dns_calls.append((host, port))
        # A second lookup would return a metadata address: requests must use the first pin.
        return dns_records(resolved if len(dns_calls) == 1 else "169.254.169.254")

    def connect(address, timeout):
        socket_calls.append((address, timeout))
        return wire

    class Context:
        def wrap_socket(self, sock, *, server_hostname):
            tls_calls.append((sock, server_hostname))
            return sock

    monkeypatch.setattr(solution_ai.socket, "getaddrinfo", lookup)
    monkeypatch.setattr(solution_ai.socket, "create_connection", connect)
    monkeypatch.setattr(solution_ai.ssl, "create_default_context", lambda: Context())
    return dns_calls, socket_calls, tls_calls


def test_https_uses_one_dns_pin_original_host_and_sni_ignoring_proxy(monkeypatch):
    for name in (
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ):
        monkeypatch.setenv(name, "http://fake-secret@untrusted-proxy.example:8080")
    wire = WireSocket(b'{"choices": [{"message": {"content": "ok"}}]}')
    dns_calls, socket_calls, tls_calls = mock_wire(monkeypatch, wire)
    body = {"model": "self-hosted", "messages": [{"role": "user", "content": "test"}]}
    result = solution_ai.pinned_request("custom", config(), "/chat/completions", body, timeout=9)
    assert result["choices"][0]["message"]["content"] == "ok"
    assert dns_calls == [("model.example", 8443)]
    assert socket_calls == [(("8.8.8.8", 8443), 9)]
    assert tls_calls == [(wire, "model.example")]
    headers, encoded = bytes(wire.sent).split(b"\r\n\r\n", 1)
    assert headers.startswith(b"POST /api/v1/chat/completions HTTP/1.1\r\n")
    assert b"Host: model.example:8443\r\n" in headers
    assert b"Authorization: Bearer fake-secret" in headers
    assert b"untrusted-proxy" not in wire.sent
    assert b"192.168.2.5" not in headers
    assert json.loads(encoded) == body
    assert all(0 < timeout <= 9 for timeout in wire.timeouts)
    assert wire.closed


def test_literal_http_self_host_uses_no_dns_or_tls_and_supports_no_key(monkeypatch):
    monkeypatch.setenv("AI_ALLOWED_INTERNAL_ORIGINS", "http://127.0.0.1:11434")
    wire = WireSocket()
    dns_calls, socket_calls, tls_calls = mock_wire(monkeypatch, wire)
    cfg = {**config("http://127.0.0.1:11434/v1"), "api_key": ""}
    assert solution_ai.pinned_request("custom", cfg, "/chat/completions", {}) == {"choices": []}
    assert dns_calls == []
    assert socket_calls == [(("127.0.0.1", 11434), 60)]
    assert tls_calls == []
    assert b"Host: 127.0.0.1:11434\r\n" in wire.sent
    assert b"Authorization:" not in wire.sent
    assert wire.closed


def test_connection_close_response_remains_readable_after_connection_releases_socket(monkeypatch):
    wire = WireSocket(
        b'{"choices": [{"message": {"content": "complete"}}]}',
        extra_headers=b"Connection: close\r\n",
    )
    mock_wire(monkeypatch, wire)
    result = solution_ai.pinned_request("custom", config(), "/chat/completions", {})
    assert result["choices"][0]["message"]["content"] == "complete"
    assert wire.closed


@pytest.mark.parametrize("status", [301, 302, 307, 308, 401, 429, 500])
def test_redirects_and_http_errors_are_never_followed_or_echoed(monkeypatch, status):
    wire = WireSocket(
        b'{"error": "fake-secret upstream-internals"}',
        status=status,
        extra_headers=b"Location: http://169.254.169.254/latest/meta-data/\r\n",
    )
    dns_calls, socket_calls, _ = mock_wire(monkeypatch, wire)
    with pytest.raises(ai.AIError) as error:
        solution_ai.pinned_request("custom", config(), "/chat/completions", {})
    assert len(dns_calls) == len(socket_calls) == 1
    assert str(error.value) == "模型服务拒绝请求，请核对地址、模型、密钥与账户状态"
    assert error.value.upstream_status == status
    assert error.value.code == (
        "model_auth" if status == 401 else "model_rate_limit" if status == 429 else "model_rejected"
    )
    assert wire.closed


@pytest.mark.parametrize(
    "payload",
    [
        b"fake-secret malformed-json",
        b'["fake-secret"]',
        b'{"error": "fake-secret provider-detail"}',
        b'{"base_resp": "fake-secret provider-detail"}',
        b'{"base_resp": {"status_code": 1004, "status_msg": "fake-secret"}}',
    ],
)
def test_malformed_or_provider_error_responses_are_sanitized(monkeypatch, payload):
    wire = WireSocket(payload)
    mock_wire(monkeypatch, wire)
    with pytest.raises(ai.AIError) as error:
        solution_ai.pinned_request("custom", config(), "/chat/completions", {})
    assert "fake-secret" not in str(error.value)
    assert "provider-detail" not in str(error.value)
    assert wire.closed


def test_response_size_is_bounded(monkeypatch):
    wire = WireSocket(b" " * 2_000_001)
    mock_wire(monkeypatch, wire)
    with pytest.raises(ai.AIError, match="回复过长"):
        solution_ai.pinned_request("custom", config(), "/chat/completions", {})
    assert wire.closed


def test_elapsed_budget_stops_response_and_closes_socket(monkeypatch):
    wire = WireSocket()
    mock_wire(monkeypatch, wire)
    times = iter([10, 10, 12])
    monkeypatch.setattr(solution_ai.time, "monotonic", lambda: next(times))
    with pytest.raises(ai.AIError, match="模型连接失败"):
        solution_ai.pinned_request("custom", config(), "/chat/completions", {}, timeout=1)
    assert wire.closed


@pytest.mark.parametrize(
    "failure",
    [
        OSError("fake-secret private-network-detail"),
        TimeoutError("fake-secret private-network-detail"),
        http.client.HTTPException("fake-secret private-network-detail"),
    ],
)
def test_connection_failures_are_sanitized(monkeypatch, failure):
    monkeypatch.setattr(solution_ai.socket, "getaddrinfo", lambda *a, **k: dns_records("8.8.8.8"))

    def fail(*args, **kwargs):
        raise failure

    monkeypatch.setattr(solution_ai.socket, "create_connection", fail)
    with pytest.raises(ai.AIError) as error:
        solution_ai.pinned_request("custom", config(), "/chat/completions", {})
    assert str(error.value) == "模型连接失败或响应无效，请检查个人模型地址与网络"
    assert error.value.code == (
        "model_timeout" if isinstance(failure, TimeoutError) else "model_network"
    )


def test_tls_verification_failure_closes_socket_without_sending_key(monkeypatch):
    wire = WireSocket()
    mock_wire(monkeypatch, wire)

    class RejectCertificate:
        def wrap_socket(self, sock, *, server_hostname):
            assert sock is wire
            assert server_hostname == "model.example"
            raise ssl.SSLCertVerificationError("fake-secret certificate-detail")

    monkeypatch.setattr(solution_ai.ssl, "create_default_context", lambda: RejectCertificate())
    with pytest.raises(ai.AIError) as error:
        solution_ai.pinned_request("custom", config(), "/chat/completions", {})
    assert "fake-secret" not in str(error.value)
    assert "certificate-detail" not in str(error.value)
    assert not wire.sent
    assert wire.closed
