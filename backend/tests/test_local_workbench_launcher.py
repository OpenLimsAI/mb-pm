"""Reject local configurations that could inherit a non-executing web role."""

import os
import subprocess
import sys
from pathlib import Path

import pytest


@pytest.mark.parametrize("configured_role", [None, "", "web", "worker"])
def test_local_launcher_requires_explicit_combined_role(tmp_path, configured_role):
    config = tmp_path / "local.env"
    lines = ["APP_ENV=development", "PMS_PUBLIC_URL=http://localhost:1234"]
    if configured_role is not None:
        lines.append(f"APP_PROCESS_ROLE={configured_role}")
    config.write_text("\n".join(lines) + "\n")
    script = Path(__file__).resolve().parents[2] / "scripts/run-local-workbench.py"
    result = subprocess.run(
        [sys.executable, str(script), "--config", str(config)],
        env={**os.environ, "APP_PROCESS_ROLE": "web"},
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    assert result.returncode != 0
    assert "本地单进程工作台需要 APP_PROCESS_ROLE=combined。" in result.stderr
    assert "Started server process" not in result.stderr
