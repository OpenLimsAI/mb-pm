export const SCOPE_NAMES: Record<string, string> = {
  Q: '质量',
  S: '安全性',
  E: '有效性',
  M: '多学科',
}

export interface SourceScopeStatus {
  status: string
  count?: number
  lastSuccessAt?: string | null
  error?: string | null
  url?: string
}

export interface SourceVersionSummary {
  id: string
  sha256: string
  size: number
  createdAt: string
  archiveUrl?: string
  originalUrl?: string
  parseStatus: string
  indexStatus: string
  kbUrl?: string
  error?: string | null
}

export interface SourcePaper {
  id: string
  title: string
  code?: string
  sourceId?: string
  sourceName?: string
  folderIds: string[]
  kbUrl?: string
  originalUrl?: string
  saved: boolean
  indexStatus: string
  size?: number
  createdAt?: string
  type?: string
  language?: string
  error?: string | null
  documentId?: string
  versionId?: string
  parseStatus?: string
  officialDate?: string
  officialStatus?: string
  versionStatus?: string
  sourceUrl?: string
  latest?: boolean
}

export interface SourceDocument {
  id: string
  sourceId: string
  title: string
  url: string
  scopes: string[]
  folderIds: string[]
  format: string
  language: string
  documentType: string
  officialStatus?: string
  officialDate?: string
  discoveredAt: string
  status: string
  versions: SourceVersionSummary[]
  error?: string | null
  isNew?: boolean
  unread?: boolean
  versionStatus?: 'not_saved' | 'unverified' | 'current' | 'update_available'
  verifiedAt?: string
  downloadStatus?: 'not_requested' | 'available' | 'unavailable' | 'failed'
  downloadErrorCode?: string
  currentVersionId?: string
  verifiedSha256?: string
}

export interface SourceDefinition {
  id: string
  name: string
  url: string
  scopes: string[]
  folderId: string | null
  frequency: string
  enabled: boolean
  adapter: string
  status: string
  lastCheckedAt?: string | null
  lastSuccessAt?: string | null
  error?: string | null
  scopeStatus: Record<string, SourceScopeStatus>
  archiveFolderId?: string
  schedule?: {
    frequency: 'off' | 'daily' | 'weekly'
    downloadUpdates: boolean
    indexUpdates: boolean
    nextCheckAt?: string
  }
}

export interface SourceEvent {
  id: string
  title: string
  kind: string
  createdAt: string
  sourceId: string
  documentId?: string | null
  read: boolean
  summary?: string
  before?: string
  after?: string
}

export interface SourceJobItem {
  documentId: string
  status: string
  error?: string | null
  versionId?: string | null
  phase?: string
  failurePhase?: string
  result?: string
  scope?: string
  errorCode?: string
  retryable?: boolean
}

export interface SourceJob {
  id: string
  sourceId: string
  folderId: string
  parse: boolean
  status: string
  createdAt: string
  updatedAt: string
  total: number
  processed: number
  saved: number
  failed: number
  pending: number
  items: SourceJobItem[]
  error?: string | null
  kind?: string
  app?: string
  summary?: Record<string, number>
  canUndoRuleFiling?: boolean
  ruleFiling?: {
    status: string
    ruleApplications?: number
    undoTokens?: string[]
    error?: string
  }
}

export interface SourceFolder {
  id: string
  name: string
  writable?: boolean
  kind?: 'topic' | 'source'
  parentId?: string | null
  systemRole?: 'inbox'
}

export interface KnowledgeSourceSnapshot {
  papers: SourcePaper[]
  folders: SourceFolder[]
  sources: SourceDefinition[]
  jobs: SourceJob[]
  documents: SourceDocument[]
  changes?: SourceEvent[]
  resources?: Record<string, unknown>
  refreshedAt?: string
  undoToken?: string
  catalogRevision: number
  canManage: boolean
  canOrganize: boolean
  starred: string[]
  integration: { status: string; message: string; kbUrl?: string }
  libraryV3?: boolean
  libraryTotal?: number
  folderCounts?: Record<string, number>
  tags?: { id: string; name: string; color?: string }[]
  canEdit?: boolean
}

export interface ReferenceOrigin {
  originApp: 'solutions' | 'assistant'
  originId: string
  answerId: string
}

export interface ImportedReference {
  sourceId: string
  documentId: string
  folderId: string | null
  category: string
  jobId?: string
  alreadyImported: boolean
  canDownload: boolean
  status: 'imported' | 'queued' | 'saved'
}

export const isInboxFolder = (folder: SourceFolder) =>
  folder.systemRole === 'inbox' || (!folder.parentId && folder.name === '待整理')

export const findInboxFolder = (folders: SourceFolder[]) => folders.find(isInboxFolder)

export const formatKnowledgeDate = (v?: string | null) =>
  v && Number.isFinite(Date.parse(v))
    ? new Date(v).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '未提供'
