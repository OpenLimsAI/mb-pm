"""Publish a verified, MB library image with persisted Chinese translations on the customer server.

Run prepare before switch. Secrets stay in protected server backups; only the
named MB library service is recreated. Requires an existing release/manifest.
"""

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

os.umask(0o077)
ROOT = Path('/home/prometheus/dikw')
NAME = 'dikw-mbweb'
MODE, TAG = sys.argv[1:3]
assert MODE in {'prepare', 'switch'}
assert re.fullmatch(r'translation-\d{8}T\d{6}Z', TAG)
RELEASE = ROOT / 'translation-releases' / TAG
BACKUP = ROOT / 'translation-backups' / TAG
IMAGE = 'dikw-mbweb:' + TAG
MANIFEST = json.loads((RELEASE / 'manifest.json').read_text())


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def inspect(name):
    return json.loads(run('docker', 'inspect', name))[0]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def containers():
    ids = run('docker', 'ps', '-q').split()
    return {c['Name'].lstrip('/'): c['Id'] for c in json.loads(run('docker', 'inspect', *ids))}


def server_digest(name):
    return run('docker', 'exec', name, 'sha256sum', '/app/dist-server/standalone.mjs').split()[0]


def record(name, data):
    (RELEASE / name).write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


opener = urllib.request.build_opener(NoRedirect())


def request(port, path):
    req = urllib.request.Request(f'http://127.0.0.1:{port}{path}', headers={'Host': 'kb.openlims.ai'})
    try:
        response = opener.open(req, timeout=5)
    except urllib.error.HTTPError as error:
        response = error
    # Do not print Cookie or authorization redirect values.
    with response:
        return response.code, response.headers, response.read()


def verify(port, name):
    for _ in range(30):
        try:
            if request(port, '/healthz')[0] == 200:
                break
        except (OSError, urllib.error.URLError):
            pass
        time.sleep(1)
    else:
        raise RuntimeError('MB library health did not become ready')
    results = ['healthz 200']
    assert request(port, '/v1/base/pages')[0] == 401
    results.append('anonymous papers denied (401)')
    status, headers, _ = request(port, '/web/auth/login')
    assert status in {302, 303}
    redirect = urllib.parse.urlsplit(headers['Location'])
    params = urllib.parse.parse_qs(redirect.query)
    assert redirect.scheme == 'https' and redirect.netloc == 'iam.openlims.ai'
    assert params['client_id'] == ['dikw-4b017ecb75a7ae01']
    assert params['redirect_uri'] == ['https://kb.openlims.ai/web/auth/callback']
    assert params['code_challenge_method'] == ['S256']
    results.append('original IAM client, callback and PKCE retained')
    for path, expected in MANIFEST['public_files'].items():
        # The existing BFF also protects static assets. Validate that policy,
        # then compare container files instead of weakening authentication.
        assert request(port, '/' + path)[0] == 401
        actual = run('docker', 'exec', name, 'sha256sum', '/app/dist/' + path).split()[0]
        assert actual == expected, f'Asset mismatch: {path}'
    results.append('static assets remain protected; CSS, JS and logo match manifest')
    assert server_digest(name) == MANIFEST['backend_sha256']
    results.append('updated BFF bundle matches manifest')
    assert request(port, '/web/papers/translation?path=sources/fixture.md')[0] == 401
    results.append('persistent translation endpoint remains authenticated (401)')
    assert request(port, '/v1/synth')[0] == 403
    results.append('administration synthesis remains forbidden (403)')
    schema = run('docker', 'exec', name, 'node', '--input-type=module', '-e',
                 "import {DatabaseSync} from 'node:sqlite'; import {statSync} from 'node:fs'; const path='/data/mbweb/translations.sqlite'; const db=new DatabaseSync(path,{readOnly:true}); const table=db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name='paper_translations'\").get(); if(!table || (statSync(path).mode & 0o777)!==0o600) process.exit(1); if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok') process.exit(1); db.close(); process.stdout.write('ok');")
    assert schema == 'ok'
    results.append('persistent SQLite schema, permissions and integrity verified')
    return results


