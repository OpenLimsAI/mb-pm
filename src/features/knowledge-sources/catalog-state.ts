import type { SourceDocument } from './api'

export interface CatalogState {
  query: string
  scope: string
  status: 'pending' | 'saved' | 'all' | 'update'
  type: string
  novelty: 'all' | 'new' | 'unread'
  selectedOnly: boolean
  page: number
  chosen: string[]
  parse: boolean
  destination: string
}
export const defaultCatalogState = (): CatalogState => ({ query: '', scope: 'all', status: 'pending', type: 'all', novelty: 'all', selectedOnly: false, page: 1, chosen: [], parse: true, destination: '' })
const stateKey = (identity: string, source: string) => `kso:catalog:v2:${encodeURIComponent(identity)}:${encodeURIComponent(source)}`

export function restoreCatalog(identity: string | undefined, source: string, docs: SourceDocument[], scopes: string[], folders: string[]): CatalogState {
  const initial = defaultCatalogState()
  if (!identity) return initial
  try {
    const value: unknown = JSON.parse(localStorage.getItem(stateKey(identity, source)) || 'null')
    if (!value || typeof value !== 'object') return initial
    const v = value as Partial<CatalogState>
    const ids = new Set(docs.map(doc => doc.id))
    return {
      query: typeof v.query === 'string' ? v.query.slice(0, 300) : '',
      scope: typeof v.scope === 'string' && scopes.includes(v.scope) ? v.scope : 'all',
      status: ['pending', 'saved', 'all', 'update'].includes(v.status || '') ? v.status! : 'pending',
      type: typeof v.type === 'string' ? v.type.slice(0, 100) : 'all',
      novelty: ['all', 'new', 'unread'].includes(v.novelty || '') ? v.novelty! : 'all',
      selectedOnly: v.selectedOnly === true,
      page: typeof v.page === 'number' && Number.isSafeInteger(v.page) && v.page > 0 ? v.page : 1,
      chosen: Array.isArray(v.chosen) ? [...new Set(v.chosen.filter(id => typeof id === 'string' && ids.has(id)))].slice(0, 1500) : [],
      parse: v.parse !== false,
      destination: typeof v.destination === 'string' && folders.includes(v.destination) ? v.destination : '',
    }
  } catch { return initial }
}
export function saveCatalog(identity: string | undefined, source: string, value: CatalogState) {
  if (!identity) return
  try { localStorage.setItem(stateKey(identity, source), JSON.stringify(value)) } catch { /* Storage may be disabled; the current session remains usable. */ }
}
export function isGuideline(document: SourceDocument) {
  return /^(?:guideline|guidelines|指导原则|指南)(?:\s*\([^)]*\))?$/i.test(document.documentType.trim())
}
