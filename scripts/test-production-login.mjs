import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, extname, sep } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { JSDOM } from 'jsdom'
import { verifyProductionBuild } from './production-build.mjs'

const directory = resolve(process.argv[2] || 'dist')
verifyProductionBuild(directory, process.env.SOURCE_REVISION)
const chrome = process.env.CHROME_BIN || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome')
if (!existsSync(chrome)) throw new Error('Chrome is required for the production login smoke check; set CHROME_BIN')
const profile = mkdtempSync(join(tmpdir(), 'mb-production-login-'))
const requests = []
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' }
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname
  if (path.startsWith('/api/')) {
    requests.push(path)
    response.setHeader('Content-Type', 'application/json')
    if (path === '/api/v1/portal/me') { response.writeHead(401); response.end('{"detail":"anonymous test"}'); return }
    if (path === '/api/v1/portal/config') { response.end('{"login_url":"/unused-login"}'); return }
    response.writeHead(503); response.end('{"detail":"unexpected API in smoke test"}'); return
  }
  const file = path === '/login' || path === '/' ? join(directory, 'index.html') : resolve(directory, '.' + path)
  if (!file.startsWith(directory + sep)) { response.writeHead(404); response.end(); return }
  try { response.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream'); response.end(readFileSync(file)) }
  catch { response.writeHead(404); response.end() }
})

try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/login`
  const { stdout } = await promisify(execFile)(chrome, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--disable-extensions', '--password-store=basic',
    `--user-data-dir=${profile}`, '--dump-dom', '--virtual-time-budget=10000', '--timeout=20000', url,
  ], { timeout: 30000, maxBuffer: 5 * 1024 * 1024 })
  const doc = new JSDOM(stdout).window.document
  for (const id of ['mb-login-username', 'mb-login-password']) {
    const input = doc.getElementById(id)
    if (!input || input.disabled || input.readOnly) throw new Error(`${id} is missing or not editable in the final production bundle`)
  }
  if (!doc.querySelector('.mb-login-submit') || doc.querySelector('.mb-login-submit').disabled) throw new Error('Production login button is disabled')
  if (!requests.includes('/api/v1/portal/me')) throw new Error('Production bundle did not query the real API path')
  console.log('Production bundle smoke passed: anonymous /me=401, username/password editable, submit enabled')
} finally {
  await new Promise(resolve => server.close(resolve))
  rmSync(profile, { recursive: true, force: true })
}
