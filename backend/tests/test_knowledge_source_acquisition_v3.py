# ruff: noqa: F811
"""Official-source parsing, durable intake, private watches and readable-only version tools."""

import json
from unittest.mock import Mock

import pytest
from fastapi import HTTPException
from test_information_api import live  # noqa: F401
from test_information_live import catalogue, store  # noqa: F401
from test_information_portal import information_portal  # noqa: F401
from test_knowledge_sources import headers, ks, records, saved_document  # noqa: F401

from app.api.v1 import knowledge_source_acquisition_v3 as api
from app.main import app
from app.models.note import PersonalNote
from app.models.solution import KnowledgeSolution
from app.services import knowledge_source_adapters_v3 as adapters
from app.services import knowledge_source_changes_v3 as changes
from app.services import knowledge_source_imports_v3 as imports

BASE = "/api/v1/knowledge-sources/v3"
# Tests also run independently before root integration registers the new router.
if not any(getattr(route, "path", "") == BASE + "/templates" for route in app.routes):
    app.include_router(api.router, prefix="/api/v1")

PUBMED = """<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>1234</PMID><Article><ArticleTitle>Stability of <i>Proteins</i></ArticleTitle><Abstract><AbstractText Label="METHOD">Frozen storage</AbstractText></Abstract><AuthorList><Author><ForeName>Mei</ForeName><LastName>Li</LastName></Author></AuthorList><Journal><Title>Journal</Title><JournalIssue><PubDate><Year>2026</Year></PubDate></JournalIssue></Journal></Article></MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="doi">10.1234/stable</ArticleId></ArticleIdList></PubmedData></PubmedArticle></PubmedArticleSet>"""


class FakeClient:
    def __init__(self, values):
        self.values = iter(values)
        self.urls = []

    def data(self, url, **kwargs):
        self.urls.append(url)
        return next(self.values)


def test_pubmed_retrieves_real_metadata_without_claiming_a_pdf():
    client = FakeClient(
        [json.dumps({"esearchresult": {"idlist": ["1234"], "count": "120"}}), PUBMED]
    )
    result = adapters.search("pubmed", "protein stability", 10, client=client)
    assert "term=protein+stability" in client.urls[0]
    assert "efetch.fcgi" in client.urls[1] and "id=1234" in client.urls[1]
    item = result["items"][0]
    assert item["title"] == "Stability of Proteins" and item["metadata"]["authors"] == ["Mei Li"]
    assert item["metadata"]["doi"] == "10.1234/stable"
    assert item["availability"] == "metadata_only"
    assert result["total"] == 120 and result["truncated"]


def test_fda_and_official_html_parsers_reject_navigation_and_foreign_links():
    payload = {
        "data": [
            [
                "<a href='/regulatory-information/search-fda-guidance-documents/stability'>Stability guidance</a>",
                "<a href='/media/12345/download'>Download PDF</a>",
                "2026",
            ]
        ]
    }
    fda = adapters.parse_fda(payload)
    assert len(fda) == 1 and fda[0]["title"] == "Stability guidance"
    html = """<a href='/en/documents/scientific-guideline/stability_en.pdf'>Stability of proteins</a><a href='https://foreign.org/en/documents/secret.pdf'>Foreign attachment</a><a href='/en/about-us'>About the Agency</a>"""
    ema = adapters.parse_official_html(html, "ema")
    assert len(ema) == 1 and ema[0]["url"].startswith("https://www.ema.europa.eu/")
    html = """<a href='/main/news/viewInfoCommon/abcdef'>关于发布稳定性研究技术指导原则的通告</a><a href='/main/news/viewInfoCommon/hello'>联系我们</a>"""
    assert len(adapters.parse_official_html(html, "cde")) == 1
    with pytest.raises(ValueError):
        adapters.parse_official_html("<h1>Checking your browser</h1>", "cde")


def test_doi_identifier_encoding_and_private_url_rejection():
    client = FakeClient(
        [
            json.dumps(
                {
                    "message": {
                        "title": ["A study"],
                        "DOI": "10.1234/a?b",
                        "author": [{"given": "Mei", "family": "Li"}],
                        "published": {"date-parts": [[2026]]},
                    }
                }
            )
        ]
    )
    result = adapters.resolve_identifier("doi:10.1234/a?b", client=client)
    assert client.urls == ["https://api.crossref.org/works/10.1234%2Fa%3Fb"]
    assert result["url"] == "https://doi.org/10.1234/a%3Fb"
    assert result["metadata"]["authors"] == ["Mei Li"]
    for bad in [
        "http://127.0.0.1/private",
        "https://user:password@publisher.org/",
        "https://service.internal/paper.pdf",
    ]:
        with pytest.raises(ValueError):
            adapters.resolve_identifier(bad, client=client)
    with pytest.raises(ValueError):
        adapters.parse_pubmed('<!DOCTYPE a [<!ENTITY key "secret">]><a/>')


