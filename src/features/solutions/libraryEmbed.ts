import { knowledgeLaunchUrl } from '../../lib/site'

export function validLibraryPath(path: unknown): path is string {
  return typeof path === 'string' && path.length <= 1024 && path.startsWith('sources/') && path.endsWith('.md')
    && !/[\\%\p{Cc}\p{Cs}]/u.test(path) && path.split('/').every(part => part && part !== '.' && part !== '..')
}

/** The URL comes from the workspace configuration, never from an iframe message. */
export function libraryEmbedUrl(preview: boolean): string | null {
  if (preview && (!import.meta.env.DEV || !['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname))) return null
  const url = new URL(knowledgeLaunchUrl)
  url.searchParams.set('embed', 'library')
  url.searchParams.set('parentOrigin', window.location.origin)
  if (preview) url.searchParams.set('preview', '1')
  return url.href
}

/** Complete standard KB OAuth in a separate window without leaving an unsaved report. */
export function libraryLoginUrl(): string {
  const url = new URL('/web/auth/login', knowledgeLaunchUrl)
  url.searchParams.set('returnTo', '/web/auth/report-return')
  return url.href
}

export function isLibraryLoginComplete(event: MessageEvent, popup: Window | null, origin: string): boolean {
  return !!popup && event.source === popup && event.origin === origin
    && event.data?.type === 'mberp:knowledge-library:authenticated' && event.data.version === 1
}

export interface LibraryQuote { excerpt: string; locator: string }
export interface LibraryNavigation { id: number; path: string; title: string; excerpt: string }
export type LibraryMessage = { type: 'ready'; preview: boolean }
  | { type: 'auth-required' }
  | { type: 'error'; reason: 'unavailable' | 'forbidden' }
  | { type: 'selection'; path: string | null; title: string; quote?: LibraryQuote }
export function readLibraryMessage(event: MessageEvent, frame: Window | null, origin: string): LibraryMessage | null {
  if (!frame || event.source !== frame || event.origin !== origin) return null
  const data = event.data
  if (!data || typeof data !== 'object' || data.version !== 1) return null
  if (data.type === 'mberp:knowledge-library:ready' && typeof data.preview === 'boolean') return { type: 'ready', preview: data.preview }
  if (data.type === 'mberp:knowledge-library:auth-required') return { type: 'auth-required' }
  if (data.type === 'mberp:knowledge-library:error' && (data.reason === 'unavailable' || data.reason === 'forbidden')) return { type: 'error', reason: data.reason }
  if (data.type !== 'mberp:knowledge-library:selection') return null
  if (data.path === null) return { type: 'selection', path: null, title: '' }
  if (!validLibraryPath(data.path) || typeof data.title !== 'string' || data.title.length > 1000) return null
  const quote = typeof data.excerpt === 'string' && data.excerpt.trim() && data.excerpt.length <= 4000
    && typeof data.locator === 'string' && data.locator.length <= 500
    ? { excerpt: data.excerpt, locator: data.locator } : undefined
  return { type: 'selection', path: data.path, title: data.title, ...(quote ? { quote } : {}) }
}
