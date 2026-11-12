import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

it('preserves the mounted knowledge path in report embedding and OAuth continuation', async () => {
  vi.stubEnv('VITE_APP_MODE', 'combined')
  vi.stubEnv('VITE_KNOWLEDGE_BASE_PATH', '/knowledge-base')
  vi.resetModules()
  const { libraryEmbedUrl, libraryLoginUrl } = await import('./libraryEmbed')
  const embedded = new URL(libraryEmbedUrl(false)!)
  const login = new URL(libraryLoginUrl())
  expect(embedded.pathname).toBe('/knowledge-base/')
  expect(embedded.searchParams.get('parentOrigin')).toBe(window.location.origin)
  expect(login.pathname).toBe('/knowledge-base/web/auth/login')
  expect(login.searchParams.get('returnTo')).toBe('/knowledge-base/web/auth/report-return')
  expect(login.searchParams.has('access_token')).toBe(false)
})
