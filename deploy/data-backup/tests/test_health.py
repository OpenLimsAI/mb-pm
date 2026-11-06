"""Synthetic metadata only; health checks perform no host or backup operations."""

import datetime as dt
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest

SPEC = importlib.util.spec_from_file_location("backup_health", Path(__file__).parents[1] / "health.py")
health = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(health)

NOW = dt.datetime(2026, 11, 6, 12, tzinfo=dt.timezone.utc)
GIB = 1024**3
DISK = SimpleNamespace(total=100 * GIB, used=50 * GIB, free=50 * GIB)


def archive(age=1, **changes):
    item = {
        "status": "verified",
        "_full": True,
        "_gpg": True,
        "createdAt": (NOW - dt.timedelta(hours=age)).isoformat(),
        "verifiedAt": NOW.isoformat(),
    }
    item.update(changes)
    return item


def alerts(items=None, plan=None, usage=DISK, now=NOW):
    return health.backup_alerts(
        {"status": "active"} if plan is None else plan,
        [archive()] if items is None else items,
        usage,
        now=now,
    )


class HealthTests(unittest.TestCase):
    def test_fresh_complete_backup_and_active_plan_have_no_alerts(self):
        self.assertEqual([], alerts())
        self.assertEqual([], alerts({"opaque-id": archive()}))
        self.assertEqual([], alerts(now=NOW.timestamp()))

    def test_each_unconfirmed_plan_gets_a_fixed_safe_message(self):
        for state, expected in (("disabled", "未启用"), ("conflict", "冲突"), ("unknown", "无法确认"), (None, "无法确认")):
            with self.subTest(state=state):
                result = alerts(plan={"status": state, "summary": "/private/key SECRET"})
                self.assertEqual(1, len(result))
                self.assertIn(expected, result[0])
                self.assertNotIn("SECRET", result[0])
                self.assertNotIn("/private", result[0])

    def test_complete_verified_archive_is_required(self):
        for items in ([], [archive(_full=False)], [archive(_full=None)], [archive(status="pending")], [archive(status="unreadable")]):
            with self.subTest(items=items):
                self.assertTrue(any("尚未找到已核验的完整恢复副本" in value for value in alerts(items)))

    def test_backup_age_boundary_and_latest_complete_copy(self):
        self.assertEqual([], alerts([archive(age=36)]))
        self.assertTrue(any("超过 36 小时" in value for value in alerts([archive(age=36 + 1 / 3600)])))
        self.assertEqual([], alerts([archive(age=80), archive(age=1)]))
        # A fresh partial archive and a fresh validation timestamp do not hide stale backup data.
        self.assertTrue(any("超过 36 小时" in value for value in alerts([archive(age=80), archive(age=1, _full=False)])))

    def test_missing_invalid_and_naive_creation_time_cannot_report_healthy(self):
        for value in (None, "", "not-a-date", "2026-11-06T11:00:00", 123):
            with self.subTest(value=value):
                result = alerts([archive(createdAt=value)])
                self.assertTrue(any("缺少可信的创建时间" in message for message in result))
        self.assertEqual([], alerts([archive(createdAt=None), archive(age=1)]))

    def test_aware_offsets_and_utc_z_are_supported(self):
        self.assertEqual([], alerts([archive(createdAt="2026-11-06T19:00:00+08:00")]))
        self.assertEqual([], alerts([archive(createdAt="2026-11-06T11:00:00Z")]))

    def test_future_records_do_not_hide_stale_or_missing_history(self):
        result = alerts([archive(age=-1)])
        self.assertTrue(any("晚于服务器当前时间" in message for message in result))
        self.assertTrue(any("缺少可信的创建时间" in message for message in result))
        result = alerts([archive(age=-1), archive(age=80)])
        self.assertTrue(any("超过 36 小时" in message for message in result))

    def test_unreadable_full_candidate_alert_is_not_used_for_partial_unknown_files(self):
        self.assertEqual([], alerts([archive(), archive(_gpg=False, status="unreadable", _full=False)]))
        result = alerts([archive(), archive(status="unreadable", _full=False, name="secret-name", error="secret-diagnostic")])
        self.assertEqual(1, len(result))
        self.assertIn("无法读取", result[0])
        self.assertNotIn("secret", result[0])

    def test_disk_thresholds_use_both_available_space_and_usage_ratio(self):
        self.assertEqual([], alerts(usage=SimpleNamespace(total=20 * GIB, used=10 * GIB, free=10 * GIB)))
        for usage in (
            SimpleNamespace(total=20 * GIB, used=10 * GIB + 1, free=10 * GIB - 1),
            SimpleNamespace(total=100 * GIB, used=85 * GIB, free=15 * GIB),
        ):
            with self.subTest(usage=usage):
                result = alerts(usage=usage)
                self.assertEqual(1, len(result))
                self.assertIn("磁盘空间不足", result[0])
        self.assertEqual([], alerts(usage=SimpleNamespace(total=100 * GIB, used=85 * GIB - 1, free=15 * GIB + 1)))

    def test_invalid_disk_metadata_remains_unconfirmed(self):
        for usage in (None, SimpleNamespace(total=0, used=0, free=0), SimpleNamespace(total=100, used=101, free=0), SimpleNamespace(total=100, used=0, free=-1)):
            with self.subTest(usage=usage):
                self.assertTrue(any("无法确认备份磁盘余量" in message for message in alerts(usage=usage)))

    def test_injected_now_requires_finite_aware_time(self):
        for now in (float("nan"), float("inf"), True, NOW.replace(tzinfo=None), "2026-11-06"):
            with self.subTest(now=now), self.assertRaises(ValueError):
                alerts(now=now)

    def test_checks_do_not_mutate_input(self):
        item = archive(age=80)
        before = dict(item)
        plan = {"status": "active"}
        alerts({"opaque": item}, plan=plan)
        self.assertEqual(before, item)
        self.assertEqual({"status": "active"}, plan)


if __name__ == "__main__":
    unittest.main()
