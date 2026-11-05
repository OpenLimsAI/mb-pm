"""Synthetic lifecycle test: restart is idempotent without touching backup schedules."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'launch.py'
spec = importlib.util.spec_from_file_location('catalogue_launch_test', SOURCE)
launch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launch)


class WatchdogTest(unittest.TestCase):
    def test_live_child_holds_launcher_lock_and_restart_after_exit(self):
        previous = os.umask(0o077)
        try:
            with tempfile.TemporaryDirectory() as name:
                root = Path(name).resolve()
                state = root / 'state'; state.mkdir(mode=0o700)
                config = root / 'config.json'; config.write_text(json.dumps({'stateDirectory':str(state)}))
                script = root / 'catalogue_agent.py'
                script.write_text('import time\ntime.sleep(1)\n')
                with patch.object(launch, '__file__', str(root / 'launch.py')):
                    self.assertTrue(launch.launch(config))
                    self.assertFalse(launch.launch(config))
                    time.sleep(1.2)
                    self.assertTrue(launch.launch(config))
                    time.sleep(1.2)
        finally:
            os.umask(previous)

    def test_public_config_is_rejected(self):
        with tempfile.TemporaryDirectory() as name:
            path = Path(name).resolve() / 'config.json'
            path.write_text('{}'); path.chmod(0o644)
            with self.assertRaises(ValueError): launch.launch(path)

if __name__ == '__main__': unittest.main()
