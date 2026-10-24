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

export type LibraryMessage = { type: 'ready'; preview: boolean } | { type: 'selection'; path: string | null; title: string }
export function readLibraryMessage(event: MessageEvent, frame: Window | null, origin: string): LibraryMessage | null {
  if (!frame || event.source !== frame || event.origin !== origin) return null
  const data = event.data
  if (!data || typeof data !== 'object' || data.version !== 1) return null
  if (data.type === 'mberp:knowledge-library:ready' && typeof data.preview === 'boolean') return { type: 'ready', preview: data.preview }
  if (data.type !== 'mberp:knowledge-library:selection') return null
  if (data.path === null) return { type: 'selection', path: null, title: '' }
  if (!validLibraryPath(data.path) || typeof data.title !== 'string' || data.title.length > 1000) return null
  return { type: 'selection', path: data.path, title: data.title }
}
