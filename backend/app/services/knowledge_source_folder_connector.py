"""Folder import local connector pairing, authentication, manifest, and file transfer."""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import time
from pathlib import PurePosixPath

from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError

from app.models.information import InformationEntry
from app.services.information import bridge
from app.services.information.store import Store, iso
from app.services.knowledge_source_folder_quota import (
    file_entry_id,
    get_active_task,
    items_for,
    meter_usage,
    require_authority,
    runs_for,
)
from app.services.knowledge_source_folder_roots import (
    ACTIVE,
    AGENT,
    BLOB,
    FILE,
    ITEM,
    PAIR,
    RUN,
    SHA,
    TASK,
    TERMINAL_ITEMS,
    relative_path,
    sanitize_error_path,
)
from app.services.knowledge_source_folder_tasks import refresh_run


def pair_code(store, ident, actor, connector=bridge.call):
    require_authority(store, actor["subject"], connector)
    task = get_active_task(store, ident)
    if task["kind"] != "local":
        raise HTTPException(422, "只有本机文件夹需要连接程序")
    code = secrets.token_urlsafe(18)
    value = {
        "id": hashlib.sha256(("folder-pair:" + code).encode()).hexdigest(),
        "taskId": ident,
        "actorSubject": actor["subject"],
        "expires": time.time() + 600,
    }
    store.put(PAIR, value)
    store.db.commit()
    return {
        "code": code,
        "expiresAt": iso(value["expires"]),
        "commandHint": "下载连接程序后，运行 pair 并输入此配对码及文件夹路径",
    }


def pair_connector(db, code, path, device_name, connector=bridge.call):
    ident = hashlib.sha256(("folder-pair:" + code).encode()).hexdigest()
    row = db.get(InformationEntry, ident)
    if row is None or row.kind != PAIR:
        raise HTTPException(403, "配对码无效或已过期")
    store = Store(db, row.tenant)
    pairing = store.lock(PAIR, ident)
    if pairing.get("used") or pairing["expires"] < time.time():
        raise HTTPException(403, "配对码无效或已过期")
    require_authority(store, pairing["actorSubject"], connector)
    task = get_active_task(store, pairing["taskId"], lock=True)
    if task["kind"] != "local" or not path.strip() or len(path) > 1500 or "\x00" in path:
        raise HTTPException(422, "请授权有效的本机文件夹")
    if (
        task.get("path")
        and task["path"] != path
        and any(
            r.get("manifestReceived") and r["status"] in ACTIVE for r in runs_for(store, task["id"])
        )
    ):
        raise HTTPException(409, "已有扫描绑定原目录，请先完成此扫描再连接其他目录")
    if task.get("agentId"):
        old = store.get(AGENT, task["agentId"])
        old["revokedAt"] = iso()
        store.put(AGENT, old)
    token = "fsc_" + secrets.token_urlsafe(48)
    agent_id = hashlib.sha256(token.encode()).hexdigest()
    store.put(
        AGENT,
        {
            "id": agent_id,
            "taskId": task["id"],
            "actorSubject": pairing["actorSubject"],
            "createdAt": iso(),
            "lastSeen": time.time(),
            "deviceName": device_name[:100],
        },
    )
    task.update(agentId=agent_id, path=path, actorSubject=pairing["actorSubject"], updatedAt=iso())
    store.put(TASK, task)
    pairing["used"] = True
    store.put(PAIR, pairing)
    for run in runs_for(store, task["id"]):
        if run["status"] in {"queued", "scanning", "transferring"}:
            run.update(agentId=agent_id, lease=secrets.token_urlsafe(32))
            store.put(RUN, run)
    db.commit()
    return {"token": token, "taskId": task["id"], "pollIntervalSeconds": 15}


def connector_actor(db, token, connector=bridge.call):
    if not isinstance(token, str) or not re.fullmatch(r"fsc_[A-Za-z0-9_-]{64}", token):
        raise HTTPException(401, "连接授权无效，请重新配对")
    ident = hashlib.sha256(token.encode()).hexdigest()
    row = db.get(InformationEntry, ident)
    if row is None or row.kind != AGENT:
        raise HTTPException(401, "连接授权无效，请重新配对")
    store = Store(db, row.tenant)
    agent = store.get(AGENT, ident)
    if agent.get("revokedAt"):
        raise HTTPException(401, "此连接授权已撤销，请重新配对")
    try:
        task = get_active_task(store, agent["taskId"])
    except HTTPException as exc:
        if exc.status_code == 404:
            raise HTTPException(401, "此连接授权对应的任务已删除，请停止连接程序") from exc
        raise
    if task.get("agentId") != ident:
        raise HTTPException(401, "此连接授权已撤销，请重新配对")
    require_authority(store, task["actorSubject"], connector)
    agent["lastSeen"] = time.time()
    store.put(AGENT, agent)
    db.commit()
    return store, agent, task


