#!/usr/bin/env python3
"""User-owned daemon watchdog; no backup scheduling or privileged service operations."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import stat
import subprocess
import sys


def owned_private(path, directory=False):
    if not path.is_absolute() or '..' in path.parts or any(p.is_symlink() for p in (path, *path.parents)):
        raise ValueError('Unsafe path')
    info = path.stat()
    if info.st_uid != os.getuid() or info.st_mode & 0o077 or not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)):
        raise ValueError('Private owned path required')


def launch(config):
    owned_private(config)
    value = json.loads(config.read_text())
    state = Path(value['stateDirectory'])
    owned_private(state, directory=True)
    script = Path(__file__).with_name('catalogue_agent.py').resolve()
    lock = os.open(state / '.launcher.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        if not stat.S_ISREG(os.fstat(lock).st_mode):
            raise ValueError('Invalid lock')
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return False
        log = state / 'agent.log'
        if log.exists():
            owned_private(log)
            if log.stat().st_size > 1024 * 1024:
                log.replace(state / 'agent.previous.log')
        output = os.open(log, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            subprocess.Popen([sys.executable, str(script), '--config', str(config)],
                             cwd=script.parent, stdin=subprocess.DEVNULL, stdout=output,
                             stderr=output, start_new_session=True, pass_fds=(lock,))
        finally:
            os.close(output)
        return True
    finally:
        os.close(lock)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    try:
        launch(args.config)
    except Exception:
        print('Backup catalogue watchdog failed; check private configuration.', file=sys.stderr)
        raise SystemExit(1)
