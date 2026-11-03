"""Public document downloads never use browser/model credentials or unpinned DNS."""

from unittest.mock import Mock

import pytest

from app.services import reference_download as module
from app.services.reference_download import ReferenceClient, reference_url


class Response:
    def __init__(self, body=b"", status=200, headers=None):
        self.body, self.status, self.headers = body, status, headers or {}

    def getheader(self, name, default=None):
        return self.headers.get(name, default)

    def read(self, count):
        result, self.body = self.body[:count], self.body[count:]
        return result


def wire(routes):
    calls, sockets = [], []

    class Connection:
        def __init__(self, host, port, address, *, timeout):
            self.host, self.address = host, address
            self.sock, self.closed = Mock(), False
            sockets.append(self)

        def request(self, method, path, headers):
            calls.append((self.host, self.address, path, headers))
            self.path = path

        def getresponse(self):
            if self.path == "/robots.txt" and (self.host, self.path) not in routes:
                return Response(status=404)
            return Response(**routes[(self.host, self.path)])

        def close(self):
            self.closed = True

    return (
        ReferenceClient(resolver=lambda *a, **k: ["8.8.8.8"], connection_factory=Connection),
        calls,
        sockets,
    )


@pytest.mark.parametrize(
    "url",
    [
        "http://paper.example.org/x.pdf",
        "https://localhost/x.pdf",
        "https://127.0.0.1/x",
        "https://[::1]/x",
        "https://user:secret@paper.example.org/x",
        "https://paper.example.org:444/x",
        "https://paper.example.org/\\evil",
        "file:///etc/passwd",
        "https://0x7f.0.0.1/x",
    ],
)
def test_bad_url(url):
    with pytest.raises(ValueError):
        reference_url(url)


def test_direct_pdf_pins_dns_and_sends_no_secrets():
    client, calls, sockets = wire({("paper.example.org", "/paper.pdf"): {"body": b"%PDF-original"}})
    assert client.pdf("https://paper.example.org/paper.pdf#view") == b"%PDF-original"
    assert all(c[1] == "8.8.8.8" and set(c[3]) == {"User-Agent", "Accept-Encoding"} for c in calls)
    assert all(s.closed for s in sockets)
    assert (
        reference_url("https://Paper.Example.org:443/paper.pdf#view")
        == "https://paper.example.org/paper.pdf"
    )


def test_metadata_pdf_and_redirect():
    client, calls, sockets = wire(
        {
            ("paper.example.org", "/article"): {
                "body": b'<meta name="citation_pdf_url" content="https://cdn.example.org/full.pdf">',
                "headers": {"Content-Type": "text/html"},
            },
            ("cdn.example.org", "/full.pdf"): {
                "status": 302,
                "headers": {"Location": "/current.pdf"},
            },
            ("cdn.example.org", "/current.pdf"): {"body": b"%PDF-public"},
        }
    )
    assert client.pdf("https://paper.example.org/article") == b"%PDF-public"
    assert ("cdn.example.org", "8.8.8.8", "/current.pdf") in [c[:3] for c in calls]
    assert all(s.closed for s in sockets)


def test_private_metadata_is_not_fetched_and_html_not_saved():
    client, calls, _ = wire(
        {
            ("paper.example.org", "/article"): {
                "body": b'<meta name="citation_pdf_url" content="https://127.0.0.1/secret.pdf"><p>Login required</p>',
                "headers": {"Content-Type": "text/html"},
            }
        }
    )
    with pytest.raises(ValueError, match="未找到可公开下载"):
        client.pdf("https://paper.example.org/article")
    assert all(c[0] == "paper.example.org" for c in calls)


def test_private_redirect_rejected():
    client, calls, sockets = wire(
        {
            ("paper.example.org", "/article"): {
                "status": 302,
                "headers": {"Location": "https://127.0.0.1/secret"},
            }
        }
    )
    with pytest.raises(ValueError, match="公网 HTTPS"):
        client.pdf("https://paper.example.org/article")
    assert all(c[0] == "paper.example.org" for c in calls) and all(s.closed for s in sockets)


def test_dns_rebinding_guard(monkeypatch):
    monkeypatch.setattr(
        module.solution_ai.socket,
        "getaddrinfo",
        lambda *a, **k: [(2, 1, 6, "", ("127.0.0.1", 443))],
    )
    factory = Mock()
    client = ReferenceClient(connection_factory=factory)
    with pytest.raises(ValueError, match="公网地址"):
        client.pdf("https://paper.example.org/paper.pdf")
    factory.assert_not_called()


def test_robots_and_size_limits(monkeypatch):
    client, calls, _ = wire(
        {("paper.example.org", "/robots.txt"): {"body": b"User-agent: *\nDisallow: /paper.pdf\n"}}
    )
    with pytest.raises(ValueError, match="不允许下载"):
        client.pdf("https://paper.example.org/paper.pdf")
    assert len(calls) == 1
    client, _, sockets = wire(
        {("paper.example.org", "/paper.pdf"): {"body": b"%PDF-" + b"x" * 100}}
    )
    monkeypatch.setattr(module, "MAX_BYTES", 30)
    with pytest.raises(ValueError, match="25 MB"):
        client.pdf("https://paper.example.org/paper.pdf")
    assert all(s.closed for s in sockets)


def test_http_errors_and_non_pdf():
    for value, message in [({"status": 403}, "HTTP 403"), ({"body": b"plain"}, "没有返回 PDF")]:
        client, _, _ = wire({("paper.example.org", "/paper.pdf"): value})
        with pytest.raises(ValueError, match=message):
            client.pdf("https://paper.example.org/paper.pdf")


def test_each_request_rechecks_dns_and_rebinding_stops_before_pdf(monkeypatch):
    client, calls, _ = wire({})
    client.resolve = module.solution_ai.resolved_addresses
    responses = iter(["8.8.8.8", "127.0.0.1"])
    monkeypatch.setattr(
        module.solution_ai.socket,
        "getaddrinfo",
        lambda *a, **k: [(2, 1, 6, "", (next(responses), 443))],
    )
    with pytest.raises(ValueError, match="公网地址"):
        client.pdf("https://paper.example.org/paper.pdf")
    assert [c[2] for c in calls] == ["/robots.txt"]


def test_url_encodes_unicode_path_and_preserves_signed_query():
    assert (
        reference_url("https://paper.example.org/论文.pdf?key=a%2Bb&lang=中文#page=2")
        == "https://paper.example.org/%E8%AE%BA%E6%96%87.pdf?key=a%2Bb&lang=%E4%B8%AD%E6%96%87"
    )


@pytest.mark.parametrize(
    "url",
    [
        "https://8.8.8.8/paper.pdf",
        "https://[2606:4700:4700::1111]/paper.pdf",
        "https://paper.example/paper.pdf",
        "https://paper.onion/paper.pdf",
        "https://-paper.example.org/paper.pdf",
        "https://paper-.example.org/paper.pdf",
    ],
)
def test_bridge_incompatible_domains_rejected_before_download(url):
    with pytest.raises(ValueError, match="域名"):
        reference_url(url)


@pytest.mark.parametrize("body", [b" %PDF-1.7", b"\n%PDF-1.7", b"\xef\xbb\xbf%PDF-1.7"])
def test_pdf_magic_must_start_at_first_byte_without_mutating_original(body):
    client, _, _ = wire({("paper.example.org", "/paper.pdf"): {"body": body}})
    with pytest.raises(ValueError, match="没有返回 PDF"):
        client.pdf("https://paper.example.org/paper.pdf")