def test_import_source_preserves_folder_and_deduplicates_doi(ks):
    _, db, _, _, _, _ = ks
    store = records(db)
    source = imports.ensure_source(store, "manual", "手动收录")
    source["folderId"] = "existing-folder"
    store.put("source", source)
    first, existing = imports.ensure_document(
        store,
        source,
        adapters.record("One", "https://doi.org/10.1234/abc", "manual", doi="10.1234/abc"),
    )
    assert not existing
    again = imports.ensure_source(store, "manual", "手动收录")
    assert again["folderId"] == "existing-folder"
    other = imports.ensure_source(store, "pubmed", "PubMed")
    second, existing = imports.ensure_document(
        store,
        other,
        adapters.record(
            "Same paper", "https://pubmed.ncbi.nlm.nih.gov/1234/", "pubmed", doi="10.1234/ABC"
        ),
    )
    assert existing and first["id"] == second["id"]
    assert len(store.documents()) == 1
    assert store.records("job") == [] and store.records("version") == []


def test_preview_is_owner_bound_expires_and_cannot_forge_item_ids(ks):
    _, db, _, _, _, _ = ks
    store = records(db)
    item = adapters.record("Official", "https://www.fda.gov/media/12345/download", "fda")
    token = imports.issue_preview(store, "one", [item])
    assert imports.preview_items(store, "one", token, [item["id"]]) == [item]
    for subject, ids in [("two", [item["id"]]), ("one", ["made-up"])]:
        with pytest.raises(HTTPException):
            imports.preview_items(store, subject, token, ids)
    expired = store.get("ks_acquisition_preview", token)
    expired["expiresAt"] = 1
    store.put("ks_acquisition_preview", expired)
    with pytest.raises(HTTPException):
        imports.preview_items(store, "one", token, [item["id"]])
    imports.issue_preview(store, "one", [])
    assert store.get("ks_acquisition_preview", token, required=False) is None


def test_watches_are_private_exact_codes_aggregate_and_mute(ks):
    _, db, _, _, _, _ = ks
    store = records(db)
    source = store.ensure_source()
    store.event("正文修订", "Q5C protein stability", source["id"], "doc")
    store.event("正文修订", "Q50 unrelated", source["id"], "other")
    changes.save_watch(store, "one", {"name": "Q5C", "codes": "Q5C", "sourceIds": [source["id"]]})
    assert changes.digest(store, "two")["groups"] == []
    digest = changes.digest(store, "one")
    assert len(digest["groups"]) == 1 and digest["groups"][0]["count"] == 1
    event = digest["groups"][0]["events"][0]
    changes.mark_digest_read(store, "one", [event["id"]])
    assert changes.digest(store, "one")["groups"][0]["unread"] == 0
    rule = changes.watches(store, "one")[0]
    changes.save_watch(store, "one", {**rule, "muted": True})
    assert changes.digest(store, "one")["groups"] == []
    with pytest.raises(HTTPException):
        changes.save_watch(store, "one", {"name": "   "})


def test_body_diff_keeps_old_new_text_and_never_labels_lines_as_pdf_pages():
    result = changes.body_diff(
        {"id": "v1", "text": "Header\nOld method"},
        {"id": "v2", "text": "Header\nNew method\nAdditional condition"},
    )
    assert result["available"] and result["blocks"][0]["before"] == "Old method"
    assert result["blocks"][0]["after"] == "New method\nAdditional condition"
    assert result["blocks"][0]["beforeLine"] == 2
    assert "不是 PDF 页码" in result["basis"]
    assert not changes.body_diff({"id": "v1"}, {"id": "v2", "text": "New"})["available"]
    long = changes.body_diff({"id": "v1", "text": "A\n" * 9000}, {"id": "v2", "text": "B\n" * 9000})
    assert long["truncated"] and len(long["blocks"]) <= 300


