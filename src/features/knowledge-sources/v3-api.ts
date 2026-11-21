import axios, { type AxiosProgressEvent } from 'axios'
import {
  createKnowledgeClient,
  decodeKnowledgePayload,
  encodeKnowledgeBody,
  readErrorBlobText,
} from './http'
import type { SourcePaper } from './types'

const client = createKnowledgeClient('/v3', 150000)

export const decodeKnowledgeV3 = decodeKnowledgePayload

export const knowledgeV3Get = <T,>(path: string, signal?: AbortSignal) =>
  client.get(path, { signal }).then(r => decodeKnowledgeV3<T>(r.data))

export const knowledgeV3Post = <T,>(path: string, body: unknown, signal?: AbortSignal) =>
  client.post(path, encodeKnowledgeBody(body), { signal }).then(r => decodeKnowledgeV3<T>(r.data))

export const knowledgeV3Upload = <T,>(
  path: string,
  body: FormData,
  signal?: AbortSignal,
  onUploadProgress?: (event: AxiosProgressEvent) => void,
) => client.post(path, body, { signal, onUploadProgress }).then(r => decodeKnowledgeV3<T>(r.data))

export async function knowledgeV3Download(path: string, body: unknown, filename: string) {
  let result
  try {
    result = await client.post(path, encodeKnowledgeBody(body), { responseType: 'blob' })
  } catch (error) {
    if (axios.isAxiosError(error) && error.response) {
      try {
        const text = await readErrorBlobText(error.response.data)
        if (text) error.response.data = JSON.parse(text)
      } catch {
        /* Keep status-based fallback in sourceError when blob is non-JSON. */
      }
    }
    throw error
  }
  const url = URL.createObjectURL(result.data)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 60000)
}

export interface LibraryQuery {
  query: string
  folderId: string
  searchMode: 'all' | 'title'
  offset: number
  limit: number
  sort: 'recent' | 'title'
  tagIds: string[]
  readingStatus?: string
  collectionId?: string
  savedAfter?: string
  type?: string
  indexStatus?: 'ready' | 'failed' | 'pending' | 'not_requested' | 'unknown'
}

export interface LibraryPaper extends SourcePaper {
  path?: string
  authors?: string[]
  year?: string
  doi?: string
  abstract?: string
  tags?: { id: string; name: string; color?: string }[]
  matches?: { text: string; offset?: number; page?: number; field?: string }[]
  reading?: {
    state: 'unread' | 'reading' | 'done' | 'later'
    progress?: number
    position?: { page?: number; offset?: number; section?: string }
    updatedAt?: string
  }
}

export interface LibraryPage {
  papers: LibraryPaper[]
  total: number
  offset: number
  limit: number
  revision: number
  nextOffset?: number | null
  folderCounts?: Record<string, number>
  tags?: { id: string; name: string; color?: string }[]
  searchIndex?: {
    indexing: boolean
    complete: boolean
    indexed: number
    total: number
    failed: number
  }
  incomplete?: boolean
  noteSearchTruncated?: boolean
}

export interface PaperDetail {
  paper: LibraryPaper
  text?: string
  textOffset?: number
  totalCharacters?: number
  revision?: number
  originalUrl?: string
  kbUrl?: string
  canWrite?: boolean
  contentHash?: string
  references?: { id: string; title: string; kind: string; url: string; versionId?: string }[]
  metadataRevision?: number
  insightRevision?: number
  positionUnit?: 'utf16' | 'codepoint'
}
