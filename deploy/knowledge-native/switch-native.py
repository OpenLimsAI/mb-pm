"""Switch only the newly added KB gateway to the native BFF; preserve the live legacy site."""
import datetime
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.request

os.umask(0o077)
tag = sys.argv[1]
assert re.fullmatch(r'kb-native-\d{8}T\d{6}Z', tag)
root = Path('/home/prometheus/mb-kb')
release = root / 'releases' / tag
summary = json.loads((release / 'build-summary.json').read_text())
assert subprocess.check_output(['docker', 'image', 'inspect', summary['image'], '--format', '{{.Id}}'], text=True).strip() == summary['image_id']
names = subprocess.check_output(['docker', 'ps', '-a', '--format', '{{.Names}}'], text=True).splitlines()
before = json.loads(subprocess.check_output(['docker', 'inspect', *names], text=True))
native = next(d for d in before if d['Name'] == '/' + summary['native_web_name'])
assert native['State']['Running'] and native['Image'] == summary['base_image_id']
assert native['Id'] == summary['native_web_container_id']
assert native['State']['Health']['Status'] == 'healthy'
gateway = next(d for d in before if d['Name'] == '/mb-kb-kb-gateway-1')
assert gateway['Config']['Image'] == 'mb-kb:kb-iam-20261003T012525Z'
core = next(d for d in before if d['Name'] == '/' + summary['native_core_name'])
assert core['State']['Running'] and core['State']['Health']['Status'] == 'healthy'
assert core['Id'] == summary['native_core_container_id']
env_values = lambda d: dict(s.split('=', 1) for s in d['Config']['Env'])
native_env = env_values(native)
assert native_env['DIKW_CORE_URL'] == summary['core_url']
assert native_env['DIKW_SERVER_TOKEN'] == env_values(core)['DIKW_SERVER_TOKEN']
agent_mount = next(m for m in native['Mounts'] if m['Destination'] == '/data/agent-sessions')
assert agent_mount['Type'] == 'volume' and agent_mount['Name'] == 'dikw_v06_agent_sessions'
config = json.loads((root / 'config.private.json').read_text())
assert config['public_url'] == 'https://kb.openlims.ai' and config['organization'] == 'mabpharm'
private = root / 'private-config-backups' / tag
private.mkdir(mode=0o700)
(private / 'containers-before.json').write_text(json.dumps(before))
original_env = (root / '.env').read_bytes()
original_compose = (root / 'compose.yml').read_bytes()
(private / 'app.env').write_bytes(original_env)
(private / 'compose.yml').write_bytes(original_compose)
iam_db = next(d for d in before if d['Name'] == '/mb-pm-v2-iam-db-1')
db_env = env_values(iam_db)

def sql(query):
    return subprocess.check_output(['docker', 'exec', '-i', 'mb-pm-v2-iam-db-1', 'psql', '-U', db_env['POSTGRES_USER'], '-d', db_env['POSTGRES_DB'], '-At', '-v', 'ON_ERROR_STOP=1'], input=query, text=True).strip()

def literal(value):
    return "'" + value.replace("'", "''") + "'"

