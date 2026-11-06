"""Read-only backup health summaries from trusted catalogue metadata.

No paths, filenames, commands or diagnostics are included in public alerts.
The thresholds match deploy/security/monitor.py: 36 hours, 10 GiB and 85%.
"""

import datetime as dt
import math
from collections.abc import Mapping

UTC = dt.timezone.utc
MAX_AGE_SECONDS = 36 * 60 * 60
MIN_FREE_BYTES = 10 * 1024**3
MAX_USED_RATIO = 0.85


def _created_at(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        # A browser or host local timezone must never be guessed for old records.
        if parsed.tzinfo is None or parsed.utcoffset() is None:
            return None
        return parsed.timestamp()
    except (ValueError, OverflowError, OSError):
        return None


def backup_alerts(plan, items, usage, now=None):
    """Return fixed Chinese alerts; never trigger backup or inspect the filesystem.

    ``items`` is the catalogue's id-to-item mapping, or its values iterable.
    Each complete verified item carries the private ``_full: True`` flag and a
    timezone-aware ISO ``createdAt``. ``_gpg`` identifies complete-archive
    candidates whose verification may have failed. ``usage`` is the result of
    ``shutil.disk_usage``. ``now`` may be an aware datetime or Unix timestamp.
    A recent re-verification of an old archive does not refresh its backup age.
    """
    if now is None:
        current = dt.datetime.now(UTC).timestamp()
    elif isinstance(now, dt.datetime):
        if now.tzinfo is None or now.utcoffset() is None:
            raise ValueError("An explicit timezone is required")
        current = now.timestamp()
    elif type(now) in (int, float) and math.isfinite(now):
        current = float(now)
    else:
        raise ValueError("A finite timestamp is required")

    alerts = []
    status = plan.get("status") if isinstance(plan, Mapping) else None
    if status == "disabled":
        alerts.append("每日自动备份计划未启用，请检查服务器备份计划。")
    elif status == "conflict":
        alerts.append("每日自动备份计划存在冲突，请先核对服务器配置。")
    elif status != "active":
        alerts.append("暂时无法确认每日自动备份计划或执行时区，请检查服务器配置。")

    archives = list(items.values() if isinstance(items, Mapping) else items)
    complete = [item for item in archives if item.get("status") == "verified" and item.get("_full") is True]
    if not complete:
        alerts.append("尚未找到已核验的完整恢复副本，请检查备份和核验记录。")
    else:
        times = [_created_at(item.get("createdAt")) for item in complete]
        valid = [value for value in times if value is not None and value <= current]
        if any(value is not None and value > current for value in times):
            alerts.append("完整备份的创建时间晚于服务器当前时间，请核对备份记录和服务器时钟。")
        if not valid:
            alerts.append("已核验的完整备份缺少可信的创建时间，暂时无法判断每日备份是否按时完成。")
        elif current - max(valid) > MAX_AGE_SECONDS:
            alerts.append("最近已核验的完整备份已超过 36 小时，请检查每日备份是否成功执行。")

    if any(item.get("_gpg") is True and item.get("status") == "unreadable" for item in archives):
        alerts.append("存在无法读取或未通过完整性核验的完整备份归档，请检查服务器备份记录。")

    total, used, free = (getattr(usage, key, None) for key in ("total", "used", "free"))
    valid_usage = all(type(value) is int and value >= 0 for value in (total, used, free))
    if not valid_usage or total <= 0 or used > total or free > total:
        alerts.append("暂时无法确认备份磁盘余量，请检查服务器磁盘状态。")
    elif free < MIN_FREE_BYTES or used / total >= MAX_USED_RATIO:
        alerts.append("备份磁盘空间不足：剩余空间低于 10 GiB 或磁盘使用率达到 85%，请及时处理。")
    return alerts
