"""Folder import constants, O_NOFOLLOW server directory walking, and probing."""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import time
from collections import deque
from contextlib import ExitStack, contextmanager
from pathlib import Path, PurePosixPath

from fastapi import HTTPException

from app.core.config import settings
from app.services.information import bridge
from app.services.information.worker import safe_error

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
DIRECTORY_SEARCH_MATCH_LIMIT = 40
DIRECTORY_SEARCH_VISIT_LIMIT = 256
DIRECTORY_SEARCH_SECONDS = 2.0
LOCAL_RUN_STALE_SECONDS = 1800
MAX_INDEX_POLL_ATTEMPTS = 360
MAX_INDEX_POLL_SECONDS = 1800


def _facade():
    from app.services import folder_imports

    return folder_imports


def is_auth_revocation(exc) -> bool:
    if isinstance(exc, HTTPException) and exc.status_code in (401, 403):
        return True
    if isinstance(exc, bridge.BridgeError) and (
        exc.status in (401, 403) or exc.code == "folder_target_missing"
    ):
        return True
    return False


def sanitize_error_path(raw: str, index: int) -> str:
    cleaned = "".join(ch if ord(ch) >= 32 else "_" for ch in str(raw or ""))
    cleaned = cleaned.replace("\\", "/").replace(":", "_").strip("/")
    parts = [p for p in cleaned.split("/") if p and p not in {".", ".."}]
    result = "/".join(parts)[:1400]
    return result or f"invalid-path-{index}.pdf"


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


def directory_name_allowed(name):
    return (
        not name.startswith(".")
        and "\\" not in name
        and ":" not in name
        and not any(ord(c) < 32 or ord(c) == 127 or 0xD800 <= ord(c) <= 0xDFFF for c in name)
    )


@contextmanager
def open_directory_parts(base, parts, *, device=None):
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
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


def open_server_directory(root_id, path, expected_device=None):
    root = next((r for r in roots() if r["id"] == root_id), None)
    if root is None:
        raise HTTPException(422, "请选择管理员已授权的服务器或 NAS 目录")
    return open_configured_directory(root, path, expected_device)


@contextmanager
def open_configured_directory(root, path, expected_device=None):
    base = Path(root["path"])
    parts = PurePosixPath(relative_path(path, allow_empty=True)).parts
    if any(not directory_name_allowed(part) for part in parts):
        raise HTTPException(422, "请选择扫描目录中可见的文件夹")
    try:
        with open_directory_parts(base.anchor, base.parts[1:]) as root_fd:
            device = os.fstat(root_fd).st_dev
            if expected_device is not None and expected_device != device:
                raise HTTPException(409, "扫描目录的挂载已变化，请核对 NAS 连接后重新保存设置")
            with open_directory_parts(root_fd, parts, device=device) as fd:
                yield fd
    except OSError as exc:
        raise HTTPException(409, "扫描文件夹不可访问，请检查挂载或目录权限") from exc


def server_directory(config):
    return open_server_directory(
        config.get("serverRootId"), config.get("path", ""), config.get("sourceDevice")
    )


def _child_directory(entry, path, device):
    name = entry.name
    child = f"{path}/{name}" if path else name
    if not directory_name_allowed(name) or len(child) > 1500:
        return None
    try:
        if entry.is_dir(follow_symlinks=False):
            attrs = entry.stat(follow_symlinks=False)
            if stat.S_ISDIR(attrs.st_mode) and attrs.st_dev == device:
                return child
    except FileNotFoundError:
        pass
    return None


def list_directories(root_id, path="", query=""):
    facade = _facade()
    entry_limit = getattr(facade, "DIRECTORY_ENTRY_LIMIT", DIRECTORY_ENTRY_LIMIT)
    list_limit = getattr(facade, "DIRECTORY_LIST_LIMIT", DIRECTORY_LIST_LIMIT)
    directories, truncated = [], False
    query = query.casefold()
    with open_server_directory(root_id, path) as fd, os.scandir(fd) as entries:
        device = os.fstat(fd).st_dev
        for index, entry in enumerate(entries):
            if index >= entry_limit:
                truncated = True
                break
            if query in entry.name.casefold() and _child_directory(entry, path, device):
                if len(directories) == list_limit:
                    truncated = True
                    break
                directories.append(entry.name)
    return {
        "directories": sorted(directories, key=lambda n: (n.casefold(), n)),
        "truncated": truncated,
    }


