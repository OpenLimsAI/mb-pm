export interface BackupArchive {
  id: string; name: string; rootId?: string; rootLabel: string; createdAt: string | null; sizeBytes: number; diskBytes: number
  status: 'verified' | 'pending' | 'unreadable' | 'unknown'
  contents: { name: string; kind: 'database' | 'files' | 'configuration'; detail: string }[]
  verifiedAt: string | null; protected: boolean; protectionReason: string | null
}
export interface DeletionReceipt { id: string; actor: string; createdAt: string | null; status: string; deletedCount: number; deletedBytes: number; error?: string | null }
export interface DeletePreview { token: string; itemCount: number; sizeBytes: number; diskBytes: number; items: Pick<BackupArchive, 'id' | 'name' | 'rootId' | 'rootLabel' | 'sizeBytes' | 'diskBytes'>[]; expiresAt: string }
export interface DeleteRequest { token: string; confirmation: string; requestId: string }
export interface BackupPlan {
  status: 'active' | 'disabled' | 'unknown' | 'conflict'; source: string; timezone: string; summary: string; retentionSummary: string; checkedAt: string | null
  editable?: boolean; dailyTime?: string | null; revision?: string | null; nextRunAt?: string | null; editReason?: string
}
export interface PlanRequest { dailyTime: string; enabled: boolean; revision: string }
export interface BackupSnapshot {
  connected: boolean; generatedAt: string | null; catalogRevision: string
  plan: BackupPlan
  storage: { totalBytes: number | null; freeBytes: number | null; backupBytes: number | null; archiveBytes: number | null; otherBytes: number | null }
  roots: { id: string; label: string; archiveCount: number; sizeBytes: number; diskBytes: number; otherBytes: number }[]
  archives: BackupArchive[]; deletions: DeletionReceipt[]; alerts: string[]
}
export class BackupApiError extends Error {
  status: number
  code: string
  constructor(status: number, message: string, code = '') { super(message); this.status = status; this.code = code }
}
export function accessLost(error: unknown) { return error instanceof BackupApiError && ([401, 403].includes(error.status) || (error.status === 409 && error.code === 'backup_identity_changed')) }
async function request<T>(identity: string, path: string, init: RequestInit, signal: AbortSignal): Promise<T> {
  const response = await fetch(`/api/v1/data-backup${path}`, {
    ...init, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
    headers: { 'Content-Type': 'application/json', 'X-Backup-Expected-Identity': identity },
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const detail = typeof body?.detail === 'object' ? body.detail : body?.error
    const message = typeof body?.detail === 'string' ? body.detail : detail?.message
    throw new BackupApiError(response.status,
      response.status === 401 ? '登录已失效，请重新登录后查看备份。' : response.status === 403 ? '当前账号没有数据备份权限，请返回工作台刷新身份。' :
      typeof message === 'string' && message.length <= 1200 ? message : '备份服务暂时无法完成请求，请稍后重试。', detail?.code || body?.code || '')
  }
  if (!body || typeof body !== 'object') throw new BackupApiError(502, '备份服务返回了无效数据，请重新读取。')
  return body as T
}
export const backupApi = {
  async snapshot(identity: string, signal: AbortSignal): Promise<BackupSnapshot> {
    const result = await request<BackupSnapshot>(identity, '/snapshot', {}, signal)
    if (typeof result.connected !== 'boolean' || typeof result.catalogRevision !== 'string' || !result.storage || !result.plan || !Array.isArray(result.roots) || !Array.isArray(result.archives) || !Array.isArray(result.deletions) || !Array.isArray(result.alerts)) throw new BackupApiError(502, '备份状态不完整，暂时无法确认数据保护情况。')
    return result
  },
  async previewDeletion(identity: string, archiveIds: string[], catalogRevision: string, signal: AbortSignal): Promise<DeletePreview> {
    const result = await request<DeletePreview>(identity, '/delete-preview', { method: 'POST', body: JSON.stringify({ archiveIds, catalogRevision }) }, signal)
    if (!result.token || !Array.isArray(result.items) || result.itemCount !== archiveIds.length || result.items.length !== archiveIds.length || new Set(result.items.map(item => item.id)).size !== archiveIds.length || result.items.some(item => !archiveIds.includes(item.id)) || !Number.isFinite(Date.parse(result.expiresAt))) throw new BackupApiError(502, '删除预览与所选文件不一致，请刷新后重新选择。')
    return result
  },
  deleteArchives: (identity: string, body: DeleteRequest, signal: AbortSignal) => request<DeletionReceipt>(identity, '/deletions', { method: 'POST', body: JSON.stringify(body) }, signal),
  async updatePlan(identity: string, body: PlanRequest, signal: AbortSignal): Promise<BackupPlan> {
    const result = await request<BackupPlan>(identity, '/plan', { method: 'POST', body: JSON.stringify(body) }, signal)
    if (!['active', 'disabled'].includes(result.status) || typeof result.summary !== 'string' || typeof result.timezone !== 'string' || typeof result.revision !== 'string' || !/^[a-f0-9]{64}$/.test(result.revision) || result.dailyTime !== body.dailyTime || (result.status === 'active') !== body.enabled) throw new BackupApiError(502, '备份计划保存结果尚未确认，请重新读取状态。')
    return result
  },
}
export const previewSnapshot: BackupSnapshot = {
  connected: false, generatedAt: '', catalogRevision: 'preview',
  storage: { totalBytes: null, freeBytes: null, backupBytes: null, archiveBytes: null, otherBytes: null },
  plan: { status: 'unknown', source: 'cron', timezone: '', summary: '预览未读取服务器的实际备份计划。', retentionSummary: '实际保留规则将在连接服务器后显示。', checkedAt: '' },
  roots: [
    { id: 'example-business', label: '示例 · 完整业务备份', archiveCount: 2, sizeBytes: 520093696, diskBytes: 520093696, otherBytes: 0 },
    { id: 'example-config', label: '示例 · 配置备份', archiveCount: 0, sizeBytes: 0, diskBytes: 0, otherBytes: 0 },
  ],
  archives: [
    { id: 'example-1', name: '示例 · 完整业务备份 A', rootId: 'example-business', rootLabel: '示例 · 完整业务备份', createdAt: '', sizeBytes: 268435456, diskBytes: 268435456, status: 'verified', contents: [{ name: '项目管理数据库', kind: 'database', detail: '仅展示清单样式，不代表实际备份内容。' }, { name: '知识库文件', kind: 'files', detail: '示例文件清单。' }], verifiedAt: null, protected: true, protectionReason: '示例：最近一份已验证备份受保护。' },
    { id: 'example-2', name: '示例 · 完整业务备份 B', rootId: 'example-business', rootLabel: '示例 · 完整业务备份', createdAt: '', sizeBytes: 251658240, diskBytes: 251658240, status: 'unknown', contents: [], verifiedAt: null, protected: false, protectionReason: null },
  ], deletions: [], alerts: [],
}