where = "owner='admin' and name='mb-kb' and client_id=" + literal(config['client_id'])
application = json.loads(sql("select row_to_json(t) from (select owner,name,organization,homepage_url,redirect_uris from application where " + where + ") t;"))
assert application['organization'] == 'mabpharm'
(private / 'iam-application.json').write_text(json.dumps(application))
native_env.update({
    'DIKW_WEB_PUBLIC_URL': config['public_url'],
    'DIKW_WEB_HOST': '0.0.0.0',
    'DIKW_WEB_PORT': '8000',
    'DIKW_WEB_OIDC_CLIENT_ID': config['client_id'],
    'DIKW_WEB_OIDC_CLIENT_SECRET': config['client_secret'],
    'DIKW_WEB_SESSION_SECRET': config['session_secret'],
    'DIKW_WEB_DEFAULT_VIEWER_OWNER': 'mabpharm',
    'DIKW_WEB_SESSION_TTL_SECONDS': '3600',
})
assert all('\n' not in v and '\r' not in v for v in native_env.values())
(root / 'native.runtime.private.env').write_text('\n'.join(k + '=' + v for k, v in native_env.items()) + '\n')
(root / 'native.runtime.private.env').chmod(0o600)
compose = '''services:
  kb-gateway:
    image: ${KB_IMAGE:?Set a tested native release}
    restart: unless-stopped
    read_only: true
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    ports: ["127.0.0.1:18083:8000"]
    env_file:
      - path: /home/prometheus/mb-kb/native.runtime.private.env
        format: raw
    volumes:
      - native-agent-sessions:/data/agent-sessions
      - /home/prometheus/dikw/web/config.json:/app/dist/config.json:ro
    tmpfs: [/tmp]
    networks:
      pm:
        aliases: [kb-gateway]
      knowledge: {}
    healthcheck:
      test: [CMD, node, -e, "fetch('http://127.0.0.1:8000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 20s
      timeout: 6s
      retries: 3
networks:
  pm:
    external: true
    name: mb-pm-v2_internal
  knowledge:
    external: true
    name: dikw_dikw_net
volumes:
  native-agent-sessions:
    external: true
    name: dikw_v06_agent_sessions
'''
(release / 'compose.native.yml').write_text(compose)
# Validate raw env-file support without printing resolved secrets.
subprocess.run(['docker', 'compose', '-p', 'mb-kb', '--env-file', str(root / '.env'), '-f', str(release / 'compose.native.yml'), 'config', '--quiet'], cwd=root, check=True)

def write_env(value):
    updated, count = re.subn(rb'(?m)^KB_IMAGE=[^\r\n]*', b'KB_IMAGE=' + value.encode(), original_env)
    assert count == 1
    (root / '.env').write_bytes(updated)

def up():
    subprocess.run(['docker', 'compose', '-p', 'mb-kb', '--env-file', '.env', '-f', 'compose.yml', 'up', '-d', '--no-deps', 'kb-gateway'], cwd=root, check=True)

def healthy():
    for _ in range(60):
        current = json.loads(subprocess.check_output(['docker', 'inspect', 'mb-kb-kb-gateway-1'], text=True))[0]
        if current['State'].get('Health', {}).get('Status') == 'healthy': return current
        time.sleep(2)
    raise RuntimeError('New KB gateway did not become healthy')

redirects = json.dumps(['https://kb.openlims.ai/web/auth/callback', 'https://kb.openlims.ai/'])
try:
    assert sql('update application set homepage_url=' + literal(config['public_url']) + ',redirect_uris=' + literal(redirects) + ' where ' + where + ' returning name;').splitlines()[0] == 'mb-kb'
    (root / 'compose.yml').write_text(compose)
    write_env(summary['image'])
    up()
    deployed = healthy()
    assert deployed['Image'] == summary['image_id']
    for old in before:
        if old['Name'] == '/mb-kb-kb-gateway-1': continue
        current = json.loads(subprocess.check_output(['docker', 'inspect', old['Name']], text=True))[0]
        assert current['Id'] == old['Id'] and current['State']['Running'] == old['State']['Running'], old['Name'] + ' changed during release'
    assert urllib.request.urlopen('http://127.0.0.1:18083/healthz', timeout=10).status == 200
except Exception:
    (root / '.env').write_bytes(original_env)
    (root / 'compose.yml').write_bytes(original_compose)
    sql('update application set homepage_url=' + literal(application['homepage_url']) + ',redirect_uris=' + literal(application['redirect_uris']) + ' where ' + where + ';')
    up()
    healthy()
    print('Native switch failed; gateway and IAM callback restored.', flush=True)
    raise
result = {'tag': tag, 'deployed_at_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'image': summary['image'], 'image_id': deployed['Image'], 'gateway_id': deployed['Id'], 'health': 'healthy', 'public_url': config['public_url'], 'native_versions': {'web': '0.10.0', 'core': '0.6.8'}, 'previous_gateway_image': gateway['Config']['Image'], 'data_dir': summary['data_dir'], 'agent_volume': agent_mount['Name'], 'other_containers_unchanged': True, 'default_reading_organization': 'mabpharm', 'editor_role': 'kb_editor', 'account_recheck_seconds': 60, 'session_ttl_seconds': 3600, 'callback': 'https://kb.openlims.ai/web/auth/callback'}
(release / 'deployment-result.json').write_text(json.dumps(result, indent=2) + '\n')
print('NATIVE_DEPLOYMENT_COMPLETE ' + json.dumps(result), flush=True)
