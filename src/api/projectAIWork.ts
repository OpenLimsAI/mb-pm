import { api } from './client'
import type { AIAnalysis } from './ai'
import type { SchedulePreview } from './planning'

export interface AnalysisJob {
  id: string; state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  focus: string; createdAt: string; analysisId?: string; error: string
}
export interface ActionDraft {
  actionKey: string; kind: 'task' | 'risk' | 'schedule'; title: string; reason: string
  ownerId?: string; subProjectId?: string; taskId?: string
  plannedStart?: string; plannedEnd?: string; dueDate?: string
  severity?: 'high' | 'medium' | 'low'; lockedIds?: string[]
}
export interface ActionResult { kind: string; targetId: string; replayed: boolean; changes: Record<string, unknown>[] }
export interface ActionPreview {
  fingerprint: string; reportStale: boolean; changes: Record<string, unknown>[]
}
export interface ReportActions {
  proposals: Partial<ActionDraft>[]
  applied: { actionKey: string; createdAt: string; draft: ActionDraft; result: ActionResult }[]
}
export interface ScheduleAssistPreview {
  delayWorkdays: number
  lockedMilestones: { taskId: string; name: string; code: string; startDate: string; date: string }[]
  schedule: SchedulePreview
  confirmationToken: string | null
  expiresAt: string | null
}
export interface ScheduleAssistReceipt {
  receiptId: string
  replayed: boolean
  schedule: SchedulePreview
}
const path = (id: string) => `/project-ai/projects/${encodeURIComponent(id)}`
const reportPath = (id: string, report: string) => `${path(id)}/reports/${encodeURIComponent(report)}/actions`
export const listAnalysisJobs = async (id: string) => (await api.get<AnalysisJob[]>(`${path(id)}/jobs`)).data
export const startProjectAnalysis = async (id: string, focus: string, prompt: string) => (await api.post<AnalysisJob>(`${path(id)}/jobs`, { focus, prompt })).data
export const cancelProjectAnalysis = async (id: string, job: string) => (await api.post<AnalysisJob>(`${path(id)}/jobs/${encodeURIComponent(job)}/cancel`)).data
export const searchProjectAnalyses = async (id: string, keyword: string, page: number) => (await api.get<{ total: number; page: number; items: AIAnalysis[] }>(`${path(id)}/history`, { params: { keyword, page } })).data
export const getProjectAnalysis = async (id: string, report: string) => (await api.get<AIAnalysis>(`${path(id)}/reports/${encodeURIComponent(report)}`)).data
export const getReportActions = async (id: string, report: string) => (await api.get<ReportActions>(reportPath(id, report))).data
export const previewReportAction = async (id: string, report: string, draft: ActionDraft) => (await api.post<ActionPreview>(`${reportPath(id, report)}/preview`, { draft })).data
export const applyReportAction = async (id: string, report: string, draft: ActionDraft, fingerprint: string) => (await api.post<ActionResult>(`${reportPath(id, report)}/apply`, { draft, fingerprint })).data
export const previewScheduleAssist = async (id: string, taskId: string, instruction: string, signal: AbortSignal) =>
  (await api.post<ScheduleAssistPreview>(`${path(id)}/schedule-assist/preview`, { taskId, instruction }, { signal, timeout: 30_000 })).data
export const applyScheduleAssist = async (id: string, confirmationToken: string, reason: string) =>
  (await api.post<ScheduleAssistReceipt>(`${path(id)}/schedule-assist/apply`, { confirmationToken, reason })).data
