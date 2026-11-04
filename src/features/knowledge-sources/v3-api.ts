import axios from 'axios'
import { API_BASE, camelize, snakeize } from '../../api/client'
import type { SourcePaper } from './api'

const client = axios.create({ baseURL: `${API_BASE}/knowledge-sources/v3`, withCredentials: true, timeout: 150000 })
client.interceptors.response.use(response => response, error => {
  if (error.response?.status === 401) window.dispatchEvent(new Event('portal:unauthorized'))
  return Promise.reject(error)
})
export function decodeKnowledgeV3<T>(data:unknown):T {
  const result=camelize<Record<string,unknown>>(data)
  if(data&&typeof data==='object'&&!Array.isArray(data)&&'reading' in data){
    const reading=(data as {reading?:unknown}).reading
    if(reading&&typeof reading==='object'&&!Array.isArray(reading))result.reading=Object.fromEntries(Object.entries(reading).map(([path,entry])=>[path,camelize(entry)]))
  }
  return result as T
}
export const knowledgeV3Get = <T,>(path: string, signal?: AbortSignal) => client.get(path, { signal }).then(r => decodeKnowledgeV3<T>(r.data))
export const knowledgeV3Post = <T,>(path: string, body: unknown, signal?: AbortSignal) => client.post(path, snakeize(body), { signal }).then(r => decodeKnowledgeV3<T>(r.data))
export const knowledgeV3Patch = <T,>(path: string, body: unknown, signal?: AbortSignal) => client.patch(path, snakeize(body), { signal }).then(r => decodeKnowledgeV3<T>(r.data))
export const knowledgeV3Upload = <T,>(path: string, body: FormData, signal?: AbortSignal) => client.post(path, body, { signal }).then(r => decodeKnowledgeV3<T>(r.data))
export async function knowledgeV3Download(path: string, body: unknown, filename: string) {
  const result = await client.post(path, snakeize(body), { responseType: 'blob' })
  const url = URL.createObjectURL(result.data)
  const anchor = document.createElement('a')
  anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
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