def connector_poll(store, agent, task):
    task = get_active_task(store, task["id"], lock=True)
    if task.get("agentId") != agent["id"]:
        raise HTTPException(401, "此连接授权已撤销，请重新配对")
    if task.get("paused"):
        return {"run": None, "paused": True}
    run = next(
        (
            r
            for r in runs_for(store, task["id"])
            if r["status"] in {"queued", "scanning", "transferring"}
        ),
        None,
    )
    if not run:
        return {"run": None}
    if run.get("agentId") != agent["id"]:
        raise HTTPException(409, "扫描连接已更换，请等待重新发起")
    run = store.lock(RUN, run["id"])
    if run["status"] not in {"queued", "scanning", "transferring"}:
        return {"run": None}
    run.update(
        status="scanning" if not run.get("manifestReceived") else "transferring", updatedAt=iso()
    )
    store.put(RUN, run)
    store.db.commit()
    return {
        "task": {
            k: task[k]
            for k in (
                "id",
                "path",
                "includeSubfolders",
                "preserveHierarchy",
                "maxFileMb",
                "maxFilesPerScan",
            )
        },
        "run": {"id": run["id"], "lease": run["lease"]},
    }


def connector_run(store, agent, task, ident, lease):
    task = get_active_task(store, task["id"], lock=True)
    if task.get("agentId") != agent["id"]:
        raise HTTPException(401, "此连接授权已撤销，请重新配对")
    if task.get("paused"):
        raise HTTPException(409, "自动导入已暂停")
    run = store.lock(RUN, ident)
    if (
        run["taskId"] != task["id"]
        or run.get("agentId") != agent["id"]
        or not hmac.compare_digest(run["lease"], lease or "")
    ):
        raise HTTPException(403, "此扫描不属于当前连接")
    if run["status"] not in {"queued", "scanning", "transferring"}:
        raise HTTPException(409, "此扫描已结束传输，不再接受文件")
    return run


def apply_manifest(store, task, run, files, errors=(), truncated=False):
    if len(files) + len(errors) > task["maxFilesPerScan"]:
        raise HTTPException(413, "本次文件清单超过任务上限，请分批扫描")
    seen = set()
    for value in files:
        path = relative_path(value["relativePath"])
        if path in seen:
            raise HTTPException(422, "文件清单含重复路径")
        seen.add(path)
        if not path.lower().endswith(".pdf") or any(
            part.startswith(".") for part in path.split("/")
        ):
            raise HTTPException(422, "首期仅扫描非隐藏 PDF 文件")
        if not task["includeSubfolders"] and "/" in path:
            raise HTTPException(422, "此任务未授权扫描子文件夹")
        if not SHA.fullmatch(value["sha256"]):
            raise HTTPException(422, "文件内容校验值无效")
        if value["size"] <= 0 or value["size"] > task["maxFileMb"] * 1024 * 1024:
            raise HTTPException(413, "文件超过任务大小上限或内容为空")
    normalized_errors = []
    for idx, error in enumerate(errors):
        raw_path = error.get("relativePath", "")
        try:
            path = relative_path(raw_path)
        except HTTPException:
            path = sanitize_error_path(raw_path, idx)
        if path in seen:
            continue
        seen.add(path)
        normalized_errors.append({"relativePath": path, "error": error.get("error", "")})
    need = []
    for value in files:
        path, sha = value["relativePath"], value["sha256"]
        item_id = store.key(ITEM, run["id"] + ":" + path)
        current = store.get(ITEM, item_id, required=False)
        if current:
            if current["sha256"] != sha or current["size"] != value["size"]:
                if not current.get("originalSaved") and current["status"] == "pending":
                    current.update(
                        sha256=sha,
                        size=value["size"],
                        mtime=value["mtime"],
                        allowChangedFingerprint=False,
                    )
                    store.put(ITEM, current)
                else:
                    raise HTTPException(409, "同批文件内容变化，请结束本次扫描后重新扫描")
            if not current.get("originalSaved") and current["status"] not in TERMINAL_ITEMS:
                need.append(path)
            continue
        previous = store.get(FILE, file_entry_id(store, task["id"], path), required=False)
        blob = store.get(BLOB, store.key(BLOB, sha), required=False)
        same = previous and previous.get("sha256") == sha and previous.get("status") == "completed"
        suppressed = bool(previous and previous.get("sha256") == sha and previous.get("suppressed"))
        change = "unchanged" if same else "updated" if previous else "new"
        item = {
            "id": item_id,
            "runId": run["id"],
            "taskId": task["id"],
            "relativePath": path,
            "size": value["size"],
            "mtime": value["mtime"],
            "sha256": sha,
            "status": "ignored" if suppressed else "unchanged" if same else "pending",
            "phase": "done" if same or suppressed else "saved" if blob else "waiting_file",
            "change": change,
            "originalSaved": bool(blob or same),
            "indexStatus": "ready" if same else "not_requested",
            "error": "已删除的同版资料不会自动恢复" if suppressed else None,
            "createdAt": iso(),
            "attempts": 0,
            "reused": bool(blob),
        }
        if blob:
            item.update(versionId=blob["versionId"], documentId=blob["documentId"])
        if same:
            item.update(
                paperId=previous.get("paperId"),
                versionId=previous.get("versionId"),
                documentId=previous.get("documentId"),
            )
        store.put(ITEM, item)
        if not item["originalSaved"] and not suppressed:
            need.append(path)
    for error in normalized_errors:
        path = error["relativePath"]
        ident = store.key(ITEM, run["id"] + ":" + path)
        if store.get(ITEM, ident, required=False) is None:
            store.put(
                ITEM,
                {
                    "id": ident,
                    "runId": run["id"],
                    "taskId": task["id"],
                    "relativePath": path,
                    "size": 0,
                    "sha256": "",
                    "mtime": 0,
                    "status": "failed",
                    "phase": "waiting_file",
                    "change": "new",
                    "originalSaved": False,
                    "indexStatus": "not_requested",
                    "error": str(error["error"])[:500],
                    "createdAt": iso(),
                    "attempts": 3,
                },
            )
    if not truncated:
        for old in store.records(FILE):
            if old["taskId"] == task["id"] and old["relativePath"] not in seen:
                old.update(sourceMissing=True, missingAt=iso())
                store.put(FILE, old)
    run.update(
        manifestReceived=True,
        status="transferring",
        phase="transfer",
        truncated=truncated,
        updatedAt=iso(),
    )
    if truncated:
        run["warning"] = "本次达到文件数量上限；其余文件将在后续批次继续扫描"
    store.put(RUN, run)
    refresh_run(store, run["id"])
    store.db.commit()
    return {"needFiles": need, "runId": run["id"]}


