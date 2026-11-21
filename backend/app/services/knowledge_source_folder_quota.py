"""Folder import configuration validation, scheduling, daily quota ledger, and public views."""

from __future__ import annotations

import copy
import os
import re
import time
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.core.config import settings
from app.models.information import InformationEntry
from app.services.information import bridge
from app.services.information.store import iso
from app.services.knowledge_source_folder_roots import (
    ACTIVE,
    AGENT,
    FILE,
    ITEM,
    METER,
    ONLINE_SECONDS,
    QUOTA_MESSAGE,
    RUN,
    TASK,
    USAGE,
    server_directory,
    source_path,
)


def normalize_config(value):
    value = copy.deepcopy(value)
    value.setdefault("name", "文件夹自动导入")
    value["name"] = value["name"].strip()
    if not value["name"]:
        raise HTTPException(422, "请填写任务名称")
    value.setdefault("path", "")
    value.setdefault("includeSubfolders", True)
    value.setdefault("preserveHierarchy", False)
    value.setdefault("maxFileMb", settings.KNOWLEDGE_FOLDER_IMPORT_MAX_FILE_MB)
    value.setdefault("maxFilesPerScan", 1000)
    value.setdefault("dailyFileLimit", 1000)
    if (
        not isinstance(value["dailyFileLimit"], int)
        or isinstance(value["dailyFileLimit"], bool)
        or not 1 <= value["dailyFileLimit"] <= 50000
    ):
        raise HTTPException(422, "每日处理上限应为 1–50000 份")
    value.setdefault("authorizeKnowledgeBaseIncremental", False)
    if value["maxFileMb"] > settings.KNOWLEDGE_FOLDER_IMPORT_MAX_FILE_MB:
        raise HTTPException(422, "单文件上限超过当前服务配置")
    schedule = value.setdefault("schedule", {})
    schedule.setdefault("frequency", "daily")
    schedule.setdefault("time", "08:00")
    schedule.setdefault("timezone", "Asia/Shanghai")
    schedule.setdefault("weekday", 0)
    if not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", schedule["time"]):
        raise HTTPException(422, "扫描时间应为 HH:mm")
    try:
        ZoneInfo(schedule["timezone"])
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise HTTPException(422, "扫描时区无效") from exc
    if value["kind"] == "server":
        with server_directory(value) as fd:
            value["sourceDevice"] = os.fstat(fd).st_dev
    elif value["path"] and (len(value["path"]) > 1500 or "\x00" in value["path"]):
        raise HTTPException(422, "本机文件夹路径无效")
    return value


def next_scan(schedule, now=None):
    if schedule["frequency"] == "manual":
        return None
    zone = ZoneInfo(schedule["timezone"])
    local = datetime.fromtimestamp(time.time() if now is None else now, UTC).astimezone(zone)
    hour, minute = map(int, schedule["time"].split(":"))
    for day in range(9):
        date = local.date() + timedelta(days=day)
        if schedule["frequency"] == "weekly" and date.weekday() != schedule["weekday"]:
            continue
        candidate = datetime(date.year, date.month, date.day, hour, minute, tzinfo=zone)
        candidate = candidate.astimezone(UTC).astimezone(zone)
        if candidate > local:
            return candidate.astimezone(UTC).isoformat()
    raise HTTPException(422, "无法计算下一次扫描时间")


def require_authority(store, subject, connector=bridge.call, *, actor_verified=False):
    if not actor_verified:
        from app.services import folder_imports

        folder_imports.authority(store.db, subject)
    summary = connector("librarySummary", subject)
    if not summary.get("canWrite"):
        raise HTTPException(403, "文件夹自动导入需要当前知识库整理权限")
    return summary


def destination_folder(config, summary, subject, connector):
    ident = config.get("folderId")
    if ident:
        folder = next((f for f in summary.get("folders", []) if f["id"] == ident), None)
        if folder is None:
            raise HTTPException(409, "目标文件夹已不存在，请重新选择；不会改存其他位置")
    else:
        folder = connector("ensureInboxFolder", subject)
        ident = folder["id"]
    return ident, folder["name"]


def get_active_task(store, ident, *, lock=False):
    value = store.lock(TASK, ident) if lock else store.get(TASK, ident)
    if value.get("deletedAt"):
        raise HTTPException(404, "自动导入任务已删除")
    return value


def runs_for(store, task_id):
    rows = store.db.scalars(
        select(InformationEntry).where(
            InformationEntry.tenant == store.tenant,
            InformationEntry.kind == RUN,
            InformationEntry.data["taskId"].as_string() == task_id,
        )
    ).all()
    return sorted((copy.deepcopy(r.data) for r in rows), key=lambda r: r["createdAt"], reverse=True)


def items_for(store, run_id):
    rows = store.db.scalars(
        select(InformationEntry).where(
            InformationEntry.tenant == store.tenant,
            InformationEntry.kind == ITEM,
            InformationEntry.data["runId"].as_string() == run_id,
        )
    ).all()
    return sorted((copy.deepcopy(r.data) for r in rows), key=lambda i: i["relativePath"])


def file_entry_id(store, task_id, path):
    return store.key(FILE, task_id + ":" + path)


