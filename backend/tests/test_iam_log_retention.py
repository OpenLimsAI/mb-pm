import importlib.util
import json
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location(
    "iam_log_retention",
    Path(__file__).resolve().parents[2] / "deploy/parallel-test/configure_iam_log_retention.py",
)
retention = importlib.util.module_from_spec(spec)
spec.loader.exec_module(retention)


def test_retention_preserves_credentials_and_unrelated_log_options():
    before = 'dataSourceName = "synthetic-private-database"\nlogConfig = {"adapter":"file","filename":"logs/casdoor.log","maxdays":99999,"perm":"0770","level":4}\norigin = "https://iam.example.test"\n'
    after = retention.update_log_config(before)
    assert after.splitlines()[0] == before.splitlines()[0]
    assert after.splitlines()[2:] == before.splitlines()[2:]
    settings = json.loads(after.splitlines()[1].split("=", 1)[1])
    assert settings == {"adapter": "file", "filename": "logs/casdoor.log", "maxdays": 14,
                        "maxsize": 10485760, "daily": True, "rotate": True, "perm": "0770", "level": 4}


@pytest.mark.parametrize("text", ["# logConfig = {}", "logConfig = {}\nlogConfig = {}\n",
    'logConfig = {"adapter":"console","filename":"logs/casdoor.log"}',
    'logConfig = {"adapter":"file","filename":"other.log"}'])
def test_unexpected_sink_requires_review(text):
    with pytest.raises(ValueError):
        retention.update_log_config(text)
