import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { createServer } from 'vite'
import { monitorChromeStartup, waitForChromeSocket } from './chrome-startup.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const arguments_ = process.argv.slice(2)
assert(arguments_.length === 0 || (arguments_.length === 2 && arguments_[0] === '--output'), 'Usage: npm run test:project-layout -- [--output directory]')
const scratch = mkdtempSync(join(tmpdir(), 'mb-project-layout-'))
const output = arguments_[1] ? resolve(arguments_[1]) : join(scratch, 'result')
const chrome = process.env.CHROME_BIN || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome')
const profile = join(scratch, 'chrome')
const geometry = []
const interceptedRequests = []
let browser, socket, monitor, server, succeeded = false, requestId = 0
const pending = new Map()

function call(method, params = {}) {
  const id = ++requestId
  return new Promise((resolve_, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Chrome timed out: ${method}`)) }, 15000)
    pending.set(id, { resolve: resolve_, reject, timer })
    socket.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(`Page evaluation failed: ${JSON.stringify(result.exceptionDetails)}`)
  return result.result.value
}
async function until(expression) {
  const deadline = Date.now() + 20000
  do { if (await evaluate(expression)) return; await delay(100) } while (Date.now() < deadline)
  throw new Error(`Page did not settle: ${expression}`)
}
async function resize(width, height) {
  await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await delay(100)
}
async function assertPortAvailable() {
  const probe = createNetServer()
  await new Promise((resolve_, reject) => {
    probe.once('error', () => reject(new Error('localhost:1234 is occupied. Stop the existing local workbench before running the isolated layout regression.')))
    probe.listen({ host: 'localhost', port: 1234, exclusive: true }, () => probe.close(resolve_))
  })
}
async function sample(name) {
  await delay(100)
  const value = JSON.parse(await evaluate(`JSON.stringify((() => {
    const box = element => {
      if (!element) return null
      const rect = element.getBoundingClientRect(), css = getComputedStyle(element)
      return { top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height,
        scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight,
        position: css.position, overflow: css.overflowY }
    }
    const main = document.querySelector('.app-main'), sidebar = document.querySelector('.app-sidebar')
    const label = main?.querySelector('label.sr-only')
    return { viewport: { width: innerWidth, height: innerHeight }, document: box(document.scrollingElement),
      root: box(document.getElementById('root')), shell: box(sidebar?.parentElement), sidebar: box(sidebar),
      main: box(main), content: box(main?.firstElementChild), topbar: box(document.querySelector('.app-topbar')),
      label: box(label), labelContained: !label || (label.offsetParent instanceof Element && main.contains(label.offsetParent)),
      gantt: box(document.querySelector('.gantt-card')), ganttScroll: box(document.querySelector('.gantt-scroll')),
      fullscreen: box(document.querySelector('.wbs-workspace--fullscreen')),
      pointStack: document.elementsFromPoint(innerWidth / 2, innerHeight - 2).map(e => e.tagName + '.' + (typeof e.className === 'string' ? e.className : '')),
      apiRequests: window.__projectLayoutRequests }
  })())`))
  geometry.push({ name, ...value })
  writeFileSync(join(output, 'geometry.json'), JSON.stringify(geometry, null, 2) + '\n')
  const image = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  writeFileSync(join(output, `${name}.png`), Buffer.from(image.data, 'base64'))
  assert.deepEqual(value.apiRequests, [], `${name}: synthetic page attempted a real API request`)
  assert.deepEqual(interceptedRequests, [], `${name}: unexpected network request to API`)
  assert(value.document.scrollHeight <= value.viewport.height + 1, `${name}: document has ${value.document.scrollHeight - value.viewport.height}px of extra scrolling`)
  assert(Math.abs(value.sidebar.bottom - value.viewport.height) <= 1, `${name}: sidebar does not end at viewport`)
  assert(Math.abs(value.main.bottom - value.viewport.height) <= 1, `${name}: main does not end at viewport`)
  assert(value.main.clientHeight > 0, `${name}: main collapsed`)
  assert(value.labelContained, `${name}: hidden composer label escaped the scroll container`)
  console.log(`Project layout: ${name} passed`)
  return value
}

try {
  mkdirSync(output, { recursive: true })
  assert(existsSync(chrome), 'Chrome is required; set CHROME_BIN to its executable')
  await assertPortAvailable()
  process.chdir(repo)
  server = await createServer({
    configFile: join(repo, 'vite.config.ts'),
    configLoader: 'runner',
    root: repo,
    cacheDir: join(scratch, 'vite-cache'),
    optimizeDeps: { entries: ['scripts/fixtures/project-layout/index.html'] },
    server: { host: 'localhost', port: 1234, strictPort: true, open: false },
    plugins: [{
      name: 'isolated-layout-bootstrap', enforce: 'pre',
      configureServer(vite) {
        vite.middlewares.use((request, response, next) => {
          if (!request.url?.startsWith('/api/')) return next()
          interceptedRequests.push(request.url)
          response.statusCode = 503
          response.end('API access disabled in synthetic layout test')
        })
      },
      resolveId(source) {
        if (/(?:^|\/)data\/bootstrap(?:\.ts)?$/.test(source)) return join(repo, 'scripts/fixtures/project-layout/bootstrap.js')
      },
    }],
  })
  await server.listen()
  browser = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update',
    '--disable-extensions', '--password-store=basic', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] })
  monitor = monitorChromeStartup(browser)
  const endpoint = await monitor.waitForEndpoint(profile)
  const target = await monitor.waitForPage(endpoint)
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await waitForChromeSocket(socket)
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data), request = pending.get(message.id)
    if (!request) return
    clearTimeout(request.timer); pending.delete(message.id)
    if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result)
  })
  await call('Page.enable')
  await resize(1512, 982)
  await call('Page.navigate', { url: 'http://localhost:1234/scripts/fixtures/project-layout/index.html' })
  await until('window.__projectLayoutReady && !!document.querySelector(".app-main textarea")')
  await sample('desktop-short')
  await evaluate('window.__projectLayout.navigate("/project-assistant?aiRun=qa-run")')
  await until('document.querySelector(".app-main").textContent.includes("第 100 项合成进展")')
  await evaluate('Array.from(document.querySelectorAll("summary")).find(e => e.textContent.includes("展开其余")).click()')
  await evaluate('document.querySelector(".app-main").scrollTop=100000')
  const long = await sample('desktop-long-bottom')
  assert(long.label, 'Real composer label is absent from the long-report fixture')
  assert(long.main.scrollTop > 1000 && long.main.scrollHeight > long.main.clientHeight, 'Long report did not scroll in main')
  await evaluate('document.scrollingElement.scrollTop=100000')
  assert.equal(await evaluate('document.scrollingElement.scrollTop'), 0, 'Body scrolled beyond the workspace')
  await evaluate('Array.from(document.querySelectorAll("button")).find(e => e.textContent === "新问题").click()')
  await until('!document.querySelector(".app-main").textContent.includes("第 100 项合成进展")')
  const short = await sample('desktop-long-to-short')
  assert.equal(short.main.scrollTop, 0, 'Short content retained an invalid scroll position')
  await evaluate('window.__projectLayout.setIdentity(true)')
  await sample('desktop-identity-notice')
  assert.equal(await evaluate('Array.from(document.querySelectorAll("[role=status]")).filter(e=>e.textContent.includes("合成身份刷新提示")).length'), 1, 'Identity retry notice is duplicated')
  assert(await evaluate('!!Array.from(document.querySelectorAll(".app-content [role=status]")).find(e=>e.textContent.includes("合成身份刷新提示"))'), 'Identity retry notice is outside the flex height allocation')
  await evaluate('window.__projectLayout.setNotice(true)')
  await sample('desktop-both-notices')
  await resize(390, 600)
  await sample('narrow-short-both-notices')
  await evaluate('window.__projectLayout.setIdentity(false);window.__projectLayout.setNotice(false)')
  await sample('narrow-short')
  await resize(1512, 982)
  await evaluate('window.__projectLayout.navigate("/gantt")')
  await until('!!document.querySelector(".gantt-scroll")')
  const gantt = await sample('desktop-gantt')
  assert(gantt.gantt.height > 400 && gantt.ganttScroll.clientHeight > 250, 'Desktop timeline did not fill available height')
  assert(gantt.content.bottom <= gantt.main.bottom + 1, 'Timeline extends beyond main')
  await resize(640, 600)
  const narrow = await sample('narrow-gantt')
  assert(narrow.ganttScroll.clientHeight > 80 && narrow.gantt.bottom <= narrow.main.bottom + 1, 'Narrow timeline is clipped or collapsed')
  await resize(1512, 982)
  await evaluate('window.__projectLayout.navigate("/wbs")')
  await until('!!document.querySelector(".wbs-workspace")')
  await evaluate('document.querySelector(".app-main").scrollTop=400')
  const before = await sample('wbs-before')
  await evaluate('Array.from(document.querySelectorAll("button")).find(e => e.textContent === "全屏视图").click()')
  await until('!!document.querySelector(".wbs-workspace--fullscreen")')
  const fullscreen = await sample('wbs-fullscreen')
  assert(Math.abs(fullscreen.fullscreen.top) <= 1 && Math.abs(fullscreen.fullscreen.height - 982) <= 1, 'WBS fullscreen does not cover viewport')
  await evaluate('Array.from(document.querySelectorAll("button")).find(e => e.textContent === "退出全屏").click()')
  await until('!document.querySelector(".wbs-workspace--fullscreen")')
  const restored = await sample('wbs-restored')
  assert.equal(restored.main.scrollTop, before.main.scrollTop, 'WBS fullscreen changed original scroll position')
  writeFileSync(join(output, 'result.json'), JSON.stringify({ passed: true, scenarios: geometry.length, syntheticOnly: true, modelCalls: 0 }, null, 2) + '\n')
  succeeded = true
  console.log(`Project layout regression passed (${geometry.length} scenarios).${arguments_[1] ? ` Evidence: ${output}` : ''}`)
} catch (error) {
  writeFileSync(join(output, 'result.json'), JSON.stringify({ passed: false, error: error.message, scenarios: geometry.length }, null, 2) + '\n')
  console.error(`Layout diagnostics: ${output}`)
  if (monitor) console.error(monitor.diagnostics())
  throw error
} finally {
  for (const request of pending.values()) clearTimeout(request.timer)
  socket?.close()
  if (browser?.pid && browser.exitCode === null && browser.signalCode === null) {
    const exited = new Promise(resolve_ => browser.once('exit', resolve_))
    browser.kill('SIGTERM'); await Promise.race([exited, delay(3000)])
    if (browser.exitCode === null && browser.signalCode === null) { browser.kill('SIGKILL'); await exited }
  }
  monitor?.dispose()
  await server?.close()
  if (succeeded) rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  else {
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    rmSync(join(scratch, 'vite-cache'), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}