def save_original(store, task, run, path, sha, content):
    path = relative_path(path)
    item = store.get(ITEM, store.key(ITEM, run["id"] + ":" + path))
    if (
        item["sha256"] != sha
        or len(content) != item["size"]
        or hashlib.sha256(content).hexdigest() != sha
    ):
        raise HTTPException(409, "文件传输期间发生变化，请重新扫描")
    if len(content) > task["maxFileMb"] * 1024 * 1024 or not content.lstrip()[:16].startswith(
        b"%PDF-"
    ):
        raise HTTPException(422, "文件不是有效 PDF 或超过大小上限")
    if item.get("originalSaved"):
        return {"saved": True, "relativePath": path, "originalSaved": True}
    store.lock_original(sha)
    existing_blob = store.get(BLOB, store.key(BLOB, sha), required=False)
    source_id = store.key("source", "folder-imports")
    if not store.get("source", source_id, required=False):
        try:
            with store.db.begin_nested():
                store.put(
                    "source",
                    {
                        "id": source_id,
                        "adapter": "folder",
                        "name": "文件夹自动导入",
                        "url": "",
                        "scopes": [],
                        "enabled": False,
                        "createdAt": iso(),
                    },
                )
        except IntegrityError:
            pass
    document_id = store.key("document", "folder:" + sha)
    if not store.get("document", document_id, required=False):
        try:
            with store.db.begin_nested():
                store.put(
                    "document",
                    {
                        "id": document_id,
                        "sourceId": source_id,
                        "title": PurePosixPath(path).stem[:500],
                        "url": "",
                        "scopes": [],
                        "folderIds": [run["folderId"]],
                        "documentType": "文件夹导入",
                        "originalFilename": PurePosixPath(path).name,
                        "format": "PDF",
                        "language": "未提供",
                        "status": "archived",
                        "discoveredAt": iso(),
                    },
                )
        except IntegrityError:
            pass
    version = store.archive(document_id, content)
    item.update(
        originalSaved=True,
        versionId=version["id"],
        documentId=document_id,
        phase="saved",
        status="pending",
        error=None,
        reused=bool(existing_blob),
    )
    store.put(ITEM, item)
    if not existing_blob:
        meter_usage(store, task, "original:" + sha, originalBytes=len(content))
    store.put(
        BLOB,
        {
            "id": store.key(BLOB, sha),
            "sha256": sha,
            "documentId": document_id,
            "versionId": version["id"],
            "size": len(content),
            "createdAt": iso(),
        },
    )
    store.db.commit()
    return {"saved": True, "relativePath": path, "originalSaved": True}


def finish_transfer(store, task, run, errors=(), truncated=False):
    if not run.get("manifestReceived"):
        raise HTTPException(409, "请先提交扫描文件清单")
    error_map = {relative_path(v["relativePath"]): str(v["error"])[:500] for v in errors}
    for item in items_for(store, run["id"]):
        if item["relativePath"] in error_map or (
            item["status"] == "pending" and not item.get("originalSaved")
        ):
            item.update(
                status="failed",
                error=error_map.get(item["relativePath"], "原文件未完整传输，请重新扫描或重试"),
                attempts=3,
            )
            store.put(ITEM, item)
    run.update(
        manifestComplete=True,
        status="processing",
        phase="process",
        truncated=bool(run.get("truncated") or truncated),
        updatedAt=iso(),
    )
    store.put(RUN, run)
    task["hasScanned"] = True
    store.put(TASK, task)
    refresh_run(store, run["id"])
    store.db.commit()
    return {"accepted": True, "runId": run["id"]}