for path, expected in MANIFEST['files'].items():
    assert digest(RELEASE / path) == expected, f'Build input mismatch: {path}'

if MODE == 'prepare':
    assert not BACKUP.exists(), 'Backup already exists; use a new release tag'
    current = inspect(NAME)
    assert current['Config']['Image'] == MANIFEST['base_image']
    assert current['Image'] == MANIFEST['base_image_id']
    assert server_digest(NAME) == MANIFEST['previous_backend_sha256']
    assert run('docker', 'exec', NAME, 'sha256sum', '/app/package.json').split()[0] == MANIFEST['package_sha256']
    BACKUP.mkdir(parents=True)
    for filename in ['.env', 'docker-compose.yml']:
        (BACKUP / filename).write_bytes((ROOT / filename).read_bytes())
    (BACKUP / 'container.private.json').write_text(json.dumps(current))
    env = current['Config']['Env']
    assert all('\n' not in line for line in env)
    env_file = BACKUP / 'candidate.private.env'
    env_file.write_text('\n'.join(env) + '\n')
    # Online SQLite backups of existing runtime databases; no customer Core writes.
    database_backup = '/tmp/mbweb-db-backup-' + TAG
    script = """import {DatabaseSync,backup} from 'node:sqlite'; import {mkdir,readdir,rm} from 'node:fs/promises'; import {join} from 'node:path'; const directory=process.argv[1]; await mkdir(directory,{mode:0o700}); const names=(await readdir('/data/mbweb')).filter(name=>name.endsWith('.sqlite')); for(const name of names){const db=new DatabaseSync(join('/data/mbweb',name),{readOnly:true}); try{await backup(db,join(directory,name));}finally{db.close();}} process.stdout.write(JSON.stringify(names));"""
    names = json.loads(run('docker', 'exec', NAME, 'node', '--input-type=module', '-e', script, database_backup))
    try:
        (BACKUP / 'runtime-databases').mkdir()
        run('docker', 'cp', NAME + ':' + database_backup + '/.', str(BACKUP / 'runtime-databases'))
        for path in (BACKUP / 'runtime-databases').iterdir():
            path.chmod(0o600)
    finally:
        run('docker', 'exec', NAME, 'node', '--input-type=module', '-e', "import {rm} from 'node:fs/promises'; await rm(process.argv[1],{recursive:true,force:true});", database_backup)
    record('database-backup.json', {'online_sqlite_backups': names, 'location': str(BACKUP / 'runtime-databases')})
    before = containers()
    record('baseline.json', {
        'container_id': current['Id'], 'other_containers': {k: v for k, v in before.items() if k != NAME},
        'previous_image': current['Config']['Image'], 'env_sha256': digest(ROOT / '.env'),
        'compose_sha256': digest(ROOT / 'docker-compose.yml'),
    })
    base_tag = 'dikw-mbweb-translation-base:' + TAG
    run('docker', 'tag', current['Image'], base_tag)
    (RELEASE / 'Dockerfile.translation').write_text(
        f'FROM {base_tag}\nUSER root\nRUN rm -rf /app/dist\n'
        'COPY --chown=node:node dist/ /app/dist/\n'
        'RUN rm -rf /app/dist-server\nCOPY --chown=node:node dist-server/ /app/dist-server/\nUSER node\n'
        f'LABEL ai.openlims.translation.release="{TAG}"\n'
    )
    # The source snapshot's normal .dockerignore excludes build outputs.
    # Restrict this derived-image build to the two verified artifact directories.
    (RELEASE / 'Dockerfile.translation.dockerignore').write_text(
        '**\n!dist/\n!dist/**\n!dist-server/\n!dist-server/**\n'
    )
    subprocess.run(['docker', 'build', '--progress=plain', '-f', str(RELEASE / 'Dockerfile.translation'), '-t', IMAGE, str(RELEASE)], check=True)
    candidate = NAME + '-translation-verify-' + TAG
    networks = list(current['NetworkSettings']['Networks'])
    network = next(n for n in networks if 'internal' in n)
    args = ['docker', 'run', '-d', '--name', candidate, '--network', network,
            '--env-file', str(env_file), '-p', '127.0.0.1::4321']
    for mount in current['Mounts']:
        if mount['Destination'] == '/etc/iam-proxy-ca.crt':
            args += ['--mount', f'type=bind,source={mount["Source"]},target={mount["Destination"]},readonly']
    args.append(IMAGE)
    candidate_id = run(*args)
    try:
        for n in networks:
            if n != network:
                run('docker', 'network', 'connect', n, candidate)
        port = inspect(candidate)['NetworkSettings']['Ports']['4321/tcp'][0]['HostPort']
        checks = verify(port, candidate)
        assert inspect(NAME)['Id'] == current['Id']
        assert {k: v for k, v in containers().items() if k != candidate} == before
        record('candidate-validation.json', {'passed': True, 'checks': checks,
               'image': IMAGE, 'image_id': json.loads(run('docker', 'image', 'inspect', IMAGE))[0]['Id']})
        print('CANDIDATE VERIFIED:', json.dumps(checks), flush=True)
    finally:
        if inspect(candidate)['Id'] == candidate_id:
            run('docker', 'rm', '-f', '-v', candidate)

