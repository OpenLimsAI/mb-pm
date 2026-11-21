"""Folder import task lifecycle, run queueing, summary refresh, and retry operations."""

from __future__ import annotations

import secrets
from uuid import uuid4

from fastapi import HTTPException

from app.services.information import bridge
from app.services.information.store import iso
from app.services.knowledge_source_folder_quota import (
    destination_folder,
    get_active_task,
    items_for,
    next_scan,
    normalize_config,
    public_run,
    public_task,
    require_authority,
    runs_for,
)
from app.services.knowledge_source_folder_roots import (
    ACTIVE,
    AGENT,
    ITEM,
    RUN,
    TASK,
    TERMINAL_ITEMS,
)


def create_task(store, actor, config, connector=bridge.call):
    config = normalize_config(config)
    summary = require_authority(store, actor["subject"], connector)
    folder, folder_name = destination_folder(config, summary, actor["subject"], connector)
    task = {
        **config,
        "id": store.key(TASK, str(uuid4())),
        "folderId": folder,
        "folderName": folder_name,
        "actorSubject": actor["subject"],
        "createdAt": iso(),
        "updatedAt": iso(),
        "paused": False,
        "nextScanAt": next_scan(config["schedule"]),
        "lastError": None,
        "hasScanned": False,
    }
    store.put(TASK, task)
    store.audit(actor["subject"], "folder_import_task_created", task["id"])
    store.db.commit()
    queue_scan(store, task["id"], actor["subject"], connector=connector)
    return public_task(store, get_active_task(store, task["id"]))


def update_task(store, ident, actor, config, connector=bridge.call):
    config = normalize_config(config)
    summary = require_authority(store, actor["subject"], connector)
    folder, folder_name = destination_folder(config, summary, actor["subject"], connector)
    task = get_active_task(store, ident, lock=True)
    active = any(r["status"] in ACTIVE for r in runs_for(store, ident))
    changes_source = any(task.get(k) != config.get(k) for k in ("kind", "serverRootId", "path"))
    if active and changes_source:
        raise HTTPException(409, "扫描运行中不能更换源目录，请完成或暂停后重新连接")
    if task["kind"] != config["kind"] and task.get("agentId"):
        agent = store.get(AGENT, task["agentId"])
        agent["revokedAt"] = iso()
        store.put(AGENT, agent)
        task.pop("agentId", None)
    task.update(
        config,
        folderId=folder,
        folderName=folder_name,
        actorSubject=actor["subject"],
        updatedAt=iso(),
        lastError=None,
    )
    task["nextScanAt"] = None if task.get("paused") else next_scan(task["schedule"])
    store.put(TASK, task)
    store.audit(actor["subject"], "folder_import_task_updated", ident)
    store.db.commit()
    return public_task(store, task)


def queue_scan(store, ident, subject, *, connector=bridge.call, scheduled=False):
    task = get_active_task(store, ident, lock=True)
    require_authority(store, subject, connector)
    destination_folder(task, connector("librarySummary", subject), subject, connector)
    active = next((r for r in runs_for(store, ident) if r["status"] in ACTIVE), None)
    if active:
        if scheduled:
            task["nextScanAt"] = next_scan(task["schedule"])
            store.put(TASK, task)
        store.db.commit()
        return public_run(active), True
    if task.get("paused"):
        raise HTTPException(409, "任务已暂停，请先恢复")
    run = {
        "id": store.key(RUN, str(uuid4())),
        "taskId": ident,
        "actorSubject": subject,
        "createdAt": iso(),
        "updatedAt": iso(),
        "finishedAt": None,
        "status": "queued",
        "phase": "waiting_connector" if task["kind"] == "local" else "scan",
        "initial": not task.get("hasScanned", False),
        "scheduled": scheduled,
        "folderId": task["folderId"],
        "preserveHierarchy": task["preserveHierarchy"],
        "manifestComplete": False,
        "manifestReceived": False,
        "total": 0,
        "processed": 0,
        "completed": 0,
        "failed": 0,
        "new": 0,
        "updated": 0,
        "unchanged": 0,
        "error": None,
        "lease": secrets.token_urlsafe(32),
        "agentId": task.get("agentId"),
        "counts": {"new": 0, "updated": 0, "unchanged": 0, "failed": 0, "completed": 0},
    }
    store.put(RUN, run)
    task.update(nextScanAt=next_scan(task["schedule"]), lastError=None, updatedAt=iso())
    store.put(TASK, task)
    store.audit(subject, "folder_import_scan_queued", run["id"])
    store.db.commit()
    return public_run(run), False


