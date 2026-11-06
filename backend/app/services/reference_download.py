"""Bounded, unauthenticated public PDF retrieval for explicitly imported citations."""

import http.client
import re
import time
from html.parser import HTMLParser
from urllib.parse import quote, urljoin, urlsplit, urlunsplit
from urllib.robotparser import RobotFileParser

from app.services import solution_ai, web_search
from app.services.information.ich import USER_AGENT

MAX_BYTES = 25 * 1024 * 1024
HTML_BYTES = 2 * 1024 * 1024
BUDGET_SECONDS = 75


class ReferenceDownloadError(ValueError):
    """Safe download outcome; never include URLs, credentials or response bodies."""

    def __init__(self, message, *, code, retryable=False):
        super().__init__(message)
        self.code = code
        self.retryable = retryable


def no_pdf():
    return ReferenceDownloadError(
        "无法下载：未找到可公开下载的 PDF。已保留来源链接，可打开原始链接查看。",
        code="no_pdf",
    )


def reference_url(value):
    if not web_search.safe_url(value) or "\\" in value:
        raise ValueError("参考论文地址必须是不含凭据的公网 HTTPS 地址")
    parts = urlsplit(value)
    host = parts.hostname.encode("idna").decode().lower().rstrip(".")
    # Match the signed KB bridge domain contract after harmless URL normalization.
    # Numeric and IPv6 literals cannot match this DNS grammar. Reserved/private
    # suffixes are rejected before storing metadata, not after a PDF download.
    if not re.fullmatch(
        r"(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*", host
    ) or re.search(r"(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion)$", host):
        raise ValueError("参考论文来源必须是无凭据的公网 HTTPS 域名地址，不支持 IP 或保留域名")
    return urlunsplit(
        (
            "https",
            host,
            quote(parts.path or "/", safe="/%:@!$&'()*+,;=-._~"),
            quote(parts.query, safe="%=&?/:@!$'()*+,;~-._"),
            "",
        )
    )


