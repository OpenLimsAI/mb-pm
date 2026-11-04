import { api } from './client'

export type ProgressMethod = 'equal' | 'effort' | 'custom'
export interface ProgressPolicyRequest {
  method: ProgressMethod
  weights: { taskId: string; value: number | null }[]
  fingerprint?: string
  reason?: string
}
export interface ProgressPolicyRow {
  taskId: string; subProjectId: string; name: string; code: string; progress: number
  isMilestone: boolean; estimatedEffort: number; customWeight: number | null
  effectiveWeight: number; share: number; contribution: number
}
export interface ProgressPolicyResult {
  projectId: string; method: ProgressMethod; currentMethod: ProgressMethod
  beforeProgress: number; progress: number; exactProgress: number; numerator: number; denominator: number
  fingerprint: string; changed: boolean; editable?: boolean; hiddenTaskCount?: number
  rows: ProgressPolicyRow[]
  subprojects: { id: string; name: string; progress: number; numerator: number; denominator: number }[]
  rules: Record<ProgressMethod | 'formula', string>
}
const path = (id: string) => `/projects/${encodeURIComponent(id)}/progress-policy`
export const progressPolicyApi = {
  get: async (id: string) => (await api.get<ProgressPolicyResult>(path(id))).data,
  preview: async (id: string, value: ProgressPolicyRequest) => (await api.post<ProgressPolicyResult>(`${path(id)}/preview`, value)).data,
  save: async (id: string, value: ProgressPolicyRequest) => (await api.put<ProgressPolicyResult>(path(id), value)).data,
}
