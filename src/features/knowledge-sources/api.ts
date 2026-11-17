import axios from 'axios'
import { API_BASE, camelize, snakeize } from '../../api/client'
import type { InformationDocument, InformationJob, InformationSource, InformationEvent } from '../information/api'

export interface SourcePaper {
  id: string; title: string; code?: string; sourceId?: string; sourceName?: string
  folderIds: string[]; kbUrl?: string; originalUrl?: string; saved: boolean
  indexStatus: string; size?: number; createdAt?: string; type?: string; language?: string
  error?: string | null; documentId?: string; versionId?: string; parseStatus?: string; officialDate?: string; officialStatus?: string; versionStatus?: string; sourceUrl?: string; latest?: boolean
}
export interface SourceDocument extends InformationDocument { isNew?: boolean; unread?: boolean; versionStatus?: 'not_saved' | 'unverified' | 'current' | 'update_available'; verifiedAt?: string; downloadStatus?: 'not_requested' | 'available' | 'unavailable' | 'failed'; downloadErrorCode?: string; currentVersionId?: string; verifiedSha256?: string }
export interface SourceDefinition extends InformationSource { archiveFolderId?: string; schedule?: { frequency: 'off' | 'daily' | 'weekly'; downloadUpdates: boolean; indexUpdates: boolean; nextCheckAt?: string } }
export type SourceJob = Omit<InformationJob, 'items'> & { kind?: string; app?: string; summary?: Record<string, number>; canUndoRuleFiling?: boolean; ruleFiling?: {status:string;ruleApplications?:number;undoTokens?:string[];error?:string}; items: (InformationJob['items'][number] & { phase?: string; failurePhase?: string; result?: string; scope?: string; errorCode?: string; retryable?: boolean })[] }
export interface SourceFolder { id: string; name: string; writable?: boolean; kind?: 'topic' | 'source'; parentId?: string | null; systemRole?: 'inbox' }
export const isInboxFolder = (folder: SourceFolder) => folder.systemRole === 'inbox' || (!folder.parentId && folder.name === '待整理')
export const findInboxFolder = (folders: SourceFolder[]) => folders.find(isInboxFolder)
export interface KnowledgeSourceSnapshot {
  papers: SourcePaper[]; folders: SourceFolder[]; sources: SourceDefinition[]
  jobs: SourceJob[]; documents: SourceDocument[]
  changes?: InformationEvent[]; resources?: Record<string, unknown>; refreshedAt?: string; undoToken?: string; catalogRevision: number; canManage: boolean; canOrganize: boolean; starred: string[]
  integration: { status: string; message: string; kbUrl?: string }
  libraryV3?: boolean; libraryTotal?: number; folderCounts?: Record<string, number>; tags?: {id:string;name:string;color?:string}[]; canEdit?:boolean
}

// Portal cookie only: never copy a Core credential or use the PM auth store.
const client = axios.create({ baseURL: API_BASE + '/knowledge-sources', withCredentials: true, timeout: 30000 })
client.interceptors.response.use(response => response, error => {
  if (error.response?.status === 401) window.dispatchEvent(new Event('portal:unauthorized'))
  return Promise.reject(error)
})
export const getKnowledgeSources = (signal?: AbortSignal) => client.get('/snapshot', { signal, params: { summary: true } }).then(r => camelize<KnowledgeSourceSnapshot>(r.data))
export const getKnowledgeSourceJobs = () => client.get('/jobs/status').then(r => camelize<{ jobs: SourceJob[]; refreshedAt: string }>(r.data))
export const mutateKnowledgeSources = (method: 'post' | 'patch', path: string, value: unknown) => client.request({ method, url: path, data: snakeize(value), ...(path === '/folders/inbox' ? { timeout: 60000 } : {}) }).then(r => camelize(r.data))
export function sourceError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const detail = error.response?.data?.detail
    const message = typeof detail === 'string' ? detail : detail && typeof detail === 'object' ? detail.message : undefined
    if (typeof message === 'string' && message.trim() && message.length <= 1000 && !/<[!/a-z][^>]*>/i.test(message) && !/(?:Traceback\b|(?:^|\n)\s*(?:File ".+?", line \d+|at \S+))/m.test(message)) return message
    const status = error.response?.status
    if (status === 413) return '请求内容过大，请减少本次提交的内容后重试。'
    if (status === 409) return '资料或任务状态已更新，请刷新后重试。'
    if (status === 403) return '当前账号没有此操作权限，请检查知识库角色。'
    if (status === 429) return '来源请求过于频繁，请稍后重试。'
    if (status === 422) return '操作参数未通过校验，请检查选择数量与设置。'
    if (status === 408 || status === 504 || error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') return '响应超时，已加载资料仍保留，请核对保存结果后重试。'
    if (status === 502 || status === 503) return '知识源或知识库服务暂不可用，请稍后重试。'
    if (status !== undefined && status >= 500) return '知识源服务处理失败，请稍后重试。'
    return '暂时无法连接知识源，已加载资料仍保留，请重试连接。'
  }
  return '暂时无法完成操作，请刷新后重试。'
}

export interface ReferenceOrigin { originApp: 'solutions' | 'assistant'; originId: string; answerId: string }
export interface ImportedReference { sourceId: string; documentId: string; folderId: string | null; category: string; jobId?: string; alreadyImported: boolean; canDownload: boolean; status: 'imported' | 'queued' | 'saved' }
export const importKnowledgeReference = (input: ReferenceOrigin & { referenceId: string; download: boolean }) => client.post('/references', snakeize(input)).then(r => camelize<ImportedReference>(r.data))
