"""Durable folder imports, isolated from ICH and browser lifetimes.

Only configured server roots are read here. Personal folders are read by an
outbound connector with a revocable task-bound token; it never receives KB keys.
"""

import base64
import copy
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import stat
import threading
import time
from contextlib import ExitStack, contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path, PurePosixPath
from uuid import uuid4
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import HTTPException
from sqlalchemy import update
from sqlalchemy.exc import IntegrityError

from app.core.config import settings
from app.db.session import SessionLocal
from app.models.information import InformationEntry, InformationLease
from app.services.information import bridge
from app.services.information.extract import extract_pdf
from app.services.information.store import Store, iso
from app.services.information.worker import authority, safe_error

logger = logging.getLogger("cmc-pms.folder-imports")
TASK = "fi_task"
RUN = "fi_run"
ITEM = "fi_item"
FILE = "fi_file"
BLOB = "fi_blob"
PAIR = "fi_pair"
AGENT = "fi_agent"
USAGE = "fi_usage"
METER = "fi_meter"
QUOTA_MESSAGE = "今日额度已用完，次日继续"
ONLINE_SECONDS = 90
ACTIVE = {"queued", "scanning", "transferring", "processing", "waiting_quota"}
TERMINAL_ITEMS = {"completed", "failed", "unchanged", "ignored"}
SHA = re.compile(r"^[a-f0-9]{64}$")
DIRECTORY_LIST_LIMIT = 200
DIRECTORY_ENTRY_LIMIT = 20000


class LeaseLostError(RuntimeError):
    """An expired worker must stop before issuing any more side effects."""


def roots():
    try:
        values = json.loads(settings.KNOWLEDGE_FOLDER_IMPORT_ROOTS)
    except (ValueError, TypeError) as exc:
        raise HTTPException(503, "自动导入目录配置无效，请联系管理员") from exc
    if not isinstance(values, list) or len(values) > 100:
        raise HTTPException(503, "自动导入目录配置无效，请联系管理员")
    result = []
    for value in values:
        if not isinstance(value, dict) or not all(
            isinstance(value.get(key), str) and value[key].strip() for key in ("id", "name", "path")
        ):
            raise HTTPException(503, "自动导入目录配置无效，请联系管理员")
        path = Path(value["path"])
        if not path.is_absolute() or ".." in path.parts or path.is_symlink():
            raise HTTPException(503, "自动导入根目录必须是已挂载的实际绝对路径")
        root = {"id": value["id"], "name": value["name"], "path": str(path)}
        display = value.get("displayPath")
        if display is not None:
            if (
                not isinstance(display, str)
                or len(display) > 1500
                or not display.startswith("/")
                or display.startswith("//")
                or "\\" in display
                or ".." in PurePosixPath(display).parts
                or any(ord(c) < 32 or ord(c) == 127 or 0xD800 <= ord(c) <= 0xDFFF for c in display)
            ):
                raise HTTPException(503, "自动导入的宿主显示路径必须是有效的绝对目录路径")
            root["displayPath"] = str(PurePosixPath(display))
        result.append(root)
    if len({r["id"] for r in result}) != len(result):
        raise HTTPException(503, "自动导入根目录标识重复")
    display_paths = [r["displayPath"] for r in result if "displayPath" in r]
    if len(set(display_paths)) != len(display_paths):
        raise HTTPException(503, "自动导入的宿主显示路径重复，请核对目录配置")
    return result


def relative_path(value, *, allow_empty=False):
    if not isinstance(value, str) or len(value) > 1500 or any(ord(c) < 32 for c in value):
        raise HTTPException(422, "文件相对路径无效")
    if value == "" and allow_empty:
        return ""
    if not value or "\\" in value or ":" in value or value.startswith("/"):
        raise HTTPException(422, "文件路径必须位于已授权文件夹中")
    parts = value.split("/")
    if any(p in ("", ".", "..") for p in parts) or PurePosixPath(value).is_absolute():
        raise HTTPException(422, "文件路径必须位于已授权文件夹中")
    return value


def _directory_name_allowed(name):
    return (
        not name.startswith(".")
        and "\\" not in name
        and ":" not in name
        and not any(ord(c) < 32 or ord(c) == 127 or 0xD800 <= ord(c) <= 0xDFFF for c in name)
    )