if MODE == 'switch':
    validation = json.loads((RELEASE / 'candidate-validation.json').read_text())
    assert validation['passed'] and validation['image'] == IMAGE
    assert json.loads(run('docker', 'image', 'inspect', IMAGE))[0]['Id'] == validation['image_id']
    baseline = json.loads((RELEASE / 'baseline.json').read_text())
    previous = inspect(NAME)
    assert previous['Id'] == baseline['container_id'], 'Production changed; prepare a fresh candidate'
    assert digest(ROOT / '.env') == baseline['env_sha256'], 'Runtime environment changed'
    assert digest(ROOT / 'docker-compose.yml') == baseline['compose_sha256'], 'Compose changed'
    assert {k: v for k, v in containers().items() if k != NAME} == baseline['other_containers']
    original = (ROOT / '.env').read_text()
    assert re.findall(r'^MBWEB_VERSION=(.*)$', original, re.M) == [MANIFEST['base_image'].split(':', 1)[1]]
    updated = re.sub(r'^MBWEB_VERSION=.*$', 'MBWEB_VERSION=' + TAG, original, flags=re.M)
    compose = ['docker', 'compose', '-f', str(ROOT / 'docker-compose.yml'), 'up', '-d', '--no-deps', NAME]
    try:
        (ROOT / '.env').write_text(updated)
        subprocess.run(compose, cwd=ROOT, check=True)
        checks = verify(18080, NAME)
        for _ in range(60):
            if inspect(NAME)['State'].get('Health', {}).get('Status') == 'healthy':
                break
            time.sleep(1)
        else:
            raise RuntimeError('Docker health did not become healthy')
        assert {k: v for k, v in containers().items() if k != NAME} == baseline['other_containers']
        assert dict(s.split('=', 1) for s in inspect(NAME)['Config']['Env']) == dict(
            s.split('=', 1) for s in previous['Config']['Env']
        )
        assert {m['Destination']: m for m in inspect(NAME)['Mounts']} == {
            m['Destination']: m for m in previous['Mounts']
        }
        assert inspect(NAME)['Config']['Image'] == IMAGE
        record('deployment-summary.json', {'deployed': True, 'image': IMAGE,
               'image_id': inspect(NAME)['Image'], 'previous_image': baseline['previous_image'],
               'checks': checks, 'other_containers_unchanged': True,
               'runtime_env_unchanged': True, 'mounts_unchanged': True,
               'backend_updated': True, 'dependencies_retained': True, 'translation_database': '/data/mbweb/translations.sqlite', 'health': 'healthy'})
        print('DEPLOYED:', IMAGE, json.dumps(checks), flush=True)
    except Exception:
        assert (ROOT / '.env').read_text() == updated, 'Concurrent env change; cannot safely restore'
        (ROOT / '.env').write_text(original)
        subprocess.run(compose, cwd=ROOT, check=True)
        print('ROLLED BACK to', baseline['previous_image'], flush=True)
        raise
