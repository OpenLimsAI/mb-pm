import { api, asAPIError } from './client'

export interface RegisterEntry {
  id: string; projectId: string; kind: 'risk' | 'issue' | 'decision'; title: string; ownerId: string
  dueDate: string; severity: 'high' | 'medium' | 'low'; status: 'open' | 'closed'; mitigation: string
  closure: string; revision: number; updatedAt: string
}
export type RegisterDraft = Omit<RegisterEntry, 'id' | 'projectId' | 'revision' | 'updatedAt'> & { expectedRevision?: number }
export interface CostEntry {
  id: string; projectId: string; kind: 'actual' | 'payment' | 'remaining'; title: string; category: string
  taskId: string | null; amount: number; occurredOn: string; evidenceUrl: string; notes: string; voided: boolean; voidReason: string; revision: number
}
export type CostDraft = Omit<CostEntry, 'id' | 'projectId' | 'revision'> & { expectedRevision?: number }
export interface CostSummary { items: CostEntry[]; spent: number; recordedActual: number; unreconciled: number; payments: number; remaining: number; forecast: number; budget: number | null }
export interface QualityItem { id: string; taskId: string; title: string; reason: string; ownerId: string; url: string }
export interface ChangeItem { id: string; createdAt: string; actorId: string; action: string; title: string; taskId: string | null; detail: string; changes: Record<string, unknown> }
export interface ChangeSummary { from: string; to: string; items: ChangeItem[]; truncated: boolean; summary?: { completed: number; blocked: number; delayed: number } }
export type NotificationMode = 'immediate' | 'daily' | 'paused'
export interface NotificationItem { key: string; taskId: string; projectId: string; kind: 'assignment' | 'due' | 'attention' | 'mention' | 'acceptance'; title: string; detail: string; url: string; createdAt: string; read: boolean }
export interface NotificationSummary { mode: NotificationMode; asOf: string; unread: number; badgeCount: number; digestKeys: string[]; items: NotificationItem[]; truncated: boolean }
const path = (id: string) => `/pm/projects/${encodeURIComponent(id)}`
export const pmManagement = {
  register: async (id: string) => (await api.get<RegisterEntry[]>(`${path(id)}/register`)).data,
  saveRegister: async (id: string, value: RegisterDraft, entryId?: string) => (await (entryId ? api.put<RegisterEntry>(`${path(id)}/register/${encodeURIComponent(entryId)}`, value) : api.post<RegisterEntry>(`${path(id)}/register`, value))).data,
  costs: async (id: string) => (await api.get<CostSummary>(`${path(id)}/costs`)).data,
  saveCost: async (id: string, value: CostDraft, entryId?: string) => (await (entryId ? api.put<CostEntry>(`${path(id)}/costs/${encodeURIComponent(entryId)}`, value) : api.post<CostEntry>(`${path(id)}/costs`, value))).data,
  quality: async (id: string) => (await api.get<{ asOf: string; items: QualityItem[] }>(`${path(id)}/quality`)).data,
  changes: async (id: string, days: number) => (await api.get<ChangeSummary>(`${path(id)}/changes`, { params: { days } })).data,
  notifications: async () => (await api.get<NotificationSummary>('/pm/notifications')).data,
  notificationMode: async (mode: NotificationMode) => (await api.put('/pm/notifications/preferences', { mode })).data,
  notificationState: async (eventKeys: string[], action: 'read' | 'unread' | 'snooze', hours = 24) => (await api.post('/pm/notifications/state', { eventKeys, action, hours })).data,
}
export function managementError(error: unknown): string {
  const { detail } = asAPIError(error)
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) return (detail as { msg?: string }[]).map(item => item.msg || '输入有误').join('；')
  return '操作失败，请重试。'
}