@contextmanager
def _open_directory_parts(base, parts, *, device=None):
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    # Walking an ancestor needs search permission. Only the selected directory needs to be listable.
    search_flags = (
        os.O_DIRECTORY | os.O_NOFOLLOW | getattr(os, "O_PATH", getattr(os, "O_SEARCH", os.O_RDONLY))
    )
    fd = os.dup(base) if isinstance(base, int) else os.open(base, search_flags if parts else flags)
    try:
        for index, part in enumerate(parts):
            next_fd = os.open(part, flags if index == len(parts) - 1 else search_flags, dir_fd=fd)
            os.close(fd)
            fd = next_fd
            if device is not None and os.fstat(fd).st_dev != device:
                raise OSError("目录位于其他挂载")
        yield fd
    finally:
        os.close(fd)


@contextmanager
def _open_server_directory(root_id, path, expected_device=None):
    root = next((r for r in roots() if r["id"] == root_id), None)
    if root is None:
        raise HTTPException(422, "请选择管理员已授权的服务器或 NAS 目录")
    base = Path(root["path"])
    parts = PurePosixPath(relative_path(path, allow_empty=True)).parts
    if any(not _directory_name_allowed(part) for part in parts):
        raise HTTPException(422, "请选择扫描目录中可见的文件夹")
    try:
        # Pin each component before opening its child. The configured root may itself be a mount.
        with _open_directory_parts(base.anchor, base.parts[1:]) as root_fd:
            device = os.fstat(root_fd).st_dev
            if expected_device is not None and expected_device != device:
                raise HTTPException(409, "扫描目录的挂载已变化，请核对 NAS 连接后重新保存设置")
            with _open_directory_parts(root_fd, parts, device=device) as fd:
                yield fd
    except OSError as exc:
        raise HTTPException(409, "扫描文件夹不可访问，请检查挂载或目录权限") from exc


def _server_directory(config):
    return _open_server_directory(
        config.get("serverRootId"), config.get("path", ""), config.get("sourceDevice")
    )


def list_directories(root_id, path="", query=""):
    directories, truncated = [], False
    query = query.casefold()
    with _open_server_directory(root_id, path) as fd, os.scandir(fd) as entries:
        device = os.fstat(fd).st_dev
        for index, entry in enumerate(entries):
            if index >= DIRECTORY_ENTRY_LIMIT:
                truncated = True
                break
            name = entry.name
            if (
                not _directory_name_allowed(name)
                or len(f"{path}/{name}" if path else name) > 1500
                or query not in name.casefold()
                or not entry.is_dir(follow_symlinks=False)
            ):
                continue
            try:
                attrs = entry.stat(follow_symlinks=False)
            except FileNotFoundError:
                continue
            if stat.S_ISDIR(attrs.st_mode) and attrs.st_dev == device:
                if len(directories) == DIRECTORY_LIST_LIMIT:
                    truncated = True
                    break
                directories.append(name)
    return {
        "directories": sorted(directories, key=lambda n: (n.casefold(), n)),
        "truncated": truncated,
    }


def source_path(config):
    if config["kind"] == "server":
        root = next((r for r in roots() if r["id"] == config.get("serverRootId")), None)
        if not root:
            return "目录连接已失效"
        return str(PurePosixPath(root.get("displayPath", root["path"])) / config.get("path", ""))
    return config.get("path") or config.get("localFolderName") or "尚未连接本机文件夹"


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
        with _server_directory(value) as fd:
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
        # Resolve DST gaps by roundtrip; a missed/nonexistent slot runs at its next valid instant.
        candidate = candidate.astimezone(UTC).astimezone(zone)
        if candidate > local:
            return candidate.astimezone(UTC).isoformat()
    raise HTTPException(422, "无法计算下一次扫描时间")


def require_authority(store, subject, connector=bridge.call):
    authority(store.db, subject)
    summary = connector("librarySummary", subject)
    if not summary.get("canWrite"):
        raise HTTPException(403, "文件夹自动导入需要当前知识库整理权限")
    return summary