def control_task(store, ident, actor, action, connector=bridge.call):
    require_authority(store, actor["subject"], connector)
    task = get_active_task(store, ident, lock=True)
    if action == "delete":
        task.update(deletedAt=iso(), paused=True, nextScanAt=None)
        if task.get("agentId"):
            agent = store.get(AGENT, task["agentId"])
            agent["revokedAt"] = iso()
            store.put(AGENT, agent)
        for run in runs_for(store, ident):
            if run["status"] in ACTIVE:
                run.update(
                    status="cancelled", finishedAt=iso(), error="自动导入已停止，已保存资料保留"
                )
                store.put(RUN, run)
    elif action == "pause":
        task.update(paused=True, nextScanAt=None)
    elif action == "resume":
        destination_folder(
            task, connector("librarySummary", actor["subject"]), actor["subject"], connector
        )
        task.update(
            paused=False,
            actorSubject=actor["subject"],
            lastError=None,
            nextScanAt=next_scan(task["schedule"]),
        )
        for current_run in runs_for(store, ident):
            if current_run["status"] in ACTIVE:
                current_run["actorSubject"] = actor["subject"]
                store.put(RUN, current_run)
    elif action == "retry":
        latest = runs_for(store, ident)
        if latest:
            retry_run(store, latest[0]["id"], actor, connector)
            task = get_active_task(store, ident)
    else:
        raise HTTPException(422, "操作无效")
    task["updatedAt"] = iso()
    store.put(TASK, task)
    store.audit(actor["subject"], "folder_import_task_" + action, ident)
    store.db.commit()
    return public_task(store, task)


def refresh_run(store, ident):
    run = store.get(RUN, ident)
    items = items_for(store, ident)
    run.update(
        total=len(items),
        processed=sum(i["status"] in TERMINAL_ITEMS for i in items),
        completed=sum(i["status"] == "completed" for i in items),
        failed=sum(i["status"] == "failed" for i in items),
        **{
            kind: sum(i["change"] == kind for i in items)
            for kind in ("new", "updated", "unchanged")
        },
    )
    run["counts"] = {
        key: run[key] for key in ("new", "updated", "unchanged", "failed", "completed")
    }
    run["updatedAt"] = iso()
    if (
        run["status"] in ACTIVE
        and run.get("manifestComplete")
        and all(i["status"] in TERMINAL_ITEMS for i in items)
    ):
        run.update(
            status="partial"
            if run["failed"] and run["failed"] < len(items)
            else "failed"
            if run["failed"]
            else "completed",
            phase="done",
            finishedAt=iso(),
        )
        run["error"] = f'{run["failed"]} 份未完成，已保存资料保留' if run["failed"] else None
        task = get_active_task(store, run["taskId"])
        task.update(lastError=run["error"], updatedAt=iso())
        store.put(TASK, task)
        if run["new"] or run["updated"] or run["failed"]:
            store.put(
                "event",
                {
                    "id": store.key("event", "folder-run:" + ident),
                    "sourceId": store.key("source", "folder-imports"),
                    "kind": "首次导入" if run["initial"] else "自动导入汇总",
                    "title": task["name"],
                    "summary": (
                        f'新增 {run["new"]}，更新 {run["updated"]}，'
                        f'完成 {run["completed"]}，失败 {run["failed"]}'
                    ),
                    "createdAt": iso(),
                    "read": False,
                },
            )
    store.put(RUN, run)
    return run


def retry_run(store, ident, actor, connector=bridge.call, *, item_ids=None):
    run = store.get(RUN, ident)
    task = get_active_task(store, run["taskId"], lock=True)
    require_authority(store, actor["subject"], connector)
    if any(r["id"] != ident and r["status"] in ACTIVE for r in runs_for(store, task["id"])):
        raise HTTPException(409, "此任务已有运行中的扫描")
    needs_transfer = False
    all_items = items_for(store, ident)
    if item_ids is not None and not set(item_ids) <= {i["id"] for i in all_items}:
        raise HTTPException(422, "重试文件不属于此扫描")
    if not any(
        i["status"] == "failed" and (item_ids is None or i["id"] in item_ids) for i in all_items
    ):
        raise HTTPException(409, "没有可重试的失败文件；运行中的任务可继续或恢复")
    for item in all_items:
        if item["status"] == "failed" and (item_ids is None or item["id"] in item_ids):
            needs_transfer = needs_transfer or not item.get("originalSaved")
            item.update(
                status="pending",
                attempts=0,
                nextAttemptAt=0,
                error=None,
                allowChangedFingerprint=not item.get("originalSaved"),
            )
            store.put(ITEM, item)
    run.update(
        status="queued" if needs_transfer and task["kind"] == "local" else "processing",
        manifestComplete=not needs_transfer or task["kind"] == "server",
        error=None,
        finishedAt=None,
        actorSubject=actor["subject"],
        updatedAt=iso(),
    )
    task.update(paused=False, lastError=None, actorSubject=actor["subject"])
    store.put(RUN, run)
    store.put(TASK, task)
    store.db.commit()
    return public_run(run)
