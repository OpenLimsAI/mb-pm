"""Read projections for the knowledge-source workspace; no collection side effects."""

import copy
import hashlib
import json
import time

from app.services.information.store import iso
from app.services.knowledge_source_references import CATEGORIES, LEGACY_CATEGORIES
from app.services.reference_download import no_pdf

APP = "knowledge-sources"


def version_state(doc, versions):
    if not versions:
        return "not_saved"
    if doc.get("verifiedSha256"):
        if not any(v["sha256"] == doc["verifiedSha256"] for v in versions):
            return "update_available"
        if (
            not doc.get("catalogueChangedAt")
            or doc.get("verifiedAt", "") >= doc["catalogueChangedAt"]
        ):
            return "current"
    return "unverified"


def public_source(source):
    value = {k: v for k, v in source.items() if k not in {"managerSubject", "scheduleSubject"}}
    origin = source.get("originApp")
    if (
        source.get("adapter") == "reference"
        and origin in LEGACY_CATEGORIES
        and value.get("name") == LEGACY_CATEGORIES[origin]
    ):
        value["name"] = CATEGORIES[origin]
    value.update(enabled=False, autoIndex=source.get("knowledgeSourceAutoIndex", True))
    value["schedule"] = source.get("schedule") or {
        "frequency": "off",
        "downloadUpdates": False,
        "indexUpdates": False,
    }
    return value


def reference_download_outcomes(jobs):
    """Read all history once; the task-list limit must not hide old download failures."""
    latest = {}
    for job in sorted(
        (j for j in jobs if j.get("app") == APP and j.get("kind") == "import"),
        key=lambda j: (j.get("updatedAt", j.get("createdAt", "")), j.get("createdAt", ""), j["id"]),
    ):
        for item in job.get("items", []):
            if item.get("documentId"):
                latest[item["documentId"]] = item
    return latest


def reference_failure(item):
    message = item.get("error") or "PDF 下载失败，来源链接已保留。"
    code = item.get("errorCode") or (
        "no_pdf"
        if "未找到可公开下载" in message or "没有返回 PDF" in message
        else "source_forbidden"
        if "不允许下载" in message or "HTTP 403" in message or "HTTP 401" in message
        else "download_error"
    )
    if code == "no_pdf":
        message = str(no_pdf())
    elif code == "source_forbidden":
        message = "无法下载：来源网站不允许下载此公开资料。已保留来源链接，请打开原始链接查看。"
    return message, code


def reference_document_state(doc, source, outcomes):
    """Correct legacy display metadata without rewriting catalogue records or archives."""
    if not source or source.get("adapter") != "reference":
        return
    saved = bool(doc.get("versions"))
    if not saved and doc.get("format") in {None, "PDF"}:
        doc["format"] = "待核验"
    elif saved:
        doc["format"] = "PDF"
    if doc.get("documentType") == "参考论文" and source.get("templateId") != "pubmed":
        doc["documentType"] = "参考资料"
    if saved:
        doc["downloadStatus"] = "available"
        return
    latest = outcomes.get(doc["id"])
    if (
        not latest
        or latest.get("status") != "failed"
        or latest.get("failurePhase", "download") != "download"
    ):
        if latest and latest.get("status") == "pending":
            doc["downloadStatus"] = "not_requested"
            doc["error"] = None
            doc["downloadError"] = None
            doc["downloadErrorCode"] = None
            doc["downloadRetryable"] = False
        else:
            doc.setdefault("downloadStatus", "not_requested")
        return
    message, code = reference_failure(latest)
    doc.update(
        downloadStatus="unavailable" if code in {"no_pdf", "source_forbidden"} else "failed",
        downloadError=message,
        downloadErrorCode=code,
        downloadRetryable=latest.get("retryable", False),
        error=message,
    )