def _destination(config, summary, subject, connector):
    ident = config.get("folderId")
    if ident:
        folder = next((f for f in summary.get("folders", []) if f["id"] == ident), None)
        if folder is None:
            raise HTTPException(409, "目标文件夹已不存在，请重新选择；不会改存其他位置")
    else:
        folder = connector("ensureInboxFolder", subject)
        ident = folder["id"]
    return ident, folder["name"]


def _task(store, ident, *, lock=False):
    value = store.lock(TASK, ident) if lock else store.get(TASK, ident)
    if value.get("deletedAt"):
        raise HTTPException(404, "自动导入任务已删除")
    return value


def runs_for(store, task_id):
    return sorted(
        (r for r in store.records(RUN) if r["taskId"] == task_id),
        key=lambda r: r["createdAt"],
        reverse=True,
    )


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
    """One durable ledger event per actual stage result, in its commit transaction.

    indexedFiles means successful per-file index confirmations, never inferred
    embedding tokens. Reused content is reported separately.
    """
    # Connector mutations acquire task -> run -> usage. Take the task lock here
    # before touching usage as well, so a worker completion cannot deadlock an
    # in-flight connector upload while publishing its final task/run summary.
    task = store.lock(TASK, task["id"])
    event_id = store.key(METER, task["id"] + ":" + event)
    if store.get(METER, event_id, required=False):
        return
    usage = usage_snapshot(store, task)
    current = store.get(USAGE, usage["id"], required=False)
    if current is None:
        # Local connector writes hold the task/run locks; the worker is globally
        # serialized. The savepoint also handles a first-write race safely.
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


def create_task(store, actor, config, connector=bridge.call):
    config = normalize_config(config)
    summary = require_authority(store, actor["subject"], connector)
    folder, folder_name = _destination(config, summary, actor["subject"], connector)
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
    run, _ = queue_scan(store, task["id"], actor["subject"], connector=connector)
    return public_task(store, _task(store, task["id"]))


