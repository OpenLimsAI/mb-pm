"""Build an isolated native KB release on the customer server; does not switch services."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

os.umask(0o077)
root = Path('/home/prometheus/mb-kb')
source = Path('/home/prometheus/dikw/web-src/dikw-web-v0.10.0')
patches = root / 'native-patches'
tag = 'kb-native-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
release = root / 'releases' / tag
release.mkdir()
web_name, core_name = sys.argv[1:3]
assert web_name in {'dikw-web', 'dikw-web-v06'} and core_name in {'dikw-core', 'dikw-core-v06'}
base = json.loads(subprocess.check_output(['docker', 'inspect', web_name], text=True))[0]
core = json.loads(subprocess.check_output(['docker', 'inspect', core_name], text=True))[0]
assert base['Config']['Image'] == 'dikw-dikw-web:v0.10.0' and base['State']['Running']
assert core['Config']['Image'] == 'dikw-core:0.6.8' and core['State']['Running']
base_env = dict(s.split('=', 1) for s in base['Config']['Env'])
assert base_env['DIKW_CORE_URL'] == 'http://' + core_name + ':8765'
data_dir = next(m['Source'] for m in core['Mounts'] if m['Destination'] == '/base')
base_image = base['Image']
base_tag = 'mb-kb-native-base:' + tag
subprocess.run(['docker', 'tag', base_image, base_tag], check=True)

def excluded(directory, names):
    return [n for n in names if n in {'.git', 'node_modules', 'dist', 'dist-server', 'coverage', 'test-results', 'playwright-report'} or n.startswith('.env') or '.private' in n]

shutil.copytree(source, release / 'source', ignore=excluded)
subprocess.run(['python3', str(patches / 'patch-source.py'), str(release / 'source')], check=True)
files = ['config.ts', 'gate.ts', 'casdoorAdmission.ts', 'casdoorAdmission.test.ts', 'businessGate.test.ts']
manifest = {n: hashlib.sha256((release / 'source/server/auth' / n).read_bytes()).hexdigest() for n in files}
(release / 'source-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
dockerfile = release / 'source/Dockerfile.customer-native'
(release / 'source/inject-default-view.cjs').write_text('''const fs = require("node:fs");
const path = "/app/dist/index.html";
const html = fs.readFileSync(path, "utf8");
if (!html.includes("<head>")) throw Error("Unexpected HTML");
fs.writeFileSync(path, html.replace("<head>", "<head><script>if(!location.hash)location.hash='#mb-web';</script>"));
''')
dockerfile.write_text('''FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts --no-audit --no-fund --registry=https://registry.npmmirror.com --fetch-retries=1 --fetch-timeout=30000
COPY . .
RUN npx prettier --write server/auth/config.ts server/auth/gate.ts server/auth/casdoorAdmission.ts server/auth/casdoorAdmission.test.ts server/auth/businessGate.test.ts
RUN npx eslint server/auth/config.ts server/auth/gate.ts server/auth/casdoorAdmission.ts server/auth/casdoorAdmission.test.ts server/auth/businessGate.test.ts --max-warnings 0
RUN npm run typecheck
RUN npx vitest run server/auth --reporter=dot
RUN npm run build:server
FROM ''' + base_tag + '''
COPY --from=build --chown=node:node /app/dist-server/standalone.mjs /app/dist-server/standalone.mjs
# Preserve the existing built SPA, while making the customer entrance a paper library.
COPY --from=build /app/inject-default-view.cjs /tmp/inject-default-view.cjs
USER root
RUN node /tmp/inject-default-view.cjs && rm /tmp/inject-default-view.cjs
USER node
''')
image = 'mb-kb:' + tag
subprocess.run(['docker', 'build', '--progress=plain', '-f', str(dockerfile), '-t', image, str(release / 'source')], check=True)
image_id = subprocess.check_output(['docker', 'image', 'inspect', image, '--format', '{{.Id}}'], text=True).strip()
assert json.loads(subprocess.check_output(['docker', 'inspect', web_name], text=True))[0]['Id'] == base['Id']
assert json.loads(subprocess.check_output(['docker', 'inspect', core_name], text=True))[0]['Id'] == core['Id']
result = {'tag': tag, 'image': image, 'image_id': image_id, 'base_image_id': base_image, 'native_web_name': web_name, 'native_web_container_id': base['Id'], 'native_core_name': core_name, 'native_core_container_id': core['Id'], 'core_url': base_env['DIKW_CORE_URL'], 'data_dir': data_dir, 'native_original_container_unchanged': True, 'checks': ['auth-file lint', 'full typecheck', 'all auth tests', 'server bundle build'], 'release_dir': str(release)}
(release / 'build-summary.json').write_text(json.dumps(result, indent=2) + '\n')
print('NATIVE_BUILD_COMPLETE ' + json.dumps(result), flush=True)