def usage_snapshot(store, task, *, now=None):
    zone = task["schedule"]["timezone"]
    stamp = time.time() if now is None else now
    local = datetime.fromtimestamp(stamp, UTC).astimezone(ZoneInfo(zone))
    date = local.date().isoformat()
    ident = store.key(USAGE, task["id"] + ":" + zone + ":" + date)
    value = store.get(USAGE, ident, required=False) or {
        "id": ident,
        "taskId": task["id"],
        "date": date,
        "timezone": zone,
        "completedFiles": 0,
        "originalBytes": 0,
        "parsedPages": 0,
        "parsedCharacters": 0,
        "indexedFiles": 0,
        "reusedFiles": 0,
        "unknownParsedPages": 0,
    }
    tomorrow = local.date() + timedelta(days=1)
    reset = datetime(tomorrow.year, tomorrow.month, tomorrow.day, tzinfo=ZoneInfo(zone))
    return {
        **value,
        "limit": task.get("dailyFileLimit", 1000),
        "remainingFiles": max(0, task.get("dailyFileLimit", 1000) - value["completedFiles"]),
        "resetsAt": reset.astimezone(UTC).isoformat(),
        "indexMeasurement": "confirmed-files",
    }


def meter_usage(store, task, event, **increments):
    """One durable ledger event per actual stage result, in its commit transaction."""
    task = store.lock(TASK, task["id"])
    event_id = store.key(METER, task["id"] + ":" + event)
    if store.get(METER, event_id, required=False):
        return
    usage = usage_snapshot(store, task)
    current = store.get(USAGE, usage["id"], required=False)
    if current is None:
        try:
            with store.db.begin_nested():
                store.put(
                    USAGE,
                    {
                        k: v
                        for k, v in usage.items()
                        if k not in {"limit", "remainingFiles", "resetsAt", "indexMeasurement"}
                    },
                )
        except IntegrityError:
            pass
    current = store.lock(USAGE, usage["id"])
    for key, amount in increments.items():
        if (
            key
            not in {
                "completedFiles",
                "originalBytes",
                "parsedPages",
                "parsedCharacters",
                "indexedFiles",
                "reusedFiles",
                "unknownParsedPages",
            }
            or not isinstance(amount, int)
            or amount < 0
        ):
            raise ValueError("自动导入用量记录无效")
        current[key] = current.get(key, 0) + amount
    current["updatedAt"] = iso()
    store.put(USAGE, current)
    store.put(
        METER,
        {
            "id": event_id,
            "taskId": task["id"],
            "usageId": usage["id"],
            "stage": event.split(":", 1)[0],
            "increments": increments,
            "createdAt": iso(),
        },
    )


def wait_for_quota(store, task, run):
    usage = usage_snapshot(store, task)
    if usage["remainingFiles"]:
        if run["status"] == "waiting_quota":
            current_task = store.lock(TASK, task["id"])
            current_run = store.lock(RUN, run["id"])
            if (
                current_task.get("paused")
                or current_task.get("deletedAt")
                or current_run["status"] not in ACTIVE
            ):
                store.db.rollback()
                return True
            current_run.update(status="processing", phase="process", nextRetryAt=None, error=None)
            if current_task.get("lastError") == QUOTA_MESSAGE:
                current_task["lastError"] = None
            current_task["nextRetryAt"] = None
            store.put(TASK, current_task)
            store.put(RUN, current_run)
            store.db.commit()
        return False
    current_task = store.lock(TASK, task["id"])
    current_run = store.lock(RUN, run["id"])
    if (
        current_task.get("paused")
        or current_task.get("deletedAt")
        or current_run["status"] not in ACTIVE
    ):
        store.db.rollback()
        return True
    current_task.update(lastError=QUOTA_MESSAGE, nextRetryAt=usage["resetsAt"])
    current_run.update(
        status="waiting_quota",
        phase="waiting_quota",
        error=QUOTA_MESSAGE,
        nextRetryAt=usage["resetsAt"],
        updatedAt=iso(),
    )
    store.put(TASK, current_task)
    store.put(RUN, current_run)
    store.db.commit()
    return True


def public_task(store, task):
    value = copy.deepcopy(task)
    for key in ("actorSubject", "agentId", "scanCursor", "sourceDevice"):
        value.pop(key, None)
    current = runs_for(store, task["id"])
    agent = store.get(AGENT, task.get("agentId", ""), required=False)
    online = bool(
        agent
        and not agent.get("revokedAt")
        and agent.get("lastSeen", 0) >= time.time() - ONLINE_SECONDS
    )
    active = next((r for r in current if r["status"] in ACTIVE), None)
    value.setdefault("dailyFileLimit", 1000)
    value["connectorOnline"] = online
    value["sourcePath"] = source_path(task)
    value["status"] = (
        "paused"
        if task.get("paused")
        else "waiting_quota"
        if active and active["status"] == "waiting_quota"
        else "needs_attention"
        if task.get("lastError")
        else active["status"]
        if active and active["status"] == "processing"
        else "offline"
        if task["kind"] == "local" and not online
        else active["status"]
        if active
        else "idle"
    )
    value["usage"] = usage_snapshot(store, task)
    value["lastResult"] = current[0].get("counts") if current else None
    value["lastScanAt"] = current[0]["createdAt"] if current else None
    return value


def public_run(run):
    return {
        key: value for key, value in run.items() if key not in {"lease", "agentId", "actorSubject"}
    }


def public_item(item, run=None):
    value = {
        key: v
        for key, v in item.items()
        if key not in {"versionId", "documentId", "attempts", "nextAttemptAt"}
    }
    value["new"] = bool(
        run
        and not run.get("initial")
        and not run.get("readAt")
        and item["status"] == "completed"
        and item["change"] in {"new", "updated"}
    )
    return value