def update_task(store, ident, actor, config, connector=bridge.call):
    config = normalize_config(config)
    summary = require_authority(store, actor["subject"], connector)
    folder, folder_name = _destination(config, summary, actor["subject"], connector)
    task = _task(store, ident, lock=True)
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
    task = _task(store, ident, lock=True)
    require_authority(store, subject, connector)
    _destination(task, connector("librarySummary", subject), subject, connector)
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
    task = _task(store, ident, lock=True)
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
        _destination(
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
            task = _task(store, ident)
    else:
        raise HTTPException(422, "操作无效")
    task["updatedAt"] = iso()
    store.put(TASK, task)
    store.audit(actor["subject"], "folder_import_task_" + action, ident)
    store.db.commit()
    return public_task(store, task)


def pair_code(store, ident, actor, connector=bridge.call):
    require_authority(store, actor["subject"], connector)
    task = _task(store, ident)
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
    task = _task(store, pairing["taskId"], lock=True)
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
    task = _task(store, agent["taskId"])
    if agent.get("revokedAt") or task.get("agentId") != ident:
        raise HTTPException(401, "此连接授权已撤销，请重新配对")
    require_authority(store, task["actorSubject"], connector)
    agent["lastSeen"] = time.time()
    store.put(AGENT, agent)
    db.commit()
    return store, agent, task


def connector_poll(store, agent, task):
    task = _task(store, task["id"], lock=True)
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
    task = _task(store, task["id"], lock=True)
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


def items_for(store, run_id):
    return sorted(
        (v for v in store.records(ITEM) if v["runId"] == run_id), key=lambda i: i["relativePath"]
    )


def _file_id(store, task_id, path):
    return store.key(FILE, task_id + ":" + path)


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
    for error in errors:
        path = relative_path(error["relativePath"])
        if path in seen:
            raise HTTPException(422, "文件清单含重复路径")
        seen.add(path)
    need = []
    for value in files:
        path, sha = value["relativePath"], value["sha256"]
        item_id = store.key(ITEM, run["id"] + ":" + path)
        current = store.get(ITEM, item_id, required=False)
        if current:
            if current["sha256"] != sha or current["size"] != value["size"]:
                if (
                    current.get("allowChangedFingerprint")
                    and not current.get("originalSaved")
                    and current["status"] == "pending"
                ):
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
        previous = store.get(FILE, _file_id(store, task["id"], path), required=False)
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
    for error in errors:
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
    # An incomplete listing never changes missing/source-deletion status.
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
    existing_blob = store.get(BLOB, store.key(BLOB, sha), required=False)
    source_id = store.key("source", "folder-imports")
    if not store.get("source", source_id, required=False):
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
    document_id = store.key("document", "folder:" + sha)
    if not store.get("document", document_id, required=False):
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
        task = _task(store, run["taskId"])
        task.update(lastError=run["error"], updatedAt=iso())
        store.put(TASK, task)
        # One stable summary per batch; no-change scans do not send noisy alerts.
        if run["new"] or run["updated"] or run["failed"]:
            store.put(
                "event",
                {
                    "id": store.key("event", "folder-run:" + ident),
                    "sourceId": store.key("source", "folder-imports"),
                    "kind": "首次导入" if run["initial"] else "自动导入汇总",
                    "title": task["name"],
                    "summary": f'新增 {run["new"]}，更新 {run["updated"]}，完成 {run["completed"]}，失败 {run["failed"]}',
                    "createdAt": iso(),
                    "read": False,
                },
            )
    store.put(RUN, run)
    return run


def retry_run(store, ident, actor, connector=bridge.call, *, item_ids=None):
    run = store.get(RUN, ident)
    task = _task(store, run["taskId"], lock=True)
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


def safe_read(root, relative, max_bytes, *, now=None, heartbeat=None):
    parts = relative_path(relative).split("/")
    name = parts[-1]
    try:
        with ExitStack() as opened:
            root_fd = opened.enter_context(_open_directory_parts(root, ()))
            device = os.fstat(root_fd).st_dev
            parent_fd = opened.enter_context(
                _open_directory_parts(root_fd, parts[:-1], device=device)
            )
            flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
            fd = os.open(name, flags, dir_fd=parent_fd)
            opened.callback(os.close, fd)
            stream = opened.enter_context(os.fdopen(fd, "rb", closefd=False))
            before = os.fstat(stream.fileno())
            if not stat.S_ISREG(before.st_mode) or before.st_dev != device:
                raise ValueError("文件不是可读取的普通文件")
            if before.st_size == 0:
                raise ValueError("文件为空")
            if before.st_size > max_bytes:
                raise ValueError(f"超过本任务单份 PDF 的大小上限（{max_bytes / 1024**2:g} MB）")
            if (time.time() if now is None else now) - before.st_mtime < 2:
                raise ValueError("文件仍在写入，稳定后可重试")
            chunks, total = [], 0
            while True:
                if heartbeat:
                    heartbeat()
                chunk = stream.read(min(4 * 1024 * 1024, max_bytes + 1 - total))
                if not chunk:
                    break
                chunks.append(chunk)
                total += len(chunk)
                if total > max_bytes:
                    raise ValueError("文件读取期间超过大小上限")
            content = b"".join(chunks)
            after = os.fstat(stream.fileno())
            current_stat = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
            if (
                (before.st_size, before.st_mtime_ns, before.st_ino, before.st_dev)
                != (after.st_size, after.st_mtime_ns, after.st_ino, after.st_dev)
                or (after.st_ino, after.st_dev) != (current_stat.st_ino, current_stat.st_dev)
                or len(content) != before.st_size
            ):
                raise ValueError("文件读取期间发生变化，稳定后可重试")
            return content, before
    except PermissionError as exc:
        raise ValueError("知识源没有读取该文件的权限") from exc
    except FileNotFoundError as exc:
        raise ValueError("文件已移走或删除，请重新检查目录") from exc
    except OSError as exc:
        raise ValueError("读取原文件失败，请检查服务器或 NAS 存储连接") from exc


def scan_server(task, heartbeat=None):
    paths = []

    def walk(directory_fd, prefix, device):
        with os.scandir(directory_fd) as entries:
            for entry in entries:
                if heartbeat:
                    heartbeat()
                if entry.name.startswith(".") or entry.is_symlink():
                    continue
                attrs = entry.stat(follow_symlinks=False)
                if attrs.st_dev != device:
                    continue
                path = prefix + entry.name
                if (
                    stat.S_ISDIR(attrs.st_mode)
                    and task["includeSubfolders"]
                    and _directory_name_allowed(entry.name)
                ):
                    with _open_directory_parts(directory_fd, (entry.name,), device=device) as fd:
                        walk(fd, path + "/", device)
                elif stat.S_ISREG(attrs.st_mode) and entry.name.lower().endswith(".pdf"):
                    paths.append(path)

    with _server_directory(task) as root_fd:
        try:
            walk(root_fd, "", os.fstat(root_fd).st_dev)
        except OSError as exc:
            raise HTTPException(409, "扫描目录断连或部分目录不可访问，未把文件判断为删除") from exc
        paths.sort()
        cursor = task.get("scanCursor", "")
        ordered = [p for p in paths if p > cursor] + [p for p in paths if p <= cursor]
        selected = ordered[: task["maxFilesPerScan"]]
        files, errors = [], []
        for path in selected:
            try:
                content, attrs = safe_read(
                    root_fd, path, task["maxFileMb"] * 1024 * 1024, heartbeat=heartbeat
                )
                files.append(
                    {
                        "relativePath": path,
                        "size": len(content),
                        "mtime": attrs.st_mtime,
                        "sha256": hashlib.sha256(content).hexdigest(),
                    }
                )
            except (ValueError, HTTPException) as exc:
                errors.append({"relativePath": path, "error": safe_error(exc)})
    return files, errors, len(paths) > len(selected), selected[-1] if selected else ""


def probe(config):
    config = normalize_config(config)
    if config["kind"] == "local":
        return {
            "valid": True,
            "fileCount": None,
            "totalBytes": None,
            "truncated": False,
            "sourcePath": source_path(config),
            "message": "保存任务后连接本机文件夹；网页关闭后连接程序继续运行",
        }
    files, errors, truncated, _ = scan_server(config)
    return {
        "valid": True,
        "fileCount": len(files) + len(errors),
        "totalBytes": sum(f["size"] for f in files),
        "truncated": truncated,
        "sourcePath": source_path(config),
        "errors": errors,
    }


def _item_destination(store, task, run, item, subject, connector):
    folder_id = run["folderId"]
    summary = connector("librarySummary", subject)
    if not summary.get("canWrite") or not any(
        f["id"] == folder_id for f in summary.get("folders", [])
    ):
        raise HTTPException(409, "目标文件夹已不存在或权限失效，请重新配置后继续")
    if not run.get("preserveHierarchy"):
        return folder_id
    for segment in PurePosixPath(item["relativePath"]).parts[:-1]:
        known = next(
            (
                f
                for f in summary["folders"]
                if f.get("parentId") == folder_id and f["name"] == segment
            ),
            None,
        )
        if known:
            folder_id = known["id"]
            continue
        summary = connector(
            "folderMutation",
            subject,
            mutation={
                "operation": "create",
                "revision": summary["revision"],
                "name": segment,
                "parentId": folder_id,
            },
        )
        found = next(
            (
                f
                for f in summary["folders"]
                if f.get("parentId") == folder_id and f["name"] == segment
            ),
            None,
        )
        if not found:
            raise ValueError("子文件夹尚未创建成功，请稍后重试")
        folder_id = found["id"]
    return folder_id


def process_item(
    store, task, run, item, connector=bridge.call, extract=extract_pdf, heartbeat=None
):
    subject = run["actorSubject"]
    require_authority(store, subject, connector)
    destination = _item_destination(store, task, run, item, subject, connector)
    latest_task = store.get(TASK, task["id"])
    latest_run = store.get(RUN, run["id"])
    if (
        latest_task.get("paused")
        or latest_task.get("deletedAt")
        or latest_run["status"] not in ACTIVE
    ):
        return False
    try:
        if not item.get("originalSaved"):
            if task["kind"] != "server":
                return False
            with _server_directory(task) as root_fd:
                content, attrs = safe_read(
                    root_fd,
                    item["relativePath"],
                    task["maxFileMb"] * 1024 * 1024,
                    heartbeat=heartbeat,
                )
            actual_sha = hashlib.sha256(content).hexdigest()
            if item.get("allowChangedFingerprint") or not SHA.fullmatch(item["sha256"]):
                item.update(
                    sha256=actual_sha,
                    size=len(content),
                    mtime=attrs.st_mtime,
                    allowChangedFingerprint=False,
                )
                store.put(ITEM, item)
                store.db.commit()
            elif actual_sha != item["sha256"] or len(content) != item["size"]:
                raise ValueError("文件在扫描后发生变化，请重试该文件以重新核对")
            save_original(store, task, run, item["relativePath"], item["sha256"], content)
            return True
        version = store.get("version", item["versionId"])
        source_key = hashlib.sha256((task["id"] + ":" + item["relativePath"]).encode()).hexdigest()
        if not item.get("kbDocumentId") or (
            version.get("parseStatus") == "ready" and not item.get("kbTextReady")
        ):
            item["phase"] = "archive"
            store.put(ITEM, item)
            store.db.commit()
            reply = connector(
                "folderImportPaper",
                subject,
                taskId=task["id"],
                sourceKey=source_key,
                name=PurePosixPath(item["relativePath"]).name,
                originalBase64=base64.b64encode(store.archive_path(version).read_bytes()).decode(
                    "ascii"
                ),
                sha256=item["sha256"],
                text=version.get("text", ""),
                folderId=destination,
            )
            if not reply.get("documentId") or not reply.get("path"):
                raise ValueError("知识库未返回可确认的原件记录")
            item.update(
                kbDocumentId=reply["documentId"],
                paperId=reply["path"],
                indexStatus=reply.get("indexStatus", "not_requested"),
                phase="index" if version.get("parseStatus") == "ready" else "parse",
                kbTextReady=version.get("parseStatus") == "ready",
            )
            version.update(
                kbDocumentId=reply["documentId"],
                kbPath=reply["path"],
                kbUrl=reply.get("url"),
                kbPending=not reply.get("registered", False),
                indexStatus=item["indexStatus"],
            )
            store.put("version", version)
        elif version.get("parseStatus") != "ready":
            item["phase"] = "parse"
            store.put(ITEM, item)
            store.db.commit()
            extracted = (
                extract(store.archive_path(version), with_metadata=True)
                if extract is extract_pdf
                else extract(store.archive_path(version))
            )
            text = extracted["text"] if isinstance(extracted, dict) else extracted
            pages = extracted.get("pages") if isinstance(extracted, dict) else None
            known_pages = (
                isinstance(pages, int) and not isinstance(pages, bool) and 0 <= pages <= 1000
            )
            meter_usage(
                store,
                task,
                "parse:" + version["id"],
                parsedCharacters=len(text),
                parsedPages=pages if known_pages else 0,
                unknownParsedPages=0 if known_pages else 1,
            )
            version.update(
                text=text,
                parseStatus="ready",
                error=None,
                parsedPages=pages if known_pages else None,
            )
            store.put("version", version)
            item.update(phase="archive", error=None)
        else:
            item["phase"] = "index"
            store.put(ITEM, item)
            store.db.commit()
            operation = "statusFolderPaper" if item.get("kbTaskId") else "indexFolderPaper"
            values = {
                "importTaskId": task["id"],
                "sourceKey": source_key,
                "documentId": item["kbDocumentId"],
                "sha256": item["sha256"],
            }
            if item.get("kbTaskId"):
                values["taskId"] = item["kbTaskId"]
            reply = connector(operation, subject, **values)
            state = reply.get("indexStatus")
            if state not in {"pending", "ready", "failed"}:
                raise ValueError("知识库未返回可确认的索引状态")
            if state == "pending" and (
                not isinstance(reply.get("taskId"), str)
                or not reply["taskId"]
                or len(reply["taskId"]) > 255
            ):
                raise ValueError("知识库未返回可确认的索引任务编号")
            item["kbTaskId"] = reply.get("taskId", item.get("kbTaskId"))
            item["indexStatus"] = state
            version.update(indexStatus=state, kbPending=not reply.get("registered", False))
            if state == "failed":
                item.pop("kbTaskId", None)
                raise ValueError(str(reply.get("error") or "问答索引未完成，请查看索引配置后重试"))
            if state == "ready" and reply.get("registered") is True:
                item.update(status="completed", phase="done", error=None, finishedAt=iso())
                meter_usage(
                    store,
                    task,
                    "complete:" + item["id"],
                    completedFiles=1,
                    indexedFiles=1,
                    reusedFiles=1 if item.get("reused") else 0,
                )
                file_id = _file_id(store, task["id"], item["relativePath"])
                old = store.get(FILE, file_id, required=False) or {
                    "id": file_id,
                    "taskId": task["id"],
                    "relativePath": item["relativePath"],
                    "versions": [],
                }
                history = old.get("versions", [])
                if not any(v["sha256"] == item["sha256"] for v in history):
                    history.append(
                        {
                            "sha256": item["sha256"],
                            "versionId": item["versionId"],
                            "paperId": item["paperId"],
                            "completedAt": iso(),
                        }
                    )
                old.update(
                    sha256=item["sha256"],
                    versionId=item["versionId"],
                    documentId=item["documentId"],
                    paperId=item["paperId"],
                    status="completed",
                    versions=history,
                    sourceMissing=False,
                    lastSeenAt=iso(),
                )
                store.put(FILE, old)
                document = store.get("document", item["documentId"])
                document.update(
                    status="ready",
                    folderIds=sorted(set(document.get("folderIds", [])) | {destination}),
                )
                store.put("document", document)
            else:
                item["nextAttemptAt"] = time.time() + 5
            store.put("version", version)
        item["attempts"] = 0
    except LeaseLostError:
        raise
    except Exception as exc:
        store.db.rollback()
        error = safe_error(exc)
        item["error"] = error
        item["attempts"] = item.get("attempts", 0) + 1
        deleted = isinstance(exc, bridge.BridgeError) and (
            getattr(exc, "code", None) == "folder_source_deleted"
            or (exc.status == 409 and any(v in str(exc) for v in ("已删除", "正在删除")))
        )
        if deleted:
            item.update(status="ignored", phase="done", suppressed=True)
            file_id = _file_id(store, task["id"], item["relativePath"])
            old = store.get(FILE, file_id, required=False) or {
                "id": file_id,
                "taskId": task["id"],
                "relativePath": item["relativePath"],
            }
            old.update(sha256=item["sha256"], suppressed=True, status="ignored")
            store.put(FILE, old)
        elif (isinstance(exc, HTTPException) and exc.status_code in (403, 409)) or (
            isinstance(exc, bridge.BridgeError)
            and (exc.status == 403 or exc.code == "folder_target_missing")
        ):
            current = _task(store, task["id"])
            current.update(paused=True, lastError=error, nextScanAt=None)
            store.put(TASK, current)
        elif item["attempts"] >= 3 or (isinstance(exc, ValueError) and item["phase"] == "parse"):
            item["status"] = "failed"
        else:
            item["nextAttemptAt"] = time.time() + 10 * (2 ** (item["attempts"] - 1))
    store.put(ITEM, item)
    refresh_run(store, run["id"])
    store.db.commit()
    return True


def process_run(store, run_id, connector=bridge.call, extract=extract_pdf, heartbeat=None):
    run = store.get(RUN, run_id)
    task = _task(store, run["taskId"])
    if task.get("paused") or run["status"] not in ACTIVE:
        return False
    if run["status"] == "waiting_quota" and usage_snapshot(store, task)["remainingFiles"] == 0:
        return False
    require_authority(store, run["actorSubject"], connector)
    _destination(
        task, connector("librarySummary", run["actorSubject"]), run["actorSubject"], connector
    )
    if task["kind"] == "server" and not run.get("manifestReceived"):
        files, errors, truncated, cursor = scan_server(task, heartbeat)
        task = store.get(TASK, task["id"])
        run = store.get(RUN, run_id)
        if task.get("paused") or task.get("deletedAt") or run["status"] not in ACTIVE:
            store.db.rollback()
            return False
        apply_manifest(store, task, run, files, errors, truncated)
        task = store.lock(TASK, task["id"])
        if task.get("deletedAt"):
            store.db.rollback()
            return False
        task["scanCursor"] = cursor
        store.put(TASK, task)
        run = store.get(RUN, run_id)
        run.update(manifestComplete=True, status="processing", phase="process")
        task["hasScanned"] = True
        store.put(TASK, task)
        store.put(RUN, run)
        refresh_run(store, run_id)
        store.db.commit()
        return True
    if not run.get("manifestComplete"):
        return False
    pending = next(
        (
            i
            for i in items_for(store, run_id)
            if i["status"] == "pending" and i.get("nextAttemptAt", 0) <= time.time()
        ),
        None,
    )
    if pending:
        if wait_for_quota(store, task, run):
            return False
        run = store.get(RUN, run_id)
        return process_item(store, task, run, pending, connector, extract, heartbeat)
    refresh_run(store, run_id)
    store.db.commit()
    return False


def schedule_due(db, now=None, connector=bridge.call):
    timestamp = time.time() if now is None else now
    for row in db.query(InformationEntry).filter_by(kind=TASK).all():
        task = row.data
        if task.get("deletedAt") or task.get("paused") or not task.get("nextScanAt"):
            continue
        if datetime.fromisoformat(task["nextScanAt"]).timestamp() > timestamp:
            continue
        store = Store(db, row.tenant)
        try:
            queue_scan(store, task["id"], task["actorSubject"], connector=connector, scheduled=True)
        except Exception as exc:
            db.rollback()
            current = _task(store, task["id"])
            current.update(lastError=safe_error(exc), paused=True, nextScanAt=None)
            store.put(TASK, current)
            db.commit()


def tick(session_factory=SessionLocal, connector=bridge.call):
    if not settings.KNOWLEDGE_SOURCE_APP_ENABLED or not settings.KNOWLEDGE_SOURCE_WORKER_ENABLED:
        return
    db = session_factory()
    owner = str(uuid4())
    lease_id = "folder-import-worker"
    acquired = False
    try:
        if db.get(InformationLease, lease_id) is None:
            try:
                with db.begin_nested():
                    db.add(InformationLease(id=lease_id, owner="", expires_at=0))
                    db.flush()
            except IntegrityError:
                pass
        acquired = (
            db.execute(
                update(InformationLease)
                .where(InformationLease.id == lease_id, InformationLease.expires_at <= time.time())
                .values(owner=owner, expires_at=time.time() + 300)
            ).rowcount
            == 1
        )
        db.commit()
        if not acquired:
            return
        last_heartbeat = time.monotonic()

        def heartbeat():
            nonlocal last_heartbeat
            if time.monotonic() - last_heartbeat < 10:
                return
            changed = db.execute(
                update(InformationLease)
                .where(InformationLease.id == lease_id, InformationLease.owner == owner)
                .values(expires_at=time.time() + 300)
            ).rowcount
            db.commit()
            if changed != 1:
                raise LeaseLostError()
            last_heartbeat = time.monotonic()

        schedule_due(db, connector=connector)
        for row in (
            db.query(InformationEntry)
            .filter(
                InformationEntry.kind == RUN,
                InformationEntry.data["status"].as_string().in_(list(ACTIVE)),
            )
            .order_by(InformationEntry.updated_at)
            .all()
        ):
            store = Store(db, row.tenant)
            try:
                if process_run(store, row.id, connector, heartbeat=heartbeat):
                    break
            except LeaseLostError:
                db.rollback()
                return
            except Exception as exc:
                db.rollback()
                run = store.get(RUN, row.id)
                task = store.get(TASK, run["taskId"])
                if task.get("deletedAt"):
                    continue
                task.update(lastError=safe_error(exc), paused=True, nextScanAt=None)
                store.put(TASK, task)
                run["error"] = safe_error(exc)
                store.put(RUN, run)
                db.commit()
    except Exception:
        db.rollback()
        logger.exception("Folder import worker step failed")
    finally:
        if acquired:
            db.execute(
                update(InformationLease)
                .where(InformationLease.id == lease_id, InformationLease.owner == owner)
                .values(owner="", expires_at=0)
            )
            db.commit()
        db.close()


def start_worker():
    stop = threading.Event()

    def loop():
        while not stop.wait(2):
            tick()

    thread = threading.Thread(target=loop, name="knowledge-folder-imports", daemon=True)
    thread.start()
    return stop, thread
