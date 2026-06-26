// ProjectBaselines API —— 计划基线快照与版本对标。
import { api } from './client'
import type { ProjectBaseline } from '../types'

export async function listBaselines(): Promise<ProjectBaseline[]> {
  const { data } = await api.get<ProjectBaseline[]>('/baselines')
  return data
}

export interface BaselineCreateRequest {
  projectId: string
  label: string
  reason?: string | null
}

export async function createBaseline(payload: BaselineCreateRequest): Promise<ProjectBaseline> {
  const { data } = await api.post<ProjectBaseline>('/baselines', payload)
  return data
}

export async function deleteBaseline(id: string): Promise<void> {
  await api.delete(`/baselines/${id}`)
}
