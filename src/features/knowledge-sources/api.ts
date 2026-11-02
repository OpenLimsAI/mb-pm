import axios from 'axios'
import { API_BASE, camelize, snakeize } from '../../api/client'
import type { InformationDocument, InformationJob, InformationSource, InformationEvent } from '../information/api'

export interface SourcePaper {
  id: string; title: string; code?: string; sourceId?: string; sourceName?: string
  folderIds: string[]; kbUrl?: string; originalUrl?: string; saved: boolean
  indexStatus: string; size?: number; createdAt?: string; type?: string; language?: string
  error?: string | null; documentId?: string; versionId?: string; parseStatus?: string; officialDate?: string; officialStatus?: string; versionStatus?: string; sourceUrl?: string; latest?: boolean
}
export interface SourceDocument extends InformationDocument { isNew?: boolean; unread?: boolean; versionStatus?: 'not_saved' | 'unverified' | 'current' | 'update_available'; verifiedAt?: string }
export interface SourceDefinition extends InformationSource { archiveFolderId?: string; schedule?: { frequency: 'off' | 'daily' | 'weekly'; downloadUpdates: boolean; indexUpdates: boolean; nextCheckAt?: string } }
export type SourceJob = Omit<InformationJob, 'items'> & { kind?: string; app?: string; summary?: Record<string, number>; items: (InformationJob['items'][number] & { phase?: string; failurePhase?: string; result?: string; scope?: string })[] }
export interface SourceFolder { id: string; name: string; writable?: boolean; kind?: 'topic' | 'source'; parentId?: string | null }
export interface KnowledgeSourceSnapshot {
  papers: SourcePaper[]; folders: SourceFolder[]; sources: SourceDefinition[]
  jobs: SourceJob[]; documents: SourceDocument[]
  changes?: InformationEvent[]; resources?: Record<string, unknown>; refreshedAt?: string; undoToken?: string; catalogRevision: number; canManage: boolean; canOrganize: boolean; starred: string[]
  integration: { status: string; message: string; kbUrl?: string }
}

// Portal cookie only: never copy a Core credential or use the PM auth store.
const client = axios.create({ baseURL: API_BASE + '/knowledge-sources', withCredentials: true, timeout: 30000 })
client.interceptors.response.use(response => response, error => {
  if (error.response?.status === 401) window.dispatchEvent(new Event('portal:unauthorized'))
  return Promise.reject(error)
})
export const getKnowledgeSources = (signal?: AbortSignal) => client.get('/snapshot', { signal }).then(r => camelize<KnowledgeSourceSnapshot>(r.data))
export const getKnowledgeSourceJobs = () => client.get('/jobs/status').then(r => camelize<{ jobs: SourceJob[]; refreshedAt: string }>(r.data))
export const mutateKnowledgeSources = (method: 'post' | 'patch', path: string, value: unknown) => client.request({ method, url: path, data: snakeize(value) }).then(r => camelize(r.data))
export function sourceError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const detail = error.response?.data?.detail
    return typeof detail === 'string' ? detail : error.response?.status === 409 ? '资料或任务状态已更新，请刷新后重试。' : error.response?.status === 403 ? '当前账号没有此操作权限，请检查知识库角色。' : error.response?.status === 429 ? '来源请求过于频繁，请稍后重试。' : error.response?.status === 422 ? '操作参数未通过校验，请检查选择数量与设置。' : error.code === 'ECONNABORTED' ? '响应超时，已加载资料仍保留，请重试连接。' : '暂时无法连接知识源，已加载资料仍保留，请重试连接。'
  }
  return '暂时无法完成操作，请刷新后重试。'
}