def public_jobs(store, subject=None):
    reference_sources = {
        s["id"] for s in store.records("source") if s.get("adapter") == "reference"
    }
    jobs = [
        copy.deepcopy({k: v for k, v in j.items() if k != "actorSubject"})
        for j in store.records("job")
        if j.get("app") == APP
    ]
    for job in jobs:
        if job.get("sourceId") in reference_sources and job.get("kind") == "import":
            for item in job.get("items", []):
                if (
                    item.get("status") == "failed"
                    and item.get("failurePhase", "download") == "download"
                ):
                    message, code = reference_failure(item)
                    if code in {"no_pdf", "source_forbidden"}:
                        item.update(error=message, errorCode=code, retryable=False)
        filing = job.get("ruleFiling")
        if filing:
            tokens = []
            for token in filing.get("undoTokens", []) if subject else []:
                entry = store.get("ks_undo", token, required=False)
                if (
                    entry
                    and entry.get("subject") == subject
                    and not entry.get("used")
                    and entry.get("expiresAt", 0) > time.time()
                ):
                    tokens.append(token)
            filing["undoTokens"] = tokens
            filing["canUndoRuleFiling"] = bool(tokens)
            for result in filing.get("results", []):
                result.pop("undoTokens", None)
                result.pop("undoToken", None)
            job["canUndoRuleFiling"] = bool(tokens)
        items = job["items"]
        job["summary"] = {
            "new": sum(i.get("result") == "new" for i in items),
            "reused": sum(i.get("result") == "reused" for i in items),
            "parseFailed": sum(
                i.get("failurePhase") == "parse" for i in items if i["status"] == "failed"
            ),
            "indexFailed": sum(
                i.get("failurePhase") == "index" for i in items if i["status"] == "failed"
            ),
            "downloadFailed": sum(
                i.get("failurePhase", "download") == "download"
                for i in items
                if i["status"] == "failed"
            ),
        }
    return jobs[-100:]


def job_revision(jobs):
    return hashlib.sha256(json.dumps(jobs, sort_keys=True).encode()).hexdigest()


def resources(store):
    versions = store.records("version")
    originals = {v["sha256"]: v["size"] for v in versions}
    meter = store.get("ks_usage", store.key("ks_usage", "downloads"), required=False) or {}
    calls = store.records("ks_research_call")
    confirmed = [
        call
        for call in calls
        if call.get("status") in {"response_received", "completed", "failed_validation"}
    ]

    def token_number(value):
        return (
            int(value)
            if not isinstance(value, bool)
            and isinstance(value, int | float)
            and 0 <= value < 10**12
            and int(value) == value
            else None
        )

    token_totals = []
    for call in confirmed:
        usage = call.get("usage") or {}
        if not isinstance(usage, dict):
            continue
        total = token_number(usage.get("total_tokens"))
        if total is None:
            prompt, completion = (
                token_number(usage.get("prompt_tokens")),
                token_number(usage.get("completion_tokens")),
            )
            if prompt is not None and completion is not None:
                total = prompt + completion
        if total is not None:
            token_totals.append(total)
    missing = len(calls) - len(token_totals)
    return {
        "originalBytes": sum(originals.values()),
        "originalFiles": len(originals),
        "versionCount": len(versions),
        "downloadBytes": meter.get("bytes", 0),
        "downloadMeteredSince": meter.get("startedAt"),
        "indexedVersions": sum(v.get("indexStatus") == "ready" for v in versions),
        "pendingVersions": sum(v.get("indexStatus") == "pending" for v in versions),
        "failedVersions": sum(v.get("indexStatus") == "failed" for v in versions),
        "researchRequests": len(calls),
        "confirmedModelResponses": len(confirmed),
        "unconfirmedModelRequests": len(calls) - len(confirmed),
        "modelUsageReceipts": len(token_totals),
        "modelTokens": sum(token_totals) if token_totals else None if calls else 0,
        "modelTokenReceiptsMissing": missing,
        "modelUsageIncomplete": missing > 0,
        # A missing response may still have been billed by the upstream provider.
        "generativeModelCalls": len(confirmed) if len(confirmed) == len(calls) else None,
        "modelCost": None,
        "indexCost": None,
    }


def meter_download(store, count):
    key = store.key("ks_usage", "downloads")
    meter = store.get("ks_usage", key, required=False) or {
        "id": key,
        "bytes": 0,
        "startedAt": iso(),
    }
    meter["bytes"] += count
    store.put("ks_usage", meter)
