"""Manual PDF upload storage, extraction, and post-upload rule filing service."""

from __future__ import annotations

import base64
import hashlib
import tempfile
from pathlib import Path

from fastapi import HTTPException

from app.services.information.extract import extract_pdf
from app.services.information.store import Store, iso
from app.services.knowledge_source_context import connected, workspace_catalogue_context
from app.services.knowledge_source_inbox import inbox_id, normalized_folder_ids


def upload_paper_service(
    db,
    actor: dict,
    *,
    original: bytes,
    filename: str,
    folder_id: str,
    no_folder: bool,
    catalogue: dict,
    extract_pdf_fn=extract_pdf,
) -> dict:
    if len(original) > 25 * 1024 * 1024:
        raise HTTPException(413, "单份 PDF 请控制在 25 MB 以内")
    if not original.lstrip()[:16].startswith(b"%PDF-"):
        raise HTTPException(400, "请选择有效的 PDF 文件")
    if len(folder_id) > 100:
        raise HTTPException(422, "请选择目标文件夹")
    text, issue = "", None
    with tempfile.TemporaryDirectory(prefix="knowledge-source-upload-") as directory:
        path = Path(directory) / "original.pdf"
        path.write_bytes(original)
        try:
            text = extract_pdf_fn(path)
            if len(text) > 2_000_000:
                text, issue = "", "正文超过解析大小上限，原件保留，可拆分后另行索引"
        except (ValueError, OSError) as exc:
            issue = str(exc)[:200]
    store = Store(db, actor["tenant"])
    sha = hashlib.sha256(original).hexdigest()
    store.lock_original(sha)
    result = connected(
        "uploadPaper",
        actor["subject"],
        name=filename[:200],
        originalBase64=base64.b64encode(original).decode(),
        sha256=sha,
        text=text,
        **({"folderId": folder_id} if folder_id else {}),
        **({"noFolder": True} if no_folder else {}),
        parse=False,
    )
    source_id, document_id = (
        store.key("source", "manual-upload"),
        store.key("document", "manual:" + sha),
    )
    manual_source = store.get("source", source_id, required=False) or {
        "id": source_id,
        "name": "手动收录",
        "url": "",
        "adapter": "manual",
        "scopes": [],
        "enabled": False,
        "autoIndex": False,
        "createdAt": iso(),
    }
    manual_source["folderId"] = None
    store.put("source", manual_source)
    document = store.get("document", document_id, required=False)
    if not document:
        document = {
            "id": document_id,
            "sourceId": source_id,
            "title": Path(filename).stem[:500],
            "url": "",
            "scopes": [],
            "folderIds": [],
            "documentType": "手动上传",
            "format": "PDF",
            "language": "未提供",
            "status": "archived",
            "discoveredAt": iso(),
        }
    destination = result.get("folderId")
    if "folderIds" in result:
        document["folderIds"] = result["folderIds"]
    else:
        document["folderIds"] = normalized_folder_ids(
            set(document.get("folderIds", [])) | ({destination} if destination else set()),
            catalogue,
        )
        if (
            destination
            and destination not in document["folderIds"]
            and not any(folder["id"] == destination for folder in catalogue.get("folders", []))
        ):
            document["folderIds"].append(destination)
    store.put("document", document)
    classification_key = store.key("ks_classification", document_id)
    classification = store.get("ks_classification", classification_key, required=False)
    if classification is not None:
        previous = set(classification.get("folderIds", []))
        current = set(document["folderIds"])
        classification["folderIds"] = document["folderIds"]
        classification["removedFolderIds"] = sorted(
            (set(classification.get("removedFolderIds", [])) | (previous - current)) - current
        )
        store.put("ks_classification", classification)
    version = store.archive(
        document_id, original, text, parse_status="ready" if text else "failed", error=issue
    )
    version.update(
        kbPath=result["path"],
        kbUrl=result.get("url"),
        kbDocumentId=result["documentId"],
        kbPending=not result.get("registered", False),
        indexStatus=result.get("indexStatus", "not_requested"),
    )
    store.put("version", version)
    store.audit(actor["subject"], "knowledge_source_manual_upload", document_id)
    db.commit()
    filing = None
    from app.services.knowledge_source_workspace_v3 import apply_enabled_rules, workspace

    if (
        not no_folder
        and folder_id
        and folder_id != inbox_id(catalogue)
        and any(rule.get("enabled") for rule in workspace(store, actor["subject"])["rules"])
    ):
        try:
            full_catalogue, papers = workspace_catalogue_context(store, actor)
            if full_catalogue.get("canWrite"):
                filing = apply_enabled_rules(
                    store,
                    actor,
                    catalogue=full_catalogue,
                    papers=papers,
                    connect=connected,
                    paper_ids=["archive:" + version["id"]],
                )
        except Exception:
            db.rollback()
            filing = [
                {
                    "saved": False,
                    "error": "原件已保存，自动归档暂未完成，可在规则面板预览后手动执行",
                }
            ]
    return {
        **result,
        "paperId": result["path"] if result.get("registered") else "archive:" + version["id"],
        "originalSaved": True,
        "textExtracted": bool(text),
        "extractionIssue": issue,
        "indexRequested": False,
        "ruleFiling": filing,
    }
