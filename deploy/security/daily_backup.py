#!/usr/bin/env python3
"""Server-only daily encrypted backup and conservative, nonrecursive retention."""

import argparse
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

BACKUP = Path(__file__).resolve().with_name("backup.py")
NAME = re.compile(r"maibo-(\d{8}T\d{6}Z)\.tar\.gz\.gpg\Z")
UTC = dt.timezone.utc


def inventory(directory_fd):
    """Only nonempty regular files directly inside the pinned directory count."""
    found = {}
    for name in os.listdir(directory_fd):
        match = NAME.fullmatch(name)
        if not match:
            continue
        try:
            stamp = dt.datetime.strptime(match[1], "%Y%m%dT%H%M%SZ").replace(tzinfo=UTC)
            info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        except (ValueError, FileNotFoundError):
            continue
        if stat.S_ISREG(info.st_mode) and info.st_size > 0:
            found[name] = (stamp, info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)
    return found


def prune(directory_fd, now):
    """Keep newest 14 AND at least 14 days; recent mtime also protects copies."""
    items = inventory(directory_fd)
    newest = set(sorted(items, key=lambda name: items[name][0], reverse=True)[:14])
    cutoff = now - dt.timedelta(days=14)
    removed = 0
    for name, original in items.items():
        if name in newest or original[0] >= cutoff or original[4] / 1e9 >= cutoff.timestamp():
            continue
        current = inventory_entry(directory_fd, name)
        if current != original[1:]:
            continue
        # unlink removes only this directory entry, never a symlink's target.
        os.unlink(name, dir_fd=directory_fd)
        removed += 1
    return removed


def inventory_entry(directory_fd, name):
    try:
        info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(info.st_mode):
        return None
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)


def execute(directory, key, now=None):
    os.umask(0o077)
    directory = Path(os.path.abspath(directory))
    # Do not accept a symlink directory or symlink ancestors for retention.
    if any(path.is_symlink() for path in (directory, *directory.parents)):
        raise ValueError("Unsafe backup directory")
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    lock_fd = None
    try:
        info = os.fstat(directory_fd)
        if info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise ValueError("Backup directory must be private and owned by the caller")
        lock_fd = os.open(".daily-backup.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW,
                          0o600, dir_fd=directory_fd)
        if not stat.S_ISREG(os.fstat(lock_fd).st_mode):
            raise ValueError("Unsafe lock")
        try:
            # Separate from backup.py's own .backup.lock, avoiding nested deadlock.
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {"status": "skipped_overlap", "removed": 0}
        before = inventory(directory_fd)
        command = [sys.executable, str(BACKUP), "--directory", str(directory), "--key", str(key)]
        subprocess.run(command + ["--quiesce"], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        after = inventory(directory_fd)
        created = set(after) - set(before)
        if len(created) != 1:
            raise ValueError("Expected exactly one new backup")
        name = created.pop()
        subprocess.run(command + ["--verify", str(directory / name)], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if inventory_entry(directory_fd, name) != after[name][1:]:
            raise ValueError("Backup changed during verification")
        current = directory.stat(follow_symlinks=False)
        if (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino):
            raise ValueError("Backup directory changed")
        removed = prune(directory_fd, now or dt.datetime.now(UTC))
        return {"status": "verified", "backup": name, "removed": removed}
    finally:
        if lock_fd is not None:
            os.close(lock_fd)
        os.close(directory_fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, required=True,
                        help="Dedicated private directory for this scheduler only")
    parser.add_argument("--key", type=Path, required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(execute(args.directory, args.key)))
    except Exception:
        # Child errors may contain environment values or paths; never print them.
        print(json.dumps({"status": "failed", "retention": "not_completed"}))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
