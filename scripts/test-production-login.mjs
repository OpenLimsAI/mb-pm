import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, extname, sep } from 'node:path'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
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

let browser, socket
const pending = new Map()
let callId = 0
function call(method, params = {}) {
  const id = ++callId
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Chrome timed out: ${method}`)) }, 5000)
    pending.set(id, { resolve, reject, timeout })
    socket.send(JSON.stringify({ id, method, params }))
  })
}
async function waitFor(check, timeout = 20000) {
  const deadline = Date.now() + timeout
  do {
    const result = await check()
    if (result) return result
    await delay(100)
  } while (Date.now() < deadline)
  throw new Error('Timed out waiting for the production login to settle')
}
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const url = `http://127.0.0.1:${server.address().port}/login`
  browser = spawn(chrome, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--disable-extensions', '--password-store=basic',
    `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank',
  ], { stdio: 'ignore' })
  let launchError
  browser.once('error', error => { launchError = error })
  const portFile = join(profile, 'DevToolsActivePort')
  await waitFor(() => { if (launchError) throw launchError; return existsSync(portFile) }, 10000)
  const port = Number(readFileSync(portFile, 'utf8').split('\n')[0])
  if (!Number.isInteger(port) || port <= 0) throw new Error('Chrome did not expose a local debug port')
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const target = targets.find(item => item.type === 'page')
  if (!target?.webSocketDebuggerUrl) throw new Error('Chrome did not create a test page')
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data), request = pending.get(message.id)
    if (!request) return
    clearTimeout(request.timeout); pending.delete(message.id)
    if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result)
  })
  await call('Page.navigate', { url })
  let state
  // Wait on real application readiness. --dump-dom with a virtual time budget can
  // snapshot while the asynchronous /me=401 response is still being committed.
  try {
    await waitFor(async () => {
      const response = await call('Runtime.evaluate', { returnByValue: true, expression: `JSON.stringify({
        inputs: ['mb-login-username', 'mb-login-password'].map(id => { const el = document.getElementById(id); return { id, exists: !!el, disabled: el?.disabled, readOnly: el?.readOnly } }),
        submit: (() => { const el = document.querySelector('.mb-login-submit'); return { exists: !!el, disabled: el?.disabled, busy: el?.getAttribute('aria-busy') } })()
      })` })
      state = JSON.parse(response.result.value)
      return requests.includes('/api/v1/portal/me') && state.submit.exists && !state.submit.disabled && state.inputs.every(input => input.exists && !input.disabled && !input.readOnly)
    })
  } catch (error) {
    throw new Error(`${error.message}; API requests=${JSON.stringify(requests)}; login=${JSON.stringify(state)}`)
  }
  for (const input of state.inputs) if (!input.exists || input.disabled || input.readOnly) throw new Error(`${input.id} is missing or not editable in the final production bundle`)
  if (!state.submit.exists || state.submit.disabled) throw new Error('Production login button is disabled')
  if (!requests.includes('/api/v1/portal/me')) throw new Error('Production bundle did not query the real API path')
  console.log('Production bundle smoke passed: anonymous /me=401, username/password editable, submit enabled')
} finally {
  for (const request of pending.values()) clearTimeout(request.timeout)
  socket?.close()
  if (browser && browser.exitCode === null) {
    browser.kill('SIGTERM')
    await Promise.race([new Promise(resolve => browser.once('exit', resolve)), delay(3000)])
    if (browser.exitCode === null) browser.kill('SIGKILL')
  }
  if (server.listening) await new Promise(resolve => server.close(resolve))
  rmSync(profile, { recursive: true, force: true })
}
