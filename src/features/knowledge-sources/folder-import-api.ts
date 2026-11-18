import axios from 'axios'
import { API_BASE, camelize, snakeize } from '../../api/client'

export interface FolderImportSchedule {
  frequency: 'daily' | 'weekly' | 'manual'
  time: string
  timezone: string
  weekday: number
}
export interface FolderImportConfig {
  name: string
  kind: 'local' | 'server'
  serverRootId?: string
  path: string
  folderId: string
  includeSubfolders: boolean
  preserveHierarchy: boolean
  schedule: FolderImportSchedule
  maxFileMb: number
  maxFilesPerScan: number
  dailyFileLimit: number
}
export interface FolderImportTask extends FolderImportConfig {
  id: string
  folderName?: string
  sourcePath?: string
  paused: boolean
  status: 'idle' | 'queued' | 'scanning' | 'transferring' | 'processing' | 'offline' | 'paused' | 'needs_attention' | 'waiting_quota'
  nextScanAt?: string | null
  lastScanAt?: string | null
  lastResult?: { new: number; updated: number; unchanged: number; failed: number; completed: number }
  lastError?: string | null
  connectorOnline?: boolean
  nextRetryAt?: string | null
  usage?: { date: string; timezone: string; completedFiles: number; limit: number; remainingFiles: number; originalBytes: number; parsedPages: number; parsedCharacters: number; indexedFiles: number; reusedFiles: number; unknownParsedPages?: number }
}
export interface FolderImportBootstrap {
  tasks: FolderImportTask[]
  roots: { id: string; name: string; path?: string }[]
  canWrite: boolean
  workerEnabled: boolean
  maxFileMb: number
  connectorOnlineSeconds: number
}
export interface FolderImportProbe { valid: boolean; fileCount: number | null; totalBytes: number | null; message?: string; sourcePath?: string; truncated?: boolean; errors?: { relativePath: string; error: string }[] }
export interface FolderImportRun {
  id: string; taskId: string; status: string; phase: string; createdAt: string; finishedAt?: string | null
  total: number; processed: number; completed: number; failed: number; new: number; updated: number; unchanged: number; initial?: boolean; error?: string | null
}
export interface FolderImportItem {
  id: string; relativePath: string; size: number; sha256?: string; status: string; phase: string
  error?: string | null; paperId?: string; originalSaved: boolean; indexStatus?: string; change: 'new' | 'updated' | 'unchanged'; new?: boolean
}
export interface FolderImportPairing { code: string; expiresAt: string; commandHint?: string }

// The portal session stays in its HttpOnly cookie; pairing codes are never stored here.
const client = axios.create({ baseURL: `${API_BASE}/knowledge-sources/v3/folder-imports`, withCredentials: true, timeout: 30000 })
export const folderConnectorScriptUrl = `${API_BASE}/knowledge-sources/v3/folder-imports/connector/script`
client.interceptors.response.use(response => response, error => {
  if (error.response?.status === 401) window.dispatchEvent(new Event('portal:unauthorized'))
  return Promise.reject(error)
})
const decoded = <T,>(response: { data: unknown }) => camelize<T>(response.data)
export const getFolderImports = (signal?: AbortSignal) => client.get('/bootstrap', { signal }).then(decoded<FolderImportBootstrap>)
export const probeFolderImport = (config: FolderImportConfig, signal?: AbortSignal) => client.post('/probe', snakeize(config), { signal }).then(decoded<FolderImportProbe>)
export const saveFolderImport = (config: FolderImportConfig, id?: string) => (id ? client.patch(`/tasks/${encodeURIComponent(id)}`, snakeize(config)) : client.post('/tasks', snakeize(config))).then(decoded<{ task: FolderImportTask }>)
export const controlFolderImport = (id: string, action: 'scan' | 'pause' | 'resume' | 'retry') => client.post(`/tasks/${encodeURIComponent(id)}/${action}`, {}).then(decoded<{ task?: FolderImportTask; run?: FolderImportRun }>)
export const deleteFolderImport = (id: string) => client.delete(`/tasks/${encodeURIComponent(id)}`).then(decoded<{ deleted: boolean }>)
export const pairFolderImport = (id: string) => client.post(`/tasks/${encodeURIComponent(id)}/pairing`, {}).then(decoded<FolderImportPairing>)
export const getFolderImportRuns = (id: string, signal?: AbortSignal) => client.get(`/tasks/${encodeURIComponent(id)}/runs`, { signal }).then(decoded<{ runs: FolderImportRun[] }>)
export const getFolderImportRun = (id: string, signal?: AbortSignal) => client.get(`/runs/${encodeURIComponent(id)}`, { signal }).then(decoded<{ run: FolderImportRun; items: FolderImportItem[] }>)
export const retryFolderImportRun = (id: string, itemIds?: string[]) => client.post(`/runs/${encodeURIComponent(id)}/retry`, itemIds ? snakeize({ itemIds }) : {}).then(decoded<unknown>)
export const readFolderImportRun = (id: string) => client.post(`/runs/${encodeURIComponent(id)}/read`, {}).then(decoded<unknown>)
