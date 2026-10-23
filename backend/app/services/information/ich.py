"""Read the same public JSON catalogue used by ich.org; no guessed document list."""

import hashlib
import html
import ipaddress
import json
import re
import socket
import time
from urllib.parse import unquote, urlencode, urljoin, urlsplit
from urllib.robotparser import RobotFileParser

import httpx

SCOPE_SLUGS = {"Q": "quality", "S": "safety", "E": "efficacy", "M": "multidisciplinary"}
HOSTS = {"admin.ich.org", "database.ich.org", "www.ich.org", "ich.org"}
USER_AGENT = "MBERPInformation/1.0 (+https://www.openlims.ai; internal research archive)"


def plain(value):
    return html.unescape(re.sub(r"<[^>]+>", " ", str(value or ""))).strip()


def validate_public_url(url: str, *, resolve=False) -> str:
    if not isinstance(url, str) or len(url) > 3000 or re.search(r"[\x00-\x20\\]", url):
        raise ValueError("官方资料地址无效")
    p = urlsplit(url)
    if p.scheme != "https" or p.hostname not in HOSTS or p.username or p.password or p.fragment:
        raise ValueError("只允许 HTTPS 的 ICH 官方公开资料地址")
    if p.port not in (None, 443):
        raise ValueError("不允许非标准端口")
    path = unquote(p.path)
    if ".." in path.split("/") or not (
        path.startswith("/sites/default/files/")
        or (p.hostname == "admin.ich.org" and path == "/api/v1/nodes")
        or path == "/robots.txt"
    ):
        raise ValueError("地址不在 ICH 已适配的公开目录或附件范围内")
    if resolve:
        addresses = socket.getaddrinfo(p.hostname, 443, type=socket.SOCK_STREAM)
        if not addresses or any(
            not ipaddress.ip_address(item[4][0]).is_global for item in addresses
        ):
            raise ValueError("官方地址解析到非公网网络，已停止请求")
    return url


def parse_catalogue(value, scope):
    if scope not in SCOPE_SLUGS or not isinstance(value, dict) or not value.get("items"):
        raise ValueError("ICH 目录格式无效或为空，保留上次成功资料")
    records = {}

    def walk(node):
        if isinstance(node, list):
            for entry in node:
                walk(entry)
        elif isinstance(node, dict):
            if isinstance(node.get("fileGroups"), list) and isinstance(node.get("code"), str):
                for group in node["fileGroups"]:
                    for file in group.get("files", []):
                        url = file.get("uri", "")
                        if file.get("mimetype") != "application/pdf" and not urlsplit(
                            url
                        ).path.lower().endswith(".pdf"):
                            continue
                        validate_public_url(url)
                        code = plain(node["code"])
                        label = plain(file.get("title")) or plain(node.get("title"))
                        group_label = plain(group.get("title")) or "Guideline"
                        # Official revision labels may change while the logical document stays the same.
                        canonical = re.sub(
                            r"\(R\d+\)", "", f"{code}|{group_label}|{label}", flags=re.I
                        ).casefold()
                        key = hashlib.sha256(canonical.encode()).hexdigest()
                        records[key] = {
                            "key": key,
                            "title": f'{label} — {plain(node.get("title"))}'[:1000],
                            "code": code,
                            "url": url,
                            "scopes": [scope],
                            "format": "PDF",
                            "language": "来源未标注",
                            "documentType": group_label,
                            "officialStatus": plain(node.get("status")),
                            "officialDate": plain(node.get("details", {}).get("stepDate")),
                            "description": plain(node.get("description"))[:30000],
                        }
            for child in node.values():
                if isinstance(child, dict | list):
                    walk(child)

    walk(value["items"])
    if not records:
        raise ValueError("ICH 目录未发现可识别 PDF；可能是官方结构变化，不视为没有更新")
    return list(records.values())


class OfficialClient:
    def __init__(self, transport=None):
        self.client = httpx.Client(
            timeout=httpx.Timeout(30, connect=12),
            follow_redirects=False,
            headers={"User-Agent": USER_AGENT},
            transport=transport,
            trust_env=False,
        )
        self.robots = {}
        self.last_request = 0.0
        self.resolve = transport is None

    def close(self):
        self.client.close()

    def fetch(self, url, limit=25 * 1024 * 1024, *, robots=True):
        deadline = time.monotonic() + 75
        for _ in range(4):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise httpx.ReadTimeout("Official source request exceeded its wall time")
            validate_public_url(url, resolve=self.resolve)
            origin = "https://" + urlsplit(url).hostname
            if robots:
                if origin not in self.robots:
                    body, _ = self.fetch(origin + "/robots.txt", 65536, robots=False)
                    parser = RobotFileParser()
                    parser.parse(body.decode("utf8", errors="replace").splitlines())
                    self.robots[origin] = parser
                if not self.robots[origin].can_fetch(USER_AGENT, url):
                    raise ValueError("ICH robots 规则不允许采集此地址")
            delay = 0.75 - (time.monotonic() - self.last_request)
            if delay > 0:
                time.sleep(delay)
            self.last_request = time.monotonic()
            with self.client.stream("GET", url, timeout=min(30, remaining)) as response:
                if response.status_code in (301, 302, 303, 307, 308):
                    url = urljoin(url, response.headers.get("location", ""))
                    continue  # Every redirect is independently checked; never forward auth/cookies.
                response.raise_for_status()
                length = response.headers.get("content-length")
                if length and int(length) > limit:
                    raise ValueError("官方文件超过允许大小")
                chunks = []
                size = 0
                for chunk in response.iter_bytes():
                    if time.monotonic() >= deadline:
                        raise httpx.ReadTimeout("Official source download exceeded its wall time")
                    size += len(chunk)
                    if size > limit:
                        raise ValueError("官方文件超过允许大小")
                    chunks.append(chunk)
                return b"".join(chunks), response.headers.get("content-type", "")
        raise ValueError("官方地址重定向次数过多")

    def catalogue(self, scope):
        url = "https://admin.ich.org/api/v1/nodes?" + urlencode(
            {"alias": f"/page/{SCOPE_SLUGS[scope]}-guidelines", "loadEntities[]": "paragraph"}
        )
        data, _ = self.fetch(url, 8 * 1024 * 1024)
        return parse_catalogue(json.loads(data), scope)

    def pdf(self, url):
        data, _ = self.fetch(url)
        if not data.lstrip().startswith(b"%PDF-"):
            raise ValueError("官方下载返回的不是 PDF，未保存为论文")
        return data
