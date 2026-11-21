"""Delete a pending manual upload without registering or indexing it."""

import re
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from fastapi import HTTPException

from app.models.information import InformationEntry, InformationText


def archive_id(paper_id):
    return bool(re.fullmatch(r"archive:[a-f0-9]{64}", paper_id))


def plan_key(store, plan_id):
    return store.key("original_delete", plan_id)


def pending_manual(store, paper_id):
    version = store.get("version", paper_id.removeprefix("archive:"))
    document = store.get("document", version["documentId"])
    if (
        document["sourceId"] != store.key("source", "manual-upload")
        or document.get("documentType") != "手动上传"
        or version.get("indexStatus") not in ("not_requested", "failed")
        or not version.get("kbDocumentId")
        or not version.get("kbPath")
    ):
        raise HTTPException(409, "仅可直接删除待登记的手动上传件，资料状态已变化时请刷新")
    return version, document


def bridge_values(version):
    return {"documentId": version["kbDocumentId"], "sha256": version["sha256"]}


def preview(store, subject, paper_id, connect):
    version, document = pending_manual(store, paper_id)
    result = connect("previewPendingOriginalDelete", subject, **bridge_values(version))
    if result.get("path") != version["kbPath"] or not isinstance(result.get("discarded"), bool):
        raise HTTPException(503, "知识库尚未确认可以删除这份原件")
    plan_id = str(uuid4())
    plan = {
        "planId": plan_id,
        "path": paper_id,
        "title": document["title"],
        "expiresAt": (datetime.now(UTC) + timedelta(minutes=5)).isoformat(),
        "pages": [],
        "sharedCount": 0,
        "unverifiedCount": 0,
        "scope": "original",
    }
    store.put(
        "original_delete",
        {
            "id": plan_key(store, plan_id),
            "actor": subject,
            "plan": plan,
            "revision": version["createdAt"],
        },
    )
    store.db.commit()
    return plan


def confirm(store, subject, paper_id, plan_id, connect):
    record = store.lock("original_delete", plan_key(store, plan_id))
    plan = record["plan"]
    if record["actor"] != subject or plan["path"] != paper_id:
        raise HTTPException(404, "删除确认不存在")
    if record.get("result"):
        return record["result"]
    if datetime.fromisoformat(plan["expiresAt"]) <= datetime.now(UTC):
        raise HTTPException(
            409, {"code": "paper_delete_plan_expired", "message": "请重新检查删除范围"}
        )
    version, document = pending_manual(store, paper_id)
    store.lock_original(version["sha256"])
    store.lock("source", document["sourceId"])
    version, document = pending_manual(store, paper_id)
    if version["createdAt"] != record["revision"]:
        raise HTTPException(409, "文件已变化，请重新检查")
    if any(
        any(item.get("versionId") == version["id"] for item in job["items"])
        for job in store.active_jobs()
    ):
        raise HTTPException(409, "原件正在处理，请等待任务结束后再删除")
    result = connect("deletePendingOriginal", subject, **bridge_values(version))
    if result.get("discarded") is not True or result.get("path") != version["kbPath"]:
        raise HTTPException(503, "知识库尚未确认删除这份原件，请重试")
    versions = store.records("version")
    if not any(v["id"] != version["id"] and v["sha256"] == version["sha256"] for v in versions):
        store.archive_path(version).unlink(missing_ok=True)
    text = store.db.get(InformationText, version["id"])
    if text and text.tenant == store.tenant:
        store.db.delete(text)
    store.db.delete(store.db.get(InformationEntry, version["id"]))
    if not any(v["id"] != version["id"] and v["documentId"] == document["id"] for v in versions):
        store.db.delete(store.db.get(InformationEntry, document["id"]))
        classification = store.db.get(
            InformationEntry, store.key("ks_classification", document["id"])
        )
        if classification and classification.tenant == store.tenant:
            store.db.delete(classification)
    response = {
        "operationId": plan_id,
        "path": paper_id,
        "status": "succeeded",
        "completed": 1,
        "total": 1,
    }
    store.put("original_delete", {**record, "result": response})
    store.audit(subject, "delete_pending_original", version["id"])
    store.db.commit()
    return response


def status(store, subject, operation_id):
    record = store.get("original_delete", plan_key(store, operation_id), required=False)
    if record is None:
        return None
    if record["actor"] != subject or not record.get("result"):
        raise HTTPException(404, "尚未确认原件删除结果")
    return record["result"]