class PDFLinks(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.preferred, self.attachments = [], []

    def handle_starttag(self, tag, attrs):
        values = {key.lower(): value or "" for key, value in attrs}
        if tag == "meta" and values.get("name", "").lower() == "citation_pdf_url":
            self.preferred.append(values.get("content", ""))
        if tag == "link" and values.get("type", "").lower() == "application/pdf":
            self.preferred.append(values.get("href", ""))
        if tag == "a" and values.get("href", "").split("?", 1)[0].split("#", 1)[0].lower().endswith(
            ".pdf"
        ):
            self.attachments.append(values.get("href", ""))


class ReferenceClient:
    """Pin the validated DNS address while verifying TLS against the real hostname.

    Redirects and HTML PDF metadata are validated independently. Browser cookies,
    model credentials and proxy settings are never forwarded to document hosts.
    """

    def __init__(self, *, resolver=None, connection_factory=None):
        self.resolve = resolver or solution_ai.resolved_addresses
        self.connection = connection_factory or solution_ai.PinnedHTTPSConnection
        self.robots = {}
        self.deadline = 0
        self.transferred = 0

    def close(self):
        pass  # Each individual response closes its socket, including error paths.

    def _remaining(self):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise ReferenceDownloadError(
                "PDF 下载超时，请稍后重试；来源链接已保留。", code="timeout", retryable=True
            )
        return min(30, remaining)

    def _robots_allowed(self, url):
        parts = urlsplit(url)
        origin = urlunsplit(("https", parts.netloc, "", "", ""))
        if origin not in self.robots:
            data, _, _, status = self._fetch(origin + "/robots.txt", robots=False, limit=65536)
            parser = RobotFileParser()
            if status in (404, 410):
                parser.parse([])
            else:
                parser.parse(data.decode("utf8", errors="replace").splitlines())
            self.robots[origin] = parser
        if not self.robots[origin].can_fetch(USER_AGENT, url):
            raise ReferenceDownloadError(
                "无法下载：来源网站不允许下载此公开资料。已保留来源链接，请打开原始链接查看。",
                code="source_forbidden",
            )

    def _fetch(self, url, *, robots=True, limit=MAX_BYTES):
        for _ in range(5):
            url = reference_url(url)
            if robots:
                self._robots_allowed(url)
            parts = urlsplit(url)
            try:
                addresses = self.resolve(parts.hostname, 443, allow_private=False)
            except Exception:
                raise ValueError("参考论文地址无法解析为允许访问的公网地址") from None
            conn = self.connection(parts.hostname, 443, addresses[0], timeout=self._remaining())
            try:
                path = parts.path + ("?" + parts.query if parts.query else "")
                conn.request(
                    "GET", path, headers={"User-Agent": USER_AGENT, "Accept-Encoding": "identity"}
                )
                response = conn.getresponse()
                if response.status in (301, 302, 303, 307, 308):
                    location = response.getheader("Location")
                    if not location:
                        raise ValueError("参考论文来源返回无效跳转")
                    url = reference_url(urljoin(url, location))
                    continue
                if not robots and response.status in (404, 410):
                    return b"", "", url, response.status
                if response.status != 200:
                    raise ReferenceDownloadError(
                        f"无法下载：来源网站返回 HTTP {response.status}。已保留来源链接。",
                        code="source_forbidden" if response.status in (401, 403) else "http_error",
                        retryable=response.status in (429, 500, 502, 503, 504),
                    )
                content_type = response.getheader("Content-Type", "").lower()
                bound = min(limit, HTML_BYTES) if "text/html" in content_type else limit
                length = response.getheader("Content-Length")
                if length and (not length.isdigit() or int(length) > bound):
                    raise ValueError("参考论文文件超过允许大小或返回长度无效")
                chunks, size = [], 0
                while True:
                    if conn.sock is not None:
                        conn.sock.settimeout(self._remaining())
                    chunk = response.read(min(65536, bound + 1 - size))
                    self._remaining()
                    if not chunk:
                        break
                    size += len(chunk)
                    self.transferred += len(chunk)
                    if size > bound or self.transferred > MAX_BYTES:
                        raise ValueError("参考论文文件超过 25 MB 下载上限")
                    chunks.append(chunk)
                return b"".join(chunks), content_type, url, response.status
            except (OSError, http.client.HTTPException) as exc:
                raise ReferenceDownloadError(
                    "PDF 来源连接失败或超时，请稍后重试；来源链接已保留。",
                    code="timeout" if isinstance(exc, TimeoutError) else "network_error",
                    retryable=True,
                ) from None
            finally:
                conn.close()
        raise ValueError("参考论文地址重定向次数过多")

    def pdf(self, url):
        self.deadline = time.monotonic() + BUDGET_SECONDS
        self.transferred = 0
        data, content_type, resolved, _ = self._fetch(url)
        if data.startswith(b"%PDF-"):
            return data
        if "html" not in content_type and not data.lstrip().startswith(b"<"):
            raise no_pdf()
        if len(data) > HTML_BYTES:
            raise ValueError("参考论文页面超过解析上限")
        parser = PDFLinks()
        parser.feed(data.decode("utf8", errors="replace"))
        candidates = []
        for link in parser.preferred + parser.attachments:
            try:
                candidate = reference_url(urljoin(resolved, link))
            except ValueError:
                continue
            if candidate not in candidates and candidate != resolved:
                candidates.append(candidate)
            if len(candidates) == 3:
                break
        errors = []
        for candidate in candidates:
            try:
                body, _, _, _ = self._fetch(candidate)
                if body.startswith(b"%PDF-"):
                    return body
            except ValueError as exc:
                errors.append(exc)
        if errors:
            # A temporary failure may still hide the only downloadable PDF. Do not
            # let a later permanent candidate denial suppress its bounded retry.
            raise next(
                (
                    exc
                    for exc in errors
                    if isinstance(exc, ReferenceDownloadError) and exc.retryable
                ),
                errors[-1],
            )
        raise no_pdf()
