import { applicationLabels, type FeedbackApplication } from './shared'

/** Remove query strings and auth fragments before a page is shared with feedback. */
export function safeFeedbackPath(path: string): string | undefined {
  let decoded: string
  try { decoded = decodeURIComponent(path) } catch { return undefined }
  if (!decoded.startsWith('/') || decoded.startsWith('//') || decoded.includes('\\') || Array.from(decoded).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return undefined
  const [pathname, fragment] = path.split('#', 2)
  const clean = pathname.split('?')[0]
  if (/\/(?:api|register|auth|oauth|oidc|login|logout|callback)(?:\/|$)/i.test(decodeURIComponent(clean))) return undefined
  const hashPath = fragment?.split('?')[0] || ''
  const route = hashPath.startsWith('/') || /^(?:notes|research|settings|library)$/.test(hashPath) ? hashPath : ''
  if (/\/(?:api|register|auth|oauth|oidc|login|logout|callback)(?:\/|$)/i.test(decodeURIComponent(route))) return undefined
  return (clean + (route ? `#${route}` : '')).slice(0, 500)
}

export function getFeedbackSource(params: URLSearchParams) {
  const application = params.get('application') || undefined
  return {
    ...(application && Object.hasOwn(applicationLabels, application) ? { application: application as FeedbackApplication } : {}),
    ...(safeFeedbackPath(params.get('source_path') || '') ? { path: safeFeedbackPath(params.get('source_path') || '') } : {}),
    browser: typeof navigator === 'undefined' ? '' : navigator.userAgent.slice(0, 300),
    captured_at: new Date().toISOString(),
  }
}

export function buildFeedbackEntry(base: string, application: string, page: Pick<Location, 'pathname' | 'hash'>, preview = false): string {
  const url = new URL(base, window.location.origin)
  url.searchParams.set('compose', '1')
  if (preview) url.searchParams.set('preview', '1')
  url.searchParams.set('application', application)
  const path = safeFeedbackPath(page.pathname + page.hash)
  if (path) url.searchParams.set('source_path', path)
  return base.startsWith('/') ? url.pathname + url.search : url.toString()
}
