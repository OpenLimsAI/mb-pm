"""Read projections for the knowledge-source workspace; no collection side effects."""

import hashlib
import json

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


def public_jobs(store):
    jobs = [
        {k: v for k, v in j.items() if k != "actorSubject"}
        for j in store.records("job")
        if j.get("app") == APP
    ]
    for job in jobs:
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
    return {
        "originalBytes": sum(originals.values()),
        "originalFiles": len(originals),
        "versionCount": len(versions),
        "downloadBytes": meter.get("bytes", 0),
        "downloadMeteredSince": meter.get("startedAt"),
        "indexedVersions": sum(v.get("indexStatus") == "ready" for v in versions),
        "pendingVersions": sum(v.get("indexStatus") == "pending" for v in versions),
        "failedVersions": sum(v.get("indexStatus") == "failed" for v in versions),
        "generativeModelCalls": 0,
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
