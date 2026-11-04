import { afterEach, expect, it, vi } from 'vitest'
import { buildFeedbackEntry, getFeedbackSource, safeFeedbackPath } from './source'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

it('keeps the exact page route while stripping query values and non-route fragments', () => {
  expect(safeFeedbackPath('/projects/p-1?token=secret&tab=tasks#private-note')).toBe('/projects/p-1')
  expect(safeFeedbackPath('/#/papers/p-1?access_token=secret')).toBe('/#/papers/p-1')
  expect(safeFeedbackPath('/#notes')).toBe('/#notes')
  expect(safeFeedbackPath('/#research')).toBe('/#research')
  expect(safeFeedbackPath('/#settings')).toBe('/#settings')
  expect(safeFeedbackPath('/#library')).toBe('/#library')
  expect(safeFeedbackPath('/#research?access_token=secret')).toBe('/#research')
  expect(safeFeedbackPath('/projects/%E8%8D%AF%E7%89%A9?token=secret')).toBe('/projects/%E8%8D%AF%E7%89%A9')
})

it('rejects external destinations, auth pages and auth hash routes', () => {
  for (const path of ['https://elsewhere.example/p', '//elsewhere.example/p', '/\\elsewhere.example', '/path\nother', '/login?code=secret', '/api/v1/auth/callback?code=secret', '/logout', '/#/oauth/callback?code=secret', '/#/login?token=secret', '/%61uth/callback?code=secret', '/api/v1/projects', '/register', '/#/api/v1/private', '/path%0Aother', '/path%7Fother', '/%5Celsewhere.example', '/%2Felsewhere.example', '/bad%encoding']) {
    expect(safeFeedbackPath(path), path).toBeUndefined()
  }
})

it('collects only a known application and sanitized page with current browser and time', () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-04T12:00:00Z'))
  const source = getFeedbackSource(new URLSearchParams({ application: 'kb', source_path: '/#research?token=secret', browser: 'spoofed', captured_at: 'spoofed' }))
  expect(source.application).toBe('kb')
  expect(source.path).toBe('/#research')
  expect(source.browser).toBe(navigator.userAgent.slice(0, 300))
  expect(source.captured_at).toBe('2026-11-04T12:00:00.000Z')
  const unsafe = getFeedbackSource(new URLSearchParams({ application: '__proto__', source_path: 'https://elsewhere.example/path' }))
  expect(unsafe).not.toHaveProperty('application')
  expect(unsafe).not.toHaveProperty('path')
})

it('builds a new-tab composer URL without sharing the source page query or identity', () => {
  const target = new URL(buildFeedbackEntry('https://www.openlims.ai/feedback', 'pm', { pathname: '/projects/p-1', hash: '#task-1' }))
  expect(target.origin).toBe('https://www.openlims.ai')
  expect(target.pathname).toBe('/feedback')
  expect(Object.fromEntries(target.searchParams)).toEqual({ compose: '1', application: 'pm', source_path: '/projects/p-1' })
  const local = buildFeedbackEntry('/feedback', 'kb', { pathname: '/', hash: '#notes' }, true)
  expect(new URL(local, window.location.origin).searchParams.get('source_path')).toBe('/#notes')
  expect(new URL(local, window.location.origin).searchParams.get('preview')).toBe('1')
})
