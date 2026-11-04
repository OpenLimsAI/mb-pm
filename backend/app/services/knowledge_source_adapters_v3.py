"""Bounded public-source discovery. Results are metadata, never saved PDF claims."""

import hashlib
import html
import json
import re
import time
from datetime import datetime
from html.parser import HTMLParser
from urllib.parse import quote, urlencode, urljoin, urlsplit
from xml.etree import ElementTree

from app.services.reference_download import ReferenceClient, reference_url

TEMPLATES = [
    {
        "id": "fda",
        "name": "FDA 指导原则",
        "url": "https://www.fda.gov/regulatory-information/search-fda-guidance-documents",
        "endpoint": "https://www.fda.gov/files/api/datatables/static/search-for-guidance.json",
        "capabilities": ["官方目录关键词检索", "公开原文按需下载"],
        "coverage": "FDA 官网指导原则表格公开数据；检索结果不是已下载文件。",
        "documentation": "https://www.fda.gov/regulatory-information/search-fda-guidance-documents",
    },
    {
        "id": "ema",
        "name": "EMA 科学指南",
        "url": "https://www.ema.europa.eu/en/human-regulatory-overview/research-development/scientific-guidelines-human-medicines",
        "endpoint": "https://www.ema.europa.eu/en/human-regulatory-overview/research-development/scientific-guidelines/quality-guidelines",
        "capabilities": ["质量指南目录关键词筛选", "公开原文按需下载"],
        "coverage": "本版按检索词优先读取最多 4 个 EMA 质量分类目录，不代表全站或全部治疗领域。",
        "documentation": "https://www.ema.europa.eu/en/human-regulatory-overview/research-development/scientific-guidelines-human-medicines",
    },
    {
        "id": "cde",
        "name": "NMPA / CDE 近期指导原则",
        "url": "https://www.cde.org.cn/",
        "endpoint": "https://www.cde.org.cn/",
        "capabilities": ["近期指导原则通告筛选", "公开附件按需下载"],
        "coverage": "本版读取药审中心首页当前指导原则通告；不遍历完整历史目录，不绕过网站验证。",
        "documentation": "https://www.cde.org.cn/zdyz/index",
    },
    {
        "id": "pubmed",
        "name": "PubMed 文献",
        "url": "https://pubmed.ncbi.nlm.nih.gov/",
        "endpoint": "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/",
        "capabilities": ["PubMed 关键词检索", "PMID / DOI 元数据", "公开全文按需尝试"],
        "coverage": "NCBI E-utilities 元数据；PubMed 条目和摘要不等于免费 PDF，无法下载时保留原文入口。",
        "documentation": "https://www.nlm.nih.gov/dataguide/eutilities/utilities.html",
    },
]


def clean(value):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", str(value or "")))).strip()


