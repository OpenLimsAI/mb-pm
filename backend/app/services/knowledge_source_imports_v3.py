"""Unified manual/official metadata intake using the existing reference download worker."""

import time
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError

from app.models.information import InformationEntry
from app.services.information.store import iso
from app.services.reference_download import reference_url


def ensure_source(store, template_id, name):
    ident = store.key("source", "acquisition-v3:" + template_id)
    source = store.get("source", ident, required=False)
    if source is None:
        source = {
            "id": ident,
            "name": name,
            "adapter": "reference",
            "templateId": template_id,
            "originApp": "manual",
            "url": "https://pubmed.ncbi.nlm.nih.gov/"
            if template_id == "pubmed"
            else "https://doi.org/"
            if template_id == "manual"
            else {
                "fda": "https://www.fda.gov",
                "ema": "https://www.ema.europa.eu",
                "cde": "https://www.cde.org.cn",
            }.get(template_id, "https://doi.org/"),
            "scopes": [],
            "folderId": None,
            "enabled": False,
            "status": "ok",
            "scopeStatus": {},
            "baselineScopes": [],
            "frequency": "manual",
            "knowledgeSourceAutoIndex": False,
        }
        try:
            with store.db.begin_nested():
                store.db.add(
                    InformationEntry(
                        id=ident,
                        tenant=store.tenant,
                        kind="source",
                        data=source,
                        updated_at=time.time(),
                    )
                )
                store.db.flush()
        except IntegrityError:
            source = store.get("source", ident)
    return source


def normalized_doi(value):
    return str(value or "").strip().casefold().removeprefix("https://doi.org/").removeprefix("doi:")


def ensure_document(store, source, item):
    url = reference_url(item["url"])
    metadata = item.get("metadata") or {}
    doi = normalized_doi(metadata.get("doi"))
    existing = next(
        (
            doc
            for doc in store.documents()
            if doc.get("url") == url
            or (doi and normalized_doi((doc.get("metadata") or {}).get("doi")) == doi)
        ),
        None,
    )
    if existing:
        return existing, True
    ident = store.key("document", "acquisition-v3:" + ("doi:" + doi if doi else url))
    document = {
        "id": ident,
        "key": ident,
        "sourceId": source["id"],
        "title": str(item["title"]).strip()[:1000] or url,
        "url": url,
        "scopes": [],
        "format": "PDF",
        "language": "来源未标注",
        "documentType": "指导原则"
        if source.get("templateId") in {"fda", "ema", "cde"}
        else "参考论文",
        "officialStatus": "",
        "officialDate": str(metadata.get("year") or "")[:40],
        "description": str(metadata.get("abstract") or metadata.get("description") or "")[:16000],
        "metadata": metadata,
        "status": "discovered",
        "error": None,
        "discoveredAt": iso(),
        "firstNewAt": iso(),
        "newInScopes": [],
        "originApp": "manual",
    }
    try:
        with store.db.begin_nested():
            store.db.add(
                InformationEntry(
                    id=ident,
                    tenant=store.tenant,
                    kind="document",
                    data=document,
                    updated_at=time.time(),
                )
            )
            store.db.flush()
    except IntegrityError:
        return store.get("document", ident), True
    return document, False


def issue_preview(store, subject, items):
    """Only commit source-search metadata the server actually returned to this user."""
    store.db.query(InformationEntry).filter(
        InformationEntry.tenant == store.tenant,
        InformationEntry.kind == "ks_acquisition_preview",
        InformationEntry.data["expiresAt"].as_float() < time.time(),
    ).delete(synchronize_session=False)
    ident = store.key("ks_acquisition_preview", subject + ":" + str(uuid4()))
    token = {
        "id": ident,
        "subject": subject,
        "createdAt": time.time(),
        "expiresAt": time.time() + 3600,
        "items": items,
    }
    store.put("ks_acquisition_preview", token)
    return ident


def preview_items(store, subject, token, ids):
    value = store.get("ks_acquisition_preview", token, required=False)
    if value is None or value.get("subject") != subject or value.get("expiresAt", 0) < time.time():
        raise HTTPException(409, "来源搜索结果已过期，请再次搜索")
    found = {i["id"]: i for i in value.get("items", [])}
    if any(ident not in found for ident in ids):
        raise HTTPException(400, "所选资料不在本人的来源搜索结果中")
    return [found[ident] for ident in dict.fromkeys(ids)]
