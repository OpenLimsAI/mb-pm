import axios from 'axios'
import { api, API_BASE } from './client'
import type { Task } from '../types'

export interface TaskActivity {
  id: string; actorId: string; kind: string; body: string
  changes: Record<string, { before: unknown; after: unknown }>
  mentionIds: string[]; createdAt: string
}
export interface TaskDeliverable {
  id: string; authorId: string; title: string; version: number
  filename: string | null; link: string | null; notes: string; createdAt: string
}
export interface TaskAcceptance {
  reviewerId: string; requiredCount: number; state: 'draft' | 'submitted' | 'accepted' | 'rejected'
  comment: string; updatedAt: string; submittedDeliverableIds: string[]
}
export interface TaskCollaboration {
  nextActivityCursor?: string | null
  activities: TaskActivity[]; deliverables: TaskDeliverable[]; acceptance: TaskAcceptance | null
}
const path = (id: string) => `/tasks/${encodeURIComponent(id)}`
export const getTaskCollaboration = async (id: string) => (await api.get<TaskCollaboration>(`${path(id)}/collaboration`)).data
export const getOlderTaskActivities = async (id: string, before: string) => (await api.get<Pick<TaskCollaboration, 'activities' | 'nextActivityCursor'>>(`${path(id)}/activities`, { params: { before } })).data
export const addTaskComment = async (id: string, body: string, mentionIds: string[]) => api.post(`${path(id)}/comments`, { body, mentionIds })
export const addTaskLink = async (id: string, title: string, link: string, notes: string) => api.post(`${path(id)}/deliverables/link`, { title, link, notes })
export const uploadTaskFile = async (id: string, title: string, notes: string, file: File) => {
  const form = new FormData()
  form.append('title', title); form.append('notes', notes); form.append('file', file)
  return api.post(`${path(id)}/deliverables/file`, form, { timeout: 60000 })
}
export const taskFileUrl = (taskId: string, id: string) => `${API_BASE}${path(taskId)}/deliverables/${encodeURIComponent(id)}/download`
export const configureTaskAcceptance = async (id: string, reviewerId: string, requiredCount: number) => api.put(`${path(id)}/acceptance`, { reviewerId, requiredCount })
export const taskAcceptanceAction = async (id: string, action: 'submit' | 'accept' | 'reject', comment: string) => api.post(`${path(id)}/acceptance/actions`, { action, comment })

export function taskRequestError(error: unknown): { message: string; current?: Task } {
  if (axios.isAxiosError(error)) {
    const detail = error.response?.data?.detail
    if (typeof detail === 'string') return { message: detail }
    if (detail && typeof detail.message === 'string') {
      const current = detail.current as Task | undefined
      if (current) {
        for (const key of ['estimatedEffort', 'actualEffort', 'actualCost', 'costBudget'] as const) {
          const value = current[key]
          if (value !== null && value !== undefined) current[key] = Number(value)
        }
      }
      return { message: detail.message, current }
    }
    if (Array.isArray(detail)) return { message: detail.map(x => x.msg || '输入无效').join('；') }
    return { message: error.response ? '保存失败，请稍后重试。' : '网络连接失败，草稿已保留，请重试。' }
  }
  return { message: error instanceof Error ? error.message : '操作失败，草稿已保留，请重试。' }
}
