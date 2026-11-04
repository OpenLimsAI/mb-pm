import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { monitorChromeStartup, waitForChromeSocket } from './chrome-startup.mjs'

function fixture(t) {
  const profile = mkdtempSync(join(tmpdir(), 'mb-chrome-startup-test-'))
  const browser = Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough() })
  const monitor = monitorChromeStartup(browser)
  t.after(() => { monitor.dispose(); browser.stdout.destroy(); browser.stderr.destroy(); rmSync(profile, { recursive: true, force: true }) })
  return { browser, monitor, profile, wait: (options = {}) => monitor.waitForEndpoint(profile, { timeoutMs: 1000, pollMs: 2, ...options }) }
}

test('discovers a complete DevToolsActivePort file', async t => {
  const { profile, wait } = fixture(t)
  writeFileSync(join(profile, 'DevToolsActivePort'), '43210\n/devtools/browser/test-browser\n')
  assert.equal(await wait(), 'http://127.0.0.1:43210')
})

test('waits for a partially written port file instead of accepting invalid data', async t => {
  const { profile, wait } = fixture(t)
  writeFileSync(join(profile, 'DevToolsActivePort'), '432')
  const result = wait()
  writeFileSync(join(profile, 'DevToolsActivePort'), '43210\n/devtools/browser/test-browser\n')
  assert.equal(await result, 'http://127.0.0.1:43210')
})

test('accepts a fragmented stderr announcement without requiring a port file', async t => {
  const { browser, wait } = fixture(t)
  browser.stderr.write('a harmless startup warning\nDevTools list')
  const result = wait()
  browser.stderr.write('ening on ws://127.0.0.1:43210/devtools/browser/test-browser\n')
  assert.equal(await result, 'http://127.0.0.1:43210')
})

test('also accepts the documented stdout announcement and IPv6 loopback', async t => {
  const { browser, wait } = fixture(t)
  browser.stdout.write('DevTools listening on ws://[::1]:43210/devtools/browser/test-browser\r\n')
  assert.equal(await wait(), 'http://[::1]:43210')
})

test('rejects remote, malformed, credentialed and non-browser announcements', async t => {
  const { browser, wait } = fixture(t)
  for (const value of [
    'ws://example.com:1234/devtools/browser/id', 'ws://127.0.0.1.example.com:1234/devtools/browser/id',
    'ws://user@127.0.0.1:1234/devtools/browser/id', 'wss://127.0.0.1:1234/devtools/browser/id',
    'ws://127.0.0.1:65536/devtools/browser/id', 'ws://127.0.0.1:0/devtools/browser/id',
    'ws://127.1:1234/devtools/browser/id', 'ws://127.0.0.1:1234/devtools/page/id',
    'ws://127.0.0.1:1234/devtools/browser/id?redirect=1',
  ]) browser.stderr.write(`DevTools listening on ${value}\n`)
  await assert.rejects(wait({ timeoutMs: 10 }), /did not expose a local debug endpoint/)
})

test('reports early exit and stderr immediately, even with a stale endpoint', async t => {
  const { browser, wait } = fixture(t)
  browser.stderr.write('DevTools listening on ws://127.0.0.1:43210/devtools/browser/id\nprofile disk full\n')
  browser.exitCode = 1
  browser.emit('exit', 1, null)
  await assert.rejects(wait({ timeoutMs: 30000 }), error => /exited before/.test(error.message) && /exit=1/.test(error.message) && /profile disk full/.test(error.message))
})

test('reports process spawn errors without waiting for the startup timeout', async t => {
  const { browser, wait } = fixture(t)
  browser.emit('error', new Error('spawn ENOENT'))
  await assert.rejects(wait({ timeoutMs: 30000 }), /Chrome failed to launch[\s\S]*spawn ENOENT/)
})

test('timeouts retain only bounded recent output and include signal details', async t => {
  const { browser, monitor, wait } = fixture(t)
  browser.stderr.write(`old-message${'x'.repeat(20000)}\nrecent-message\n`)
  await assert.rejects(wait({ timeoutMs: 10 }), error => {
    assert.match(error.message, /recent-message/)
    assert.doesNotMatch(error.message, /old-message/)
    assert.ok(Buffer.byteLength(error.message) < 9000)
    return true
  })
  browser.emit('exit', null, 'SIGABRT')
  assert.match(monitor.diagnostics(), /signal=SIGABRT/)
  monitor.dispose()
  assert.equal(browser.listenerCount('error'), 0)
  assert.equal(browser.stderr.listenerCount('data'), 0)
})

test('waits through refused connections and an empty target list, then returns a local page', async t => {
  const { monitor } = fixture(t)
  const target = { type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:43210/devtools/page/page-id' }
  let calls = 0
  const result = await monitor.waitForPage('http://127.0.0.1:43210', { timeoutMs: 1000, pollMs: 2, fetchImpl: async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:43210/json/list')
    assert.equal(options.redirect, 'error')
    assert.ok(options.signal instanceof AbortSignal)
    if (++calls === 1) throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })
    return Response.json(calls === 2 ? [] : [target])
  } })
  assert.deepEqual(result, target)
  assert.equal(calls, 3)
})

test('bounds target discovery when Chrome never creates a page', async t => {
  const { monitor } = fixture(t)
  await assert.rejects(monitor.waitForPage('http://127.0.0.1:43210', { timeoutMs: 10, pollMs: 2, fetchImpl: async () => Response.json([]) }), /did not create a test page within 10ms/)
})

test('does not retry HTTP, malformed JSON, invalid target structure or off-origin WS responses', async t => {
  const { monitor } = fixture(t)
  for (const response of [
    new Response('unavailable', { status: 503 }), new Response('not-json'), Response.json({}),
    Response.json([{ type: 'page', webSocketDebuggerUrl: 'ws://remote.example:43210/devtools/page/id' }]),
    Response.json([{ type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:43211/devtools/page/id' }]),
    Response.json([{ type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:43210/devtools/page/id?extra=1' }]),
  ]) {
    let calls = 0
    await assert.rejects(monitor.waitForPage('http://127.0.0.1:43210', { fetchImpl: async () => { calls++; return response } }))
    assert.equal(calls, 1)
  }
})

test('page discovery stops immediately if Chrome exits', async t => {
  const { browser, monitor } = fixture(t)
  browser.emit('exit', 1, null)
  await assert.rejects(monitor.waitForPage('http://127.0.0.1:43210', { fetchImpl: async () => { assert.fail('must not fetch after exit') } }), /Chrome exited/)
})

test('WebSocket startup handles open, error, close and bounded timeout', async () => {
  for (const event of ['open', 'error', 'close', null]) {
    const socket = new EventTarget()
    const result = waitForChromeSocket(socket, 10)
    if (event) socket.dispatchEvent(new Event(event))
    if (event === 'open') await result
    else await assert.rejects(result, /WebSocket/)
    // Late events cannot change the settled result or throw from stale listeners.
    socket.dispatchEvent(new Event('open'))
  }
})
