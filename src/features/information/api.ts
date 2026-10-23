export const SCOPE_NAMES: Record<string, string> = { Q: '质量', S: '安全性', E: '有效性', M: '多学科' }
export interface InformationScope { status: string; count?: number; lastSuccessAt?: string | null; error?: string | null; url?: string }
export interface InformationSource {
  id: string; name: string; url: string; scopes: string[]; folderId: string | null; frequency: string; enabled: boolean
  adapter: string; status: string; lastCheckedAt?: string | null; lastSuccessAt?: string | null; error?: string | null
  scopeStatus: Record<string, InformationScope>
}
export interface InformationVersion { id: string; sha256: string; size: number; createdAt: string; archiveUrl?: string; parseStatus: string; indexStatus: string; error?: string | null }
export interface InformationDocument { id: string; sourceId: string; title: string; url: string; scopes: string[]; folderIds: string[]; format: string; language: string; documentType: string; discoveredAt: string; status: string; versions: InformationVersion[]; error?: string | null }
export interface InformationEvent { id: string; title: string; kind: string; createdAt: string; sourceId: string; documentId?: string | null; read: boolean; summary?: string; before?: string; after?: string }
export interface InformationRun { id: string; sourceId: string; kind: string; status: string; startedAt: string; finishedAt?: string | null; error?: string | null; details?: { jobId?: string; scopeStatus?: Record<string, InformationScope> } }
export interface InformationJob { id: string; sourceId: string; folderId: string; parse: boolean; status: string; createdAt: string; updatedAt: string; total: number; processed: number; saved: number; failed: number; pending: number; items: { documentId: string; status: string; error?: string | null; versionId?: string | null }[]; error?: string | null }
export interface InformationFolder { id: string; name: string; url: string; writable: boolean }
export interface InformationSnapshot {
  user: { id: string; username: string; displayName: string }; canManage: boolean; sources: InformationSource[]
  documents: InformationDocument[]; events: InformationEvent[]; runs: InformationRun[]; jobs: InformationJob[]; folders: InformationFolder[]; follows: string[]
  integration: { status: string; message: string; kbUrl: string }; cost: { modelCalls: number; message: string }
  later: string[]; note: string; digest: string; minor: boolean
}
