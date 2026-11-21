import axios, { type AxiosProgressEvent } from 'axios'
import { API_BASE, camelize, snakeize } from '../../api/client'
import type { SourcePaper } from './api'

const client = axios.create({ baseURL: `${API_BASE}/knowledge-sources/v3`, withCredentials: true, timeout: 150000 })
client.interceptors.response.use(response => response, error => {
  if (error.response?.status === 401) window.dispatchEvent(new Event('portal:unauthorized'))
  return Promise.reject(error)
})
export function decodeKnowledgeV3<T>(data: unknown): T {
  const result = camelize<Record<string, unknown>>(data)
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const record = data as Record<string, unknown>
    if ('reading' in record) {
      const reading = record.reading
      if (reading && typeof reading === 'object' && !Array.isArray(reading)) {
        result.reading = Object.fromEntries(
          Object.entries(reading as Record<string, unknown>).map(([path, entry]) => [path, camelize(entry)]),
        )
      }
    }
    const rawCounts = record.folderCounts ?? record.folder_counts
    if (rawCounts && typeof rawCounts === 'object' && !Array.isArray(rawCounts)) {
      result.folderCounts = Object.fromEntries(
        Object.entries(rawCounts as Record<string, unknown>).map(([id, count]) => [id, Number(count) || 0]),
      )
    }
  }
  return result as T
}

function encodeKnowledgeV3Body(body: unknown): unknown {
  const encoded = snakeize(body)
  if (
    body && typeof body === 'object' && !Array.isArray(body)
    && 'metadata' in body
    && encoded && typeof encoded === 'object' && !Array.isArray(encoded)
  ) {
    const rawMetadata = (body as { metadata?: unknown }).metadata
    if (rawMetadata && typeof rawMetadata === 'object' && !Array.isArray(rawMetadata)) {
      ;(encoded as Record<string, unknown>).metadata = rawMetadata
    }
  }
  return encoded
}

export const knowledgeV3Get = <T,>(path: string, signal?: AbortSignal) => client.get(path, { signal }).then(r => decodeKnowledgeV3<T>(r.data))
export const knowledgeV3Post = <T,>(path: string, body: unknown, signal?: AbortSignal) => client.post(path, encodeKnowledgeV3Body(body), { signal }).then(r => decodeKnowledgeV3<T>(r.data))
export const knowledgeV3Patch = <T,>(path: string, body: unknown, signal?: AbortSignal) => client.patch(path, encodeKnowledgeV3Body(body), { signal }).then(r => decodeKnowledgeV3<T>(r.data))
export const knowledgeV3Upload = <T,>(path: string, body: FormData, signal?: AbortSignal, onUploadProgress?: (event: AxiosProgressEvent) => void) => client.post(path, body, { signal, onUploadProgress }).then(r => decodeKnowledgeV3<T>(r.data))
function readErrorBlobText(payload: unknown): Promise<string | null> {
  if (!payload || typeof payload !== 'object') return Promise.resolve(null)
  if (typeof (payload as { text?: unknown }).text === 'function') {
    return (payload as Blob).text()
  }
  if (payload instanceof Blob || Object.prototype.toString.call(payload) === '[object Blob]') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
      reader.onerror = () => reject(reader.error)
      reader.readAsText(payload as Blob)
    })
  }
  return Promise.resolve(null)
}

export async function knowledgeV3Download(path: string, body: unknown, filename: string) {
  let result
  try {
    result = await client.post(path, encodeKnowledgeV3Body(body), { responseType: 'blob' })
  } catch (error) {
    if (axios.isAxiosError(error) && error.response) {
      try {
        const text = await readErrorBlobText(error.response.data)
        if (text) error.response.data = JSON.parse(text)
      } catch { /* Keep status-based fallback in sourceError when blob is non-JSON. */ }
    }
    throw error
  }
  const url = URL.createObjectURL(result.data)
  const anchor = document.createElement('a')
  anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 60000)
}

export interface LibraryQuery {
  query: string; folderId: string; searchMode: 'all' | 'title'; offset: number; limit: number
  sort: 'recent' | 'title'; tagIds: string[]; readingStatus?: string; collectionId?: string
  savedAfter?: string
  type?: string
  indexStatus?: 'ready' | 'failed' | 'pending' | 'not_requested' | 'unknown'
}
export interface LibraryPaper extends SourcePaper {
  path?: string; authors?: string[]; year?: string; doi?: string; abstract?: string
  tags?: { id: string; name: string; color?: string }[]
  matches?: { text: string; offset?: number; page?: number; field?: string }[]
  reading?: { state: 'unread' | 'reading' | 'done' | 'later'; progress?: number; position?: { page?: number; offset?: number; section?: string }; updatedAt?: string }
}
export interface LibraryPage { papers: LibraryPaper[]; total: number; offset: number; limit: number; revision: number; nextOffset?: number | null; folderCounts?: Record<string, number>; tags?: {id:string;name:string;color?:string}[]; searchIndex?:{indexing:boolean;complete:boolean;indexed:number;total:number;failed:number}; incomplete?:boolean; noteSearchTruncated?:boolean }
export interface PaperDetail {
  paper: LibraryPaper; text?: string; textOffset?: number; totalCharacters?: number; revision?: number
  originalUrl?: string; kbUrl?: string; canWrite?: boolean; contentHash?: string
  references?: { id: string; title: string; kind: string; url: string; versionId?: string }[]
  metadataRevision?: number; insightRevision?: number
  positionUnit?: 'utf16' | 'codepoint'
}
