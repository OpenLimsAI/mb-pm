// SubProjects API — Level 2 WBS
import { api } from './client'
import type { SubProjectDTO } from './types'

export interface SubProjectsListParams {
  projectId?: string
  module?: string
}

export async function listSubProjects(params: SubProjectsListParams = {}): Promise<SubProjectDTO[]> {
  const { data } = await api.get<SubProjectDTO[]>('/sub-projects', { params })
  return data
}

export async function updateSubProject(
  id: string,
  payload: Partial<Pick<SubProjectDTO, 'name' | 'ownerId' | 'status' | 'progress' | 'sortOrder'>>,
): Promise<SubProjectDTO> {
  const { data } = await api.patch<SubProjectDTO>(`/sub-projects/${id}`, payload)
  return data
}
