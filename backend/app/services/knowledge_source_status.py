"""Read projections for the knowledge-source workspace; no collection side effects."""

import hashlib
import json
import time

from app.services.information.store import iso

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
    value.update(enabled=False, autoIndex=source.get("knowledgeSourceAutoIndex", True))
    value["schedule"] = source.get("schedule") or {
        "frequency": "off",
        "downloadUpdates": False,
        "indexUpdates": False,
    }
    return value


def public_jobs(store, subject=None):
    jobs = [
        {k: v for k, v in j.items() if k != "actorSubject"}
        for j in store.records("job")
        if j.get("app") == APP
    ]
    for job in jobs:
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