def test_impact_links_match_only_owner_and_explicit_identifiers(ks):
    _, db, _, _, _, _ = ks
    actor = {"issuer": "issuer", "subject": "owner"}
    document = {"id": "d" * 64, "url": "https://publisher.org/paper"}
    versions = [{"id": "a" * 64}, {"id": "b" * 64}]
    db.add_all(
        [
            PersonalNote(
                id="n1",
                issuer="issuer",
                owner_id="owner",
                title="Mine",
                content="Reference " + "a" * 64,
            ),
            PersonalNote(
                id="n2", issuer="issuer", owner_id="other", title="Private", content=document["url"]
            ),
            KnowledgeSolution(
                id="r1",
                issuer="issuer",
                owner_id="owner",
                owner_name="Owner",
                title="Report",
                sections=[{"content": document["url"]}],
            ),
        ]
    )
    db.flush()
    result = changes.usage_links(db, actor, document, versions, [])
    assert {i["id"] for i in result["items"]} == {"n1", "r1"}
    note = next(i for i in result["items"] if i["kind"] == "note")
    assert note["olderVersion"]
    assert next(i for i in result["items"] if i["kind"] == "report")["versionUnknown"]


def test_acquisition_http_guards_and_metadata_only_import(ks, monkeypatch):
    client, db, session, role, state, _ = ks
    assert client.get(BASE + "/templates").status_code == 401
    assert (
        client.post(
            BASE + "/acquisition/import",
            headers=session(),
            json={"items": [{"input": "https://publisher.org/paper"}]},
        ).status_code
        == 403
    )
    role["value"] = "kb_viewer"
    assert (
        client.post(
            BASE + "/acquisition/import",
            headers=headers(session),
            json={"items": [{"input": "https://publisher.org/paper"}]},
        ).status_code
        == 403
    )
    role["value"] = "kb_manager"
    result = client.post(
        BASE + "/acquisition/import",
        headers=headers(session),
        json={
            "items": [{"input": "https://publisher.org/paper", "title": "My paper"}],
            "download": False,
        },
    )
    assert result.status_code == 201, result.text
    payload = result.json()
    assert payload["metadataOnly"] and payload["items"][0]["title"] == "My paper"
    assert records(db).records("job") == []
    assert (
        client.post(
            BASE + "/acquisition/import", headers=headers(session), json={"documentIds": ["forged"]}
        ).status_code
        == 400
    )
    state["canWrite"] = False
    assert (
        client.post(
            BASE + "/acquisition/import",
            headers=headers(session),
            json={"items": [{"input": "https://publisher.org/other"}]},
        ).status_code
        == 403
    )


def test_version_diff_http_does_not_resurrect_hidden_papers(ks):
    client, db, session, _, state, _ = ks
    store, _, document, version = saved_document(db, linked=True)
    path = BASE + "/versions/diff"
    body = {"documentId": document["id"], "beforeId": version["id"], "afterId": version["id"]}
    ok = client.post(path, headers=headers(session), json=body)
    assert ok.status_code == 200, ok.text
    assert ok.json()["available"]
    state["papers"] = []
    denied = client.post(path, headers=headers(session), json=body)
    assert denied.status_code == 404


def test_search_http_returns_server_receipt_not_download(ks, monkeypatch):
    client, db, session, _, _, _ = ks
    item = adapters.record("Study", "https://pubmed.ncbi.nlm.nih.gov/1234/", "pubmed")
    monkeypatch.setattr(
        adapters,
        "search",
        Mock(return_value={"items": [item], "total": 1, "coverage": "PubMed", "truncated": False}),
    )
    response = client.post(
        BASE + "/acquisition/search",
        headers=headers(session),
        json={"templateId": "pubmed", "query": "stability"},
    )
    assert response.status_code == 200
    token = response.json()["previewToken"]
    assert records(db).records("document") == [] and records(db).records("job") == []
    result = client.post(
        BASE + "/acquisition/import",
        headers=headers(session),
        json={"previewToken": token, "documentIds": [item["id"]]},
    )
    assert result.status_code == 201 and len(result.json()["items"]) == 1


def test_ema_checks_real_guideline_links_below_quality_categories():
    client = FakeClient(
        [
            '<a href="/en/human-regulatory/research-development/scientific-guidelines/quality/quality-stability">Stability</a>',
            '<a href="/en/scientific-guidelines/ich-q1a-stability-testing">ICH Q1A Stability testing</a>',
        ]
    )
    result = adapters.search("ema", "stability", client=client)
    assert len(result["items"]) == 1
    assert result["items"][0]["url"].endswith("/en/scientific-guidelines/ich-q1a-stability-testing")
    assert "本次已检查：Stability" in result["coverage"]
    assert changes.matches({"codes": "Q5"}, {"title": "Q5C Guideline"}, {})
    assert not changes.matches({"codes": "Q5"}, {"title": "Q50 Guideline"}, {})
