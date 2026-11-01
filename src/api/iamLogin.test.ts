import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../test/setup'
import { hasIamSession, IamUnreachable, signInWithSession } from './iamLogin'

const endpoint = 'https://iam.test/api/get-account'
beforeEach(() => {
  server.use(http.get('*/api/v1/:kind/config', () => HttpResponse.json({ iam_session_url: endpoint })))
})
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('IAM session probe', () => {
  it.each([
    [{ status: 'ok', data: { name: 'colleague' } }, 'authenticated'],
    [{ status: 'ok', data: null }, 'anonymous'],
    [{ status: 'error', msg: 'Please login first' }, 'anonymous'],
    [{ status: 'error', msg: '请先登录' }, 'anonymous'],
    [{ status: 'ok', data: {} }, 'unknown'],
    [{ status: 'error', msg: 'provider unavailable' }, 'unknown'],
  ])('classifies an explicit provider response without treating malformed data as sign-out', async (body, expected) => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(body))
    vi.stubGlobal('fetch', fetcher)
    expect(await hasIamSession('portal')).toBe(expected)
    expect(fetcher).toHaveBeenCalledWith(endpoint, expect.objectContaining({ credentials: 'include', signal: expect.any(AbortSignal) }))
  })
  it.each([403, 500, 503])('does not infer sign-out from HTTP %s', async status => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ status: 'error' }, { status })))
    expect(await hasIamSession('pm')).toBe('unknown')
  })
  it('does not infer sign-out from a CORS/network failure or HTML challenge', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(new Response('<html>challenge</html>', { status: 403 }))
    vi.stubGlobal('fetch', fetcher)
    expect(await hasIamSession('portal')).toBe('unknown')
    expect(await hasIamSession('portal')).toBe('unknown')
  })
  it('bounds a stalled request and leaves its outcome unknown', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn().mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    }))
    vi.stubGlobal('fetch', fetcher)
    const pending = hasIamSession('portal')
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled())
    await vi.advanceTimersByTimeAsync(10000)
    expect(await pending).toBe('unknown')
  })
  it('does not treat a missing configured IAM endpoint as logged out', async () => {
    server.use(http.get('*/api/v1/portal/config', () => HttpResponse.json({})))
    expect(await hasIamSession('portal')).toBe('unknown')
  })
})

it('quick login reports an unreadable response as a transport failure', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>challenge</html>', { status: 403 })))
  await expect(signInWithSession({ loginApi: 'https://iam.test/api/login', application: 'portal', organization: 'org', callbackUrl: 'https://portal.test/callback', state: 'one-time-state' })).rejects.toBeInstanceOf(IamUnreachable)
})
