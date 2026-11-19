#!/usr/bin/env python3
"""Outbound-only, task-scoped folder connector. Python 3.10+, no extra packages."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
import http.client
import json
import os
import plistlib
import socket
import ssl
import stat
import sys
import subprocess
import tempfile
import time
import unicodedata
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit
from uuid import uuid4

API = "/api/v1/knowledge-sources/v3/folder-imports/connector"


class ConnectorError(Exception):
    pass


class ReconnectRequired(ConnectorError):
    pass


def server_origin(value):
    url = urlsplit(value)
    if (
        url.scheme not in {"http", "https"}
        or not url.hostname
        or url.username
        or url.password
        or url.path not in {"", "/"}
        or url.query
        or url.fragment
        or (
            url.scheme == "http"
            and url.hostname not in {"localhost", "127.0.0.1", "::1"}
        )
    ):
        raise ConnectorError(
            "服务器请填写 HTTPS 网址；本机测试使用 http://localhost:1234。"
        )
    try:
        _ = url.port
    except ValueError as exc:
        raise ConnectorError("服务器端口无效。") from exc
    return value.rstrip("/")


def relative_path(value):
    if (
        not isinstance(value, str)
        or not value
        or "\\" in value
        or ":" in value
        or "\0" in value
    ):
        raise ConnectorError("文件相对路径无效。")
    path = PurePosixPath(value)
    if path.is_absolute() or any(p in {".", "..", ""} for p in value.split("/")):
        raise ConnectorError("文件路径超出授权目录。")
    return path


def open_file(root, relative):
    parts = relative_path(relative).parts
    path = root.joinpath(*parts)
    current = root
    for part in parts:
        current = current / part
        if current.is_symlink():
            raise ConnectorError("跳过符号链接文件或目录。")
    if not path.resolve(strict=True).is_relative_to(root):
        raise ConnectorError("文件路径超出授权目录。")
    if os.open in os.supports_dir_fd and hasattr(os, "O_NOFOLLOW"):
        # Resolve each component through a non-following directory handle so a
        # concurrent symlink replacement cannot redirect reads outside the root.
        directory_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            for part in parts[:-1]:
                following = os.open(
                    part,
                    os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                    dir_fd=directory_fd,
                )
                os.close(directory_fd)
                directory_fd = following
            fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory_fd)
        finally:
            os.close(directory_fd)
    else:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    stream = os.fdopen(fd, "rb")
    if os.name == "nt":
        # Check the opened handle, after Windows resolves junctions/reparse
        # points. A path-only check before open has a replacement race.
        import ctypes
        import msvcrt
        from ctypes import wintypes

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        final_path = kernel.GetFinalPathNameByHandleW
        final_path.argtypes = [
            wintypes.HANDLE,
            wintypes.LPWSTR,
            wintypes.DWORD,
            wintypes.DWORD,
        ]
        final_path.restype = wintypes.DWORD
        buffer = ctypes.create_unicode_buffer(32768)
        size = final_path(msvcrt.get_osfhandle(stream.fileno()), buffer, len(buffer), 0)
        if not size or size >= len(buffer):
            stream.close()
            raise ConnectorError("无法确认文件位于授权目录。")
        final = buffer.value
        if final.startswith("\\\\?\\UNC\\"):
            final = "\\\\" + final[8:]
        elif final.startswith("\\\\?\\"):
            final = final[4:]
        if not Path(final).is_relative_to(root):
            stream.close()
            raise ConnectorError("文件路径超出授权目录。")
    if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
        stream.close()
        raise ConnectorError("只读取普通文件。")
    return stream


def fingerprint(info):
    return info.st_size, info.st_mtime_ns, info.st_ino


def digest_stream(stream):
    digest = hashlib.sha256()
    for chunk in iter(lambda: stream.read(256 * 1024), b""):
        digest.update(chunk)
    return digest.hexdigest()


def save_state(path, value):
    path = Path(path).expanduser()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink():
        raise ConnectorError("连接配置不能是符号链接。")
    fd, temporary = tempfile.mkstemp(prefix=".folder-connector-", dir=path.parent)
    try:
        os.chmod(temporary, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def load_state(path):
    path = Path(path).expanduser()
    if path.is_symlink():
        raise ConnectorError("连接配置不能是符号链接。")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        server_origin(value["server"])
        if not isinstance(value.get("token"), str) or not value["token"]:
            raise ValueError("missing token")
        os.chmod(path, 0o600)
        return value
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise ConnectorError("无法读取连接配置，请先用配对码连接文件夹。") from exc


@contextmanager
def single_instance(config):
    path = Path(config).expanduser().with_suffix(".lock")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink():
        raise ConnectorError("连接锁定文件不能是符号链接。")
    stream = path.open("a+b")
    os.chmod(path, 0o600)
    try:
        try:
            if os.name == "nt":
                import msvcrt

                stream.seek(0)
                if not stream.read(1):
                    stream.write(b"0")
                    stream.flush()
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise ConnectorError("此文件夹的连接程序已经运行，请勿重复启动。") from exc
        yield
    finally:
        stream.close()  # OS releases the lock, including after a process crash.


def startup(config, remove=False):
    """Install only a per-user login item, never a privileged system service."""
    identity = hashlib.sha256(str(config.resolve()).encode()).hexdigest()[:12]
    label = "ai.openlims.folder-" + identity
    command = [
        sys.executable,
        str(Path(__file__).resolve()),
        "--config",
        str(config.resolve()),
    ]
    if any(any(ord(c) < 32 for c in arg) for arg in command):
        raise ConnectorError("启动程序或配置路径包含无效控制字符。")
    if sys.platform == "darwin":
        destination = Path.home() / "Library/LaunchAgents" / (label + ".plist")
        domain = "gui/" + str(os.getuid())
        if destination.exists():
            subprocess.run(
                ["launchctl", "bootout", domain, str(destination)],
                capture_output=True,
                check=False,
            )
        if remove:
            destination.unlink(missing_ok=True)
        else:
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(
                plistlib.dumps(
                    {
                        "Label": label,
                        "ProgramArguments": command,
                        "RunAtLoad": True,
                        "KeepAlive": {"SuccessfulExit": False},
                        "ThrottleInterval": 30,
                    }
                )
            )
            os.chmod(destination, 0o600)
            result = subprocess.run(
                ["launchctl", "bootstrap", domain, str(destination)],
                capture_output=True,
            )
            if result.returncode:
                raise ConnectorError(
                    "登录启动项已保存，当前未能启动；请重新登录电脑或手动运行连接程序。"
                )
    elif sys.platform == "win32":
        destination = (
            Path(os.environ["APPDATA"])
            / "Microsoft/Windows/Start Menu/Programs/Startup"
            / (label + ".lnk")
        )
        if remove:
            destination.unlink(missing_ok=True)
        else:
            # A Pythonw process has no console window and retains the same state.
            executable = Path(sys.executable).with_name("pythonw.exe")
            if executable.is_file():
                command[0] = str(executable)
            destination.parent.mkdir(parents=True, exist_ok=True)

            def literal(value):
                return "'" + value.replace("'", "''") + "'"

            script = (
                "$w=New-Object -ComObject WScript.Shell;$s=$w.CreateShortcut("
                + literal(str(destination))
                + ");$s.TargetPath="
                + literal(command[0])
                + ";$s.Arguments="
                + literal(subprocess.list2cmdline(command[1:]))
                + ";$s.Save()"
            )
            result = subprocess.run(
                ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
                capture_output=True,
            )
            if result.returncode:
                raise ConnectorError(
                    "无法创建当前用户的登录启动项，请先手动运行连接程序。"
                )
    elif sys.platform.startswith("linux"):
        destination = Path.home() / ".config/systemd/user" / (label + ".service")
        if remove:
            subprocess.run(
                ["systemctl", "--user", "disable", "--now", destination.name],
                capture_output=True,
                check=False,
            )
            destination.unlink(missing_ok=True)
        else:
            destination.parent.mkdir(parents=True, exist_ok=True)
            escaped = " ".join(
                '"'
                + part.replace("\\", "\\\\")
                .replace('"', '\\"')
                .replace("%", "%%")
                .replace("$", "$$")
                + '"'
                for part in command
            )
            destination.write_text(
                "[Unit]\nDescription=Knowledge folder connector\nAfter=network-online.target\n[Service]\nExecStart="
                + escaped
                + "\nRestart=on-failure\nRestartSec=30\n[Install]\nWantedBy=default.target\n",
                encoding="utf-8",
            )
            subprocess.run(
                ["systemctl", "--user", "daemon-reload"],
                capture_output=True,
                check=True,
            )
            result = subprocess.run(
                ["systemctl", "--user", "enable", "--now", destination.name],
                capture_output=True,
            )
            if result.returncode:
                raise ConnectorError(
                    "无法启用当前用户的登录启动服务，请先手动运行连接程序。"
                )
    else:
        raise ConnectorError(
            "当前系统暂不支持自动安装启动项，可以手动保持连接程序运行。"
        )
    print(
        "已移除登录启动项。" if remove else "已启用当前用户登录后的自动连接。",
        flush=True,
    )


class Client:
    def __init__(self, server, token=None):
        self.url = urlsplit(server_origin(server))
        self.token = token

    def connection(self):
        if self.url.scheme == "https":
            return http.client.HTTPSConnection(
                self.url.hostname,
                self.url.port,
                timeout=180,
                context=ssl.create_default_context(),
            )
        return http.client.HTTPConnection(self.url.hostname, self.url.port, timeout=180)

    def headers(self, lease=None):
        result = {"Accept": "application/json"}
        if self.token:
            result["Authorization"] = "Bearer " + self.token
        if lease:
            result["X-Folder-Run-Lease"] = lease
        return result

    @staticmethod
    def response(connection):
        reply = connection.getresponse()
        raw = reply.read(2 * 1024 * 1024 + 1)
        if reply.status in {401, 403}:
            raise ReconnectRequired("连接授权已失效，请检查任务权限或重新配对。")
        # Redirects deliberately fail: credentials must never travel to another origin.
        if reply.status in {301, 302, 303, 307, 308}:
            raise ConnectorError(
                "服务器发生跳转，请使用工作台的最终 HTTPS 地址重新配对。"
            )
        if not 200 <= reply.status < 300:
            raise ConnectorError(
                f"服务器暂未接受请求（{reply.status}），已保存进度将保留。"
            )
        try:
            value = json.loads(raw)
            if not isinstance(value, dict):
                raise ValueError("object required")
            return value
        except (ValueError, UnicodeError) as exc:
            raise ConnectorError(
                "服务器返回结果无效，未将本次扫描标记为成功。"
            ) from exc

    def post(self, route, data, lease=None):
        connection = self.connection()
        try:
            connection.request(
                "POST",
                API + route,
                json.dumps(data, ensure_ascii=False).encode(),
                {**self.headers(lease), "Content-Type": "application/json"},
            )
            return self.response(connection)
        finally:
            connection.close()

    def upload(self, run_id, lease, root, record):
        relative = record["relativePath"]
        boundary = "folder-" + uuid4().hex
        prefix = b""
        for key, value in (("relativePath", relative), ("sha256", record["sha256"])):
            prefix += (
                f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n'
                f"{value}\r\n"
            ).encode()
        prefix += (
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; '
            'filename="document.pdf"\r\nContent-Type: application/pdf\r\n\r\n'
        ).encode()
        suffix = f"\r\n--{boundary}--\r\n".encode()
        with open_file(root, relative) as stream:
            before = os.fstat(stream.fileno())
            if (
                before.st_size != record["size"]
                or before.st_mtime != record["mtime"]
                or digest_stream(stream) != record["sha256"]
            ):
                raise ConnectorError("文件扫描后发生变化，等待下次扫描。")
            stream.seek(0)
            connection = self.connection()
            try:
                connection.putrequest("POST", API + f"/runs/{run_id}/files")
                for key, value in {
                    **self.headers(lease),
                    "Content-Type": "multipart/form-data; boundary=" + boundary,
                    "Content-Length": str(len(prefix) + before.st_size + len(suffix)),
                }.items():
                    connection.putheader(key, value)
                connection.endheaders()
                connection.send(prefix)
                remaining = before.st_size
                while remaining:
                    chunk = stream.read(min(256 * 1024, remaining))
                    if not chunk:
                        raise ConnectorError("文件读取不完整，等待下次扫描。")
                    connection.send(chunk)
                    remaining -= len(chunk)
                connection.send(suffix)
                result = self.response(connection)
                if fingerprint(os.fstat(stream.fileno())) != fingerprint(before):
                    raise ConnectorError("传输时文件发生变化，等待下次扫描核对。")
                if result.get("saved") is not True:
                    raise ConnectorError("服务器尚未确认保存原件。")
                return result
            finally:
                connection.close()


def manifest(root, task, cursor="", stable_seconds=2):
    candidates, errors = [], []
    for directory, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = sorted(
            d
            for d in dirs
            if not d.startswith(".") and not (Path(directory) / d).is_symlink()
        )
        if not task.get("includeSubfolders", True):
            dirs[:] = []
        for name in sorted(files):
            if name.startswith(".") or not name.lower().endswith(".pdf"):
                continue
            path = Path(directory) / name
            relative = path.relative_to(root).as_posix()
            try:
                if path.is_symlink():
                    continue
                info = path.stat()
                if stat.S_ISREG(info.st_mode):
                    candidates.append((relative, fingerprint(info)))
            except OSError:
                errors.append(
                    {"relativePath": relative, "error": "文件暂不可读，等待下次扫描。"}
                )
    candidates.sort()
    limit = max(1, min(int(task.get("maxFilesPerScan", 10000)), 10000))
    truncated = len(candidates) > limit
    if truncated:
        candidates = [r for r in candidates if r[0] > cursor] + [
            r for r in candidates if r[0] <= cursor
        ]
    candidates = candidates[:limit]
    if candidates and stable_seconds:
        time.sleep(stable_seconds)
    records = []
    for relative, earlier in candidates:
        try:
            with open_file(root, relative) as stream:
                before = os.fstat(stream.fileno())
                if fingerprint(before) != earlier:
                    raise ConnectorError("文件正在写入，等待下次扫描。")
                if before.st_size == 0:
                    raise ConnectorError("文件为空，等待文件写入完成后再次扫描。")
                if before.st_size > int(task.get("maxFileMb", 100)) * 1024 * 1024:
                    raise ConnectorError("文件超过此任务的大小上限。")
                sha = digest_stream(stream)
                if fingerprint(os.fstat(stream.fileno())) != earlier:
                    raise ConnectorError("文件正在写入，等待下次扫描。")
                records.append(
                    {
                        "relativePath": relative,
                        "size": before.st_size,
                        "mtime": before.st_mtime,
                        "sha256": sha,
                    }
                )
        except (OSError, ConnectorError) as exc:
            message = (
                str(exc)
                if isinstance(exc, ConnectorError)
                else "文件暂不可读，等待下次扫描。"
            )
            errors.append({"relativePath": relative, "error": message})
    return records, errors, truncated, candidates[-1][0] if candidates else cursor


def run_once(client, state, state_path):
    job = client.post("/poll", {})
    if not job.get("run"):
        return False
    task, run = job["task"], job["run"]
    root = Path(state["folder"]).expanduser().resolve(strict=True)
    if not root.is_dir() or str(root) != state["folder"]:
        raise ConnectorError("已授权文件夹不可用；不会改扫其他位置。")
    records, errors, truncated, cursor = manifest(
        root, task, state.get("scanCursor", "")
    )
    reply = client.post(
        f'/runs/{run["id"]}/manifest',
        {"files": records, "errors": errors, "truncated": truncated},
        run["lease"],
    )
    by_path = {r["relativePath"]: r for r in records}
    needed = reply.get("needFiles", [])
    if not isinstance(needed, list) or any(
        not isinstance(p, str) or p not in by_path for p in needed
    ):
        raise ConnectorError("服务器请求了本次授权清单之外的文件，已停止传输。")
    for position, relative in enumerate(needed, 1):
        try:
            client.upload(run["id"], run["lease"], root, by_path[relative])
            print(
                f"已传输 {position}/{len(needed)} 份；解析和问答索引将在服务器继续。",
                flush=True,
            )
        except ReconnectRequired:
            raise
        except (OSError, http.client.HTTPException, ConnectorError) as exc:
            message = (
                str(exc)
                if isinstance(exc, ConnectorError)
                else "文件传输未确认，保留结果供重试。"
            )
            errors.append({"relativePath": relative, "error": message})
    client.post(
        f'/runs/{run["id"]}/finish',
        {"errors": errors, "truncated": truncated},
        run["lease"],
    )
    state["scanCursor"] = cursor if truncated else ""
    save_state(state_path, state)
    print("本次扫描已提交，可在知识源中查看归档、解析和索引结果。", flush=True)
    return True


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="知识源文件夹连接程序（仅主动连接工作台）"
    )
    parser.add_argument("--server", help="工作台网址")
    parser.add_argument("--code", help="任务页面生成的一次性配对码")
    parser.add_argument("--folder", type=Path, help="授权扫描的本机目录")
    parser.add_argument(
        "--expected-folder-name", help="首次配对时核对网页中所选的文件夹名称"
    )
    parser.add_argument(
        "--config",
        "--state",
        type=Path,
        default=Path.home() / ".mberp/folder-connector.json",
    )
    parser.add_argument("--once", action="store_true", help="检查并处理一次后退出")
    parser.add_argument(
        "--interval",
        type=int,
        default=15,
        help="联系服务器的秒数；扫描时间仍由任务计划决定",
    )
    startup_group = parser.add_mutually_exclusive_group()
    startup_group.add_argument(
        "--install-startup",
        action="store_true",
        help="配对后设置当前用户登录时自动连接",
    )
    startup_group.add_argument(
        "--remove-startup", action="store_true", help="移除当前配置的登录启动项"
    )
    args = parser.parse_args(argv)
    try:
        if args.expected_folder_name is not None and not args.code:
            raise ConnectorError("核对所选文件夹需要使用首次连接命令。")
        if args.remove_startup:
            startup(args.config.expanduser(), remove=True)
            return 0
        if args.code:
            if not args.server or not args.folder:
                raise ConnectorError("首次配对需要 --server、--code 和 --folder。")
            root = args.folder.expanduser().resolve(strict=True)
            if not root.is_dir():
                raise ConnectorError("请选择已存在的本机文件夹。")
            if args.expected_folder_name is not None:
                actual, expected = root.name, args.expected_folder_name
                if sys.platform == "darwin":
                    # Finder and browser APIs can expose different Unicode forms.
                    actual = unicodedata.normalize("NFC", actual)
                    expected = unicodedata.normalize("NFC", expected)
                if not expected or actual != expected:
                    raise ConnectorError(
                        "当前目录与网页中所选的文件夹名称不一致。请在所选文件夹中打开终端或 PowerShell，再运行连接命令。"
                    )
            server = server_origin(args.server)
            response = Client(server).post(
                "/pair",
                {
                    "code": args.code,
                    "path": str(root),
                    "deviceName": socket.gethostname()[:100],
                },
            )
            if not isinstance(response.get("token"), str) or not response.get("taskId"):
                raise ConnectorError("服务器尚未确认配对。")
            state = {
                "server": server,
                "token": response["token"],
                "taskId": response["taskId"],
                "folder": str(root),
            }
            save_state(args.config, state)
            print(
                "文件夹已连接。运行期间按知识源中的计划扫描；按 Ctrl+C 停止连接。",
                flush=True,
            )
        else:
            state = load_state(args.config)
            if (
                args.folder
                and str(args.folder.expanduser().resolve(strict=True))
                != state["folder"]
            ):
                raise ConnectorError("更换扫描目录需要重新配对。")
            if args.server and server_origin(args.server) != state["server"]:
                raise ConnectorError("更换服务器需要重新配对。")
        client = Client(state["server"], state["token"])
        if args.install_startup:
            startup(args.config.expanduser())
            return 0
        with single_instance(args.config):
            while True:
                try:
                    run_once(client, state, args.config)
                except ReconnectRequired:
                    raise
                except (OSError, http.client.HTTPException, ConnectorError):
                    if args.once:
                        raise
                    print(
                        "连接或文件夹暂不可用，稍后重试；已保存资料保留。",
                        file=sys.stderr,
                        flush=True,
                    )
                if args.once:
                    return 0
                time.sleep(max(5, args.interval))
    except KeyboardInterrupt:
        print("连接已停止；服务器上已保存的文件继续处理。")
        return 0
    except (OSError, http.client.HTTPException, ConnectorError) as exc:
        print(
            str(exc)
            if isinstance(exc, ConnectorError)
            else "连接失败，请检查网络、目录和任务状态。",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    sys.exit(main())
