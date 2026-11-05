"""Production static hosting must not shadow the backup API."""
import os
from pathlib import Path
import subprocess
import sys


def test_backup_api_precedes_spa_fallback(tmp_path):
    (tmp_path / 'index.html').write_text('<html>isolated-static-test</html>')
    environment = {**os.environ, 'STATIC_DIR': str(tmp_path), 'AUTO_SEED': 'false',
                   'AUTO_MIGRATE_SCHEMA': 'false', 'DATABASE_URL': 'sqlite:///:memory:',
                   'APP_SECRET': 'synthetic-spa-test-secret-01234567890',
                   'CASDOOR_CLIENT_SECRET': 'synthetic-client-secret'}
    script = '''from fastapi.testclient import TestClient
from app.main import app
client = TestClient(app)
page = client.get('/data-backup')
assert page.status_code == 200 and 'isolated-static-test' in page.text
api = client.get('/api/v1/data-backup/snapshot')
assert api.status_code == 401, api.status_code
assert api.headers.get('Cache-Control') == 'no-store'
'''
    result = subprocess.run([sys.executable, '-c', script], cwd=Path(__file__).resolve().parents[1],
                            env=environment, capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr[-1500:]
