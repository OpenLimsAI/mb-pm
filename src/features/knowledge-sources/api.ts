import axios from 'axios'
import { API_BASE, camelize, snakeize } from '../../api/client'
import type { InformationDocument, InformationJob, InformationSource } from '../information/api'

export interface SourcePaper {
  id: string; title: string; code?: string; sourceId?: string; sourceName?: string
  folderIds: string[]; kbUrl?: string; originalUrl?: string; saved: boolean
  indexStatus: string; size?: number; createdAt?: string; type?: string; language?: string
  error?: string | null; documentId?: string; versionId?: string
}
export interface SourceFolder { id: string; name: string; writable?: boolean }
export interface KnowledgeSourceSnapshot {
  papers: SourcePaper[]; folders: SourceFolder[]; sources: InformationSource[]
  jobs: (InformationJob & { kind?: string; app?: string })[]; documents: InformationDocument[]
  catalogRevision: number; canManage: boolean; canOrganize: boolean; starred: string[]
  integration: { status: string; message: string; kbUrl?: string }
}

// Portal cookie only: never copy a Core credential or use the PM auth store.
const client = axios.create({ baseURL: API_BASE + '/knowledge-sources', withCredentials: true, timeout: 30000 })
client.interceptors.response.use(response => response, error => {
  if (error.response?.status === 401) window.dispatchEvent(new Event('portal:unauthorized'))
  return Promise.reject(error)
})
export const getKnowledgeSources = (signal?: AbortSignal) => client.get('/snapshot', { signal }).then(r => camelize<KnowledgeSourceSnapshot>(r.data))
export const mutateKnowledgeSources = (method: 'post' | 'patch', path: string, value: unknown) => client.request({ method, url: path, data: snakeize(value) }).then(r => camelize(r.data))
export function sourceError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const detail = error.response?.data?.detail
    return typeof detail === 'string' ? detail : error.response?.status === 409 ? '资料分类已更新，请刷新后重试。' : '暂时无法连接知识源，请稍后重试。'
  }
  return '暂时无法完成操作，请刷新后重试。'
}