def search_directories(query):
    facade = _facade()
    entry_limit = getattr(facade, "DIRECTORY_ENTRY_LIMIT", DIRECTORY_ENTRY_LIMIT)
    visit_limit = getattr(facade, "DIRECTORY_SEARCH_VISIT_LIMIT", DIRECTORY_SEARCH_VISIT_LIMIT)
    match_limit = getattr(facade, "DIRECTORY_SEARCH_MATCH_LIMIT", DIRECTORY_SEARCH_MATCH_LIMIT)
    search_seconds = getattr(facade, "DIRECTORY_SEARCH_SECONDS", DIRECTORY_SEARCH_SECONDS)
    term = query.strip().casefold()
    result = {"directories": [], "truncated": False}
    if not term or "/" in term or not directory_name_allowed(term):
        return result
    pending = deque((root, "") for root in roots())
    deadline = time.monotonic() + search_seconds
    entries_left = entry_limit
    visits_left = visit_limit
    while pending:
        if visits_left <= 0 or entries_left <= 0 or time.monotonic() >= deadline:
            result["truncated"] = True
            break
        root, path = pending.popleft()
        visits_left -= 1
        try:
            with open_configured_directory(root, path) as fd, os.scandir(fd) as entries:
                if path and term in path.rsplit("/", 1)[-1].casefold():
                    if len(result["directories"]) == match_limit:
                        result["truncated"] = True
                        break
                    result["directories"].append({"rootId": root["id"], "path": path})
                device = os.fstat(fd).st_dev
                for entry in entries:
                    if entries_left <= 0 or time.monotonic() >= deadline:
                        result["truncated"] = True
                        break
                    entries_left -= 1
                    child = _child_directory(entry, path, device)
                    if child:
                        pending.append((root, child))
        except HTTPException as exc:
            if exc.status_code != 409:
                raise
            result["truncated"] = True
    result["directories"].sort(
        key=lambda item: (item["path"].casefold(), item["rootId"], item["path"])
    )
    return result


def source_path(config):
    if config["kind"] == "server":
        root = next((r for r in roots() if r["id"] == config.get("serverRootId")), None)
        if not root:
            return "目录连接已失效"
        return str(PurePosixPath(root.get("displayPath", root["path"])) / config.get("path", ""))
    return config.get("path") or config.get("localFolderName") or "尚未连接本机文件夹"


def safe_read(root, relative, max_bytes, *, now=None, heartbeat=None):
    parts = relative_path(relative).split("/")
    name = parts[-1]
    try:
        with ExitStack() as opened:
            root_fd = opened.enter_context(open_directory_parts(root, ()))
            device = os.fstat(root_fd).st_dev
            parent_fd = opened.enter_context(
                open_directory_parts(root_fd, parts[:-1], device=device)
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
                    and directory_name_allowed(entry.name)
                ):
                    with open_directory_parts(directory_fd, (entry.name,), device=device) as fd:
                        walk(fd, path + "/", device)
                elif stat.S_ISREG(attrs.st_mode) and entry.name.lower().endswith(".pdf"):
                    paths.append(path)

    with server_directory(task) as root_fd:
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


def probe_file(root, relative, max_bytes, *, now=None):
    parts = PurePosixPath(relative_path(relative)).parts
    name = parts[-1]
    try:
        with ExitStack() as opened:
            root_fd = opened.enter_context(open_directory_parts(root, ()))
            device = os.fstat(root_fd).st_dev
            parent_fd = opened.enter_context(
                open_directory_parts(root_fd, parts[:-1], device=device)
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
            header = stream.read(16)
            if not header:
                raise ValueError("文件为空")
            return before.st_size
    except PermissionError as exc:
        raise ValueError("知识源没有读取该文件的权限") from exc
    except FileNotFoundError as exc:
        raise ValueError("文件已移走或删除，请重新检查目录") from exc
    except OSError as exc:
        raise ValueError("读取原文件失败，请检查服务器或 NAS 存储连接") from exc


def probe_server(task):
    paths = []

    def walk(directory_fd, prefix, device):
        with os.scandir(directory_fd) as entries:
            for entry in entries:
                if entry.name.startswith(".") or entry.is_symlink():
                    continue
                attrs = entry.stat(follow_symlinks=False)
                if attrs.st_dev != device:
                    continue
                path = prefix + entry.name
                if (
                    stat.S_ISDIR(attrs.st_mode)
                    and task["includeSubfolders"]
                    and directory_name_allowed(entry.name)
                ):
                    with open_directory_parts(directory_fd, (entry.name,), device=device) as fd:
                        walk(fd, path + "/", device)
                elif stat.S_ISREG(attrs.st_mode) and entry.name.lower().endswith(".pdf"):
                    paths.append(path)

    with server_directory(task) as root_fd:
        try:
            walk(root_fd, "", os.fstat(root_fd).st_dev)
        except OSError as exc:
            raise HTTPException(409, "扫描目录断连或部分目录不可访问，未把文件判断为删除") from exc
        paths.sort()
        selected = paths[: task["maxFilesPerScan"]]
        total_bytes, errors = 0, []
        max_bytes = task["maxFileMb"] * 1024 * 1024
        for path in selected:
            try:
                total_bytes += probe_file(root_fd, path, max_bytes)
            except (ValueError, HTTPException) as exc:
                errors.append({"relativePath": path, "error": safe_error(exc)})
    return len(selected), total_bytes, errors, len(paths) > len(selected)


def probe(config):
    from app.services.knowledge_source_folder_quota import normalize_config

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
    file_count, total_bytes, errors, truncated = probe_server(config)
    return {
        "valid": True,
        "fileCount": file_count,
        "totalBytes": total_bytes,
        "truncated": truncated,
        "sourcePath": source_path(config),
        "errors": errors,
    }