class Anchors(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.links, self.current, self.text = [], None, []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            self.current, self.text = dict(attrs).get("href"), []

    def handle_data(self, data):
        if self.current is not None:
            self.text.append(data)

    def handle_endtag(self, tag):
        if tag == "a" and self.current is not None:
            self.links.append((self.current, clean(" ".join(self.text))))
            self.current, self.text = None, []


def links(value, base):
    parser = Anchors()
    parser.feed(str(value))
    result = []
    for url, title in parser.links:
        try:
            url = reference_url(urljoin(base, url))
        except ValueError:
            continue
        result.append((url, title))
    return result


def record(title, url, template, **metadata):
    url = reference_url(url)
    return {
        "id": hashlib.sha256(url.encode()).hexdigest(),
        "title": clean(title)[:1000] or url,
        "url": url,
        "templateId": template,
        "metadata": metadata,
        "availability": "metadata_only",
    }


def parse_fda(payload):
    rows = payload.get("data", []) if isinstance(payload, dict) else payload
    if not isinstance(rows, list):
        raise ValueError("FDA 官方目录格式已变化，请通过官网检索")
    out = []
    for row in rows:
        values = list(row.values()) if isinstance(row, dict) else row
        if not isinstance(values, list):
            continue
        anchors = [item for value in values for item in links(value, "https://www.fda.gov")]
        official = [
            (url, title)
            for url, title in anchors
            if urlsplit(url).hostname in {"www.fda.gov", "fda.gov"}
            and (
                "/regulatory-information/search-fda-guidance-documents/" in url or "/media/" in url
            )
        ]
        if not official:
            continue
        url, title = official[0]
        heading = next((text for _, text in official if len(text) > 12), "")
        if not heading:
            heading = max((clean(value) for value in values), key=len, default="")
        issued = clean(row.get("field_issue_datetime", "")) if isinstance(row, dict) else ""
        try:
            published = datetime.strptime(issued, "%m/%d/%Y").date().isoformat()
        except ValueError:
            published = ""
        out.append(
            record(
                heading or title,
                url,
                "fda",
                description=clean(" ".join(map(str, values)))[:2500],
                publishedAt=published,
                year=published[:4],
                officialStatus=clean(row.get("field_final_guidance_1", ""))
                if isinstance(row, dict)
                else "",
            )
        )
    if not out:
        raise ValueError("FDA 官方目录没有可识别的指导原则，保留既有资料")
    unique = {item["url"]: item for item in out}
    return sorted(
        unique.values(), key=lambda item: item["metadata"].get("publishedAt", ""), reverse=True
    )


def parse_official_html(text, template):
    config = next(t for t in TEMPLATES if t["id"] == template)
    out, seen = [], set()
    for url, title in links(text, config["endpoint"]):
        host, path = urlsplit(url).hostname, urlsplit(url).path
        if template == "ema":
            match = host == "www.ema.europa.eu" and (
                path.startswith("/en/documents/")
                or path.startswith("/en/scientific-guidelines/")
                or path.startswith("/en/")
                and path.endswith("-scientific-guideline")
            )
            match = match and path not in {
                urlsplit(config["endpoint"]).path,
                urlsplit(config["url"]).path,
            }
        else:
            match = (
                host == "www.cde.org.cn"
                and "/main/news/viewInfoCommon/" in path
                and bool(re.search(r"指导原则|指南|技术要求", title))
            )
        if match and len(title) >= 8 and url not in seen:
            out.append(record(title, url, template))
            seen.add(url)
    if not out:
        raise ValueError("官方目录当前不可解析或需要网站验证，请通过官网查看；既有资料保留")
    return out


def search_ema(client, query):
    config = next(t for t in TEMPLATES if t["id"] == "ema")
    index = client.data(config["endpoint"])
    categories = [
        (url, title)
        for url, title in links(index, config["endpoint"])
        if urlsplit(url).hostname == "www.ema.europa.eu"
        and urlsplit(url).path.startswith(
            "/en/human-regulatory/research-development/scientific-guidelines/quality/quality-"
        )
    ]
    categories = list(dict.fromkeys(categories))
    if not categories:
        raise ValueError("EMA 质量分类目录结构已变化，请通过官网查看")
    hints = {
        "稳定": "stability",
        "分析": "analytical",
        "杂质": "impurities",
        "生产": "manufacturing",
        "包装": "packaging",
        "辅料": "excipients",
        "活性": "active-substance",
        "生命周期": "lifecycle",
    }
    tokens = query.casefold().split()
    tokens += [hint for name, hint in hints.items() if name in query]
    categories.sort(
        key=lambda item: not any(token in (item[0] + " " + item[1]).casefold() for token in tokens)
    )
    found, checked, failed = [], [], []
    for url, title in categories[:4]:
        try:
            rows = parse_official_html(client.data(url), "ema")
            found.extend(rows)
            checked.append(title)
        except ValueError:
            failed.append(title)
    if not checked:
        raise ValueError("EMA 分类目录暂时无法读取，请通过官网查看，既有资料保留")
    unique = {r["url"]: r for r in found}
    return list(unique.values()), checked, failed


def parse_pubmed(text):
    # E-utilities returns a small, bounded XML document. Never accept arbitrary XML endpoints.
    if "<!ENTITY" in text.upper():
        raise ValueError("PubMed 元数据格式无效")
    root = ElementTree.fromstring(text)
    result = []
    for article in root.findall(".//PubmedArticle"):
        pmid = article.findtext(".//MedlineCitation/PMID", "").strip()
        if not pmid.isdigit():
            continue
        title = (
            "".join(article.find(".//ArticleTitle").itertext())
            if article.find(".//ArticleTitle") is not None
            else ""
        )
        doi = next(
            (clean(x.text) for x in article.findall(".//ArticleId") if x.get("IdType") == "doi"), ""
        )
        authors = [
            clean(
                " ".join(
                    filter(
                        None,
                        (
                            a.findtext("ForeName"),
                            a.findtext("LastName"),
                            a.findtext("CollectiveName"),
                        ),
                    )
                )
            )
            for a in article.findall(".//Author")
        ]
        abstract = "\n".join("".join(a.itertext()) for a in article.findall(".//AbstractText"))
        year = article.findtext(".//PubDate/Year") or article.findtext(".//PubDate/MedlineDate", "")
        result.append(
            record(
                title,
                "https://pubmed.ncbi.nlm.nih.gov/" + pmid + "/",
                "pubmed",
                pmid=pmid,
                doi=doi,
                authors=authors[:100],
                abstract=abstract[:16000],
                year=year[:40],
                journal=article.findtext(".//Journal/Title", ""),
            )
        )
    return result


class MetadataClient:
    def __init__(self):
        self.client = ReferenceClient()
        self.client.deadline = time.monotonic() + 60
        self.last_api_at = 0.0

    def data(self, url, *, api=False, limit=8 * 1024 * 1024):
        if api and urlsplit(url).hostname not in {
            "eutils.ncbi.nlm.nih.gov",
            "api.crossref.org",
            "www.fda.gov",
        }:
            raise ValueError("未适配的元数据接口")
        if api:
            delay = 0.36 - (time.monotonic() - self.last_api_at)
            if delay > 0:
                time.sleep(delay)
            self.last_api_at = time.monotonic()
        body, _, _, _ = self.client._fetch(url, robots=not api, limit=limit)
        return body.decode("utf-8", errors="replace")

    def close(self):
        self.client.close()


def pubmed_records(client, ids):
    valid = [value for value in ids if re.fullmatch(r"\d{1,10}", value)]
    if not valid:
        return []
    records = parse_pubmed(
        client.data(
            "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?"
            + urlencode(
                {
                    "db": "pubmed",
                    "id": ",".join(valid),
                    "retmode": "xml",
                    "tool": "MBERPKnowledgeSources",
                }
            ),
            api=True,
        )
    )
    if not records:
        raise ValueError("PubMed 暂未返回可识别的文献元数据，请稍后重试")
    return [record for record in records if record["metadata"].get("pmid") in valid]


def search(template_id, query, limit=20, *, client=None):
    config = next((t for t in TEMPLATES if t["id"] == template_id), None)
    if not config:
        raise ValueError("请选择已适配的来源模板")
    query = query.strip()
    if not query or len(query) > 300:
        raise ValueError("请填写 1—300 字的检索词")
    limit = max(1, min(30, limit))
    owned = client is None
    client = client or MetadataClient()
    try:
        if template_id == "pubmed":
            payload = json.loads(
                client.data(
                    config["endpoint"]
                    + "esearch.fcgi?"
                    + urlencode(
                        {
                            "db": "pubmed",
                            "term": query,
                            "retmode": "json",
                            "retmax": limit,
                            "sort": "pub_date",
                            "tool": "MBERPKnowledgeSources",
                        }
                    ),
                    api=True,
                )
            )
            result = payload.get("esearchresult")
            if (
                not isinstance(result, dict)
                or not isinstance(result.get("idlist"), list)
                or "count" not in result
            ):
                raise ValueError("PubMed 检索暂不可用或请求已限流，请稍后重试")
            ids = result["idlist"]
            found = pubmed_records(client, ids)
            total = int(result["count"])
        else:
            if template_id == "ema":
                all_rows, checked, failed = search_ema(client, query)
                coverage = (
                    config["coverage"]
                    + " 本次已检查："
                    + "、".join(checked)
                    + ("；读取失败：" + "、".join(failed) if failed else "")
                )
            else:
                raw = client.data(config["endpoint"], api=template_id == "fda")
                all_rows = (
                    parse_fda(json.loads(raw))
                    if template_id == "fda"
                    else parse_official_html(raw, template_id)
                )
                coverage = config["coverage"]
            tokens = query.casefold().split()
            found = [
                r
                for r in all_rows
                if all(
                    t
                    in (r["title"] + " " + json.dumps(r["metadata"], ensure_ascii=False)).casefold()
                    for t in tokens
                )
            ]
            total = len(found)
        return {
            "items": found[:limit],
            "total": total,
            "truncated": total > limit,
            "coverage": coverage if template_id != "pubmed" else config["coverage"],
            "officialUrl": config["url"],
        }
    except (json.JSONDecodeError, ElementTree.ParseError, TypeError, KeyError) as exc:
        raise ValueError("官方来源返回格式变化，请稍后重试或在官网查看") from exc
    finally:
        if owned:
            client.close()


def resolve_identifier(value, *, client):
    value = value.strip()
    doi_match = re.fullmatch(
        r"(?:https?://(?:dx\.)?doi\.org/|doi:\s*)?(10\.\d{4,9}/\S+)", value, re.I
    )
    if doi_match:
        doi = doi_match.group(1).rstrip(".,;")
        payload = json.loads(
            client.data("https://api.crossref.org/works/" + quote(doi, safe=""), api=True)
        )
        data = payload.get("message", {})
        return record(
            (data.get("title") or [doi])[0],
            "https://doi.org/" + quote(doi, safe="/"),
            "manual",
            doi=doi,
            authors=[
                clean(" ".join((a.get("given", ""), a.get("family", ""))))
                for a in data.get("author", [])[:100]
            ],
            abstract=clean(data.get("abstract", ""))[:16000],
            year=str((data.get("published", {}).get("date-parts") or [[""]])[0][0]),
            journal=(data.get("container-title") or [""])[0],
        )
    pmid_match = re.fullmatch(
        r"(?:pmid:\s*|https://pubmed\.ncbi\.nlm\.nih\.gov/)?(\d{1,10})/?", value, re.I
    )
    if pmid_match:
        found = pubmed_records(client, [pmid_match.group(1)])
        if not found:
            raise ValueError("没有找到该 PMID 对应的文献")
        return found[0]
    url = reference_url(value)
    return record(urlsplit(url).path.rsplit("/", 1)[-1] or urlsplit(url).hostname, url, "manual")
