import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const OUTPUT_LIMIT = 8192

// Accept only Chrome's literal loopback browser endpoint, never a remote URL.
function browserEndpoint(value) {
  const match = /^ws:\/\/(127\.0\.0\.1|\[::1\]):([1-9]\d{0,4})\/devtools\/browser\/[a-zA-Z0-9-]+$/.exec(value)
  return match && Number(match[2]) <= 65535 ? `http://${match[1]}:${match[2]}` : null
}

export function monitorChromeStartup(browser) {
  const started = Date.now()
  const output = { stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) }
  let announcedEndpoint, launchError, exited, portFileError
  function capture(name, data) {
    output[name] = Buffer.concat([output[name], Buffer.from(data)]).subarray(-OUTPUT_LIMIT)
    // Chrome documents this announcement for --remote-debugging-port=0.
    // Keep chunk fragments until the terminating newline; stdout is supported
    // as well as stderr because Chrome distributions differ in their stream.
    for (const match of output[name].toString('utf8').matchAll(/(?:^|\n)DevTools listening on ([^\s]+)\r?(?=\n)/g)) {
      announcedEndpoint ||= browserEndpoint(match[1])
    }
  }
  const stderr = data => capture('stderr', data)
  const stdout = data => capture('stdout', data)
  const onError = error => { launchError = error }
  const onExit = (code, signal) => { exited = { code, signal } }
  browser.stderr?.on('data', stderr)
  browser.stdout?.on('data', stdout)
  browser.on('error', onError)
  browser.on('exit', onExit)

  function diagnostics() {
    const status = exited || { code: browser.exitCode, signal: browser.signalCode }
    const lines = [`Chrome pid=${browser.pid ?? 'unavailable'}, elapsed=${Date.now() - started}ms, exit=${status.code ?? 'none'}, signal=${status.signal ?? 'none'}`]
    if (launchError) lines.push(`launch error: ${launchError.message}`)
    if (portFileError) lines.push(`DevToolsActivePort read error: ${portFileError.code || portFileError.message}`)
    for (const name of ['stderr', 'stdout']) {
      // Bound memory and failure output; no page content is ever captured here.
      const tail = output[name].toString('utf8').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
      if (tail) lines.push(`${name} (last ${OUTPUT_LIMIT} bytes):\n${tail}`)
    }
    return lines.join('\n')
  }

  function assertRunning() {
    if (launchError) throw new Error(`Chrome failed to launch.\n${diagnostics()}`)
    if (exited || browser.exitCode !== null || browser.signalCode !== null) {
      throw new Error(`Chrome exited before its debug endpoint was ready.\n${diagnostics()}`)
    }
  }

  return {
    diagnostics,
    async waitForEndpoint(profile, { timeoutMs = 30000, pollMs = 100 } = {}) {
      const deadline = started + timeoutMs
      do {
        // A stale announcement or file must not mask an already-exited process.
        assertRunning()
        if (announcedEndpoint) return announcedEndpoint
        try {
          const [port, path] = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/)
          const endpoint = browserEndpoint(`ws://127.0.0.1:${port}${path}`)
          if (endpoint) return endpoint
        } catch (error) {
          if (error.code !== 'ENOENT') portFileError = error
        }
        await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())))
      } while (Date.now() < deadline)
      throw new Error(`Chrome did not expose a local debug endpoint within ${timeoutMs}ms.\n${diagnostics()}`)
    },
    async waitForPage(endpoint, { timeoutMs = 10000, pollMs = 100, fetchImpl = fetch } = {}) {
      const deadline = Date.now() + timeoutMs
      let lastStatus = 'no page target'
      do {
        assertRunning()
        try {
          const response = await fetchImpl(`${endpoint}/json/list`, {
            signal: AbortSignal.timeout(Math.max(1, Math.min(2000, deadline - Date.now()))),
            redirect: 'error',
          })
          if (!response.ok) throw new Error(`Chrome target discovery returned HTTP ${response.status}`)
          const targets = await response.json()
          if (!Array.isArray(targets)) throw new Error('Chrome target discovery did not return a list')
          const target = targets.find(item => item?.type === 'page')
          if (target) {
            const prefix = `${endpoint.replace('http:', 'ws:')}/devtools/page/`
            if (typeof target.webSocketDebuggerUrl !== 'string' || !target.webSocketDebuggerUrl.startsWith(prefix) || !/^[a-zA-Z0-9-]+$/.test(target.webSocketDebuggerUrl.slice(prefix.length))) {
              throw new Error('Chrome page target did not expose a debugger URL on the same local endpoint')
            }
            assertRunning()
            return target
          }
          lastStatus = 'no page target'
        } catch (error) {
          if (error.cause?.code !== 'ECONNREFUSED' && error.code !== 'ECONNREFUSED' && error.name !== 'TimeoutError' && error.name !== 'AbortError') throw error
          lastStatus = error.code || error.cause?.code || error.name
        }
        await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())))
      } while (Date.now() < deadline)
      throw new Error(`Chrome did not create a test page within ${timeoutMs}ms (${lastStatus}).\n${diagnostics()}`)
    },
    dispose() {
      browser.stderr?.off('data', stderr)
      browser.stdout?.off('data', stdout)
      browser.off('error', onError)
      browser.off('exit', onExit)
    },
  }
}

export function waitForChromeSocket(socket, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    function finish(error) {
      clearTimeout(timer)
      socket.removeEventListener('open', opened)
      socket.removeEventListener('error', failed)
      socket.removeEventListener('close', closed)
      if (error) reject(error); else resolve()
    }
    const opened = () => finish()
    const failed = () => finish(new Error('Chrome page debugger WebSocket failed to connect'))
    const closed = () => finish(new Error('Chrome page debugger WebSocket closed before connecting'))
    const timer = setTimeout(() => finish(new Error(`Chrome page debugger WebSocket did not connect within ${timeoutMs}ms`)), timeoutMs)
    socket.addEventListener('open', opened, { once: true })
    socket.addEventListener('error', failed, { once: true })
    socket.addEventListener('close', closed, { once: true })
  })
}
