// TaskDependencies API — FS/SS/FF/SF + lag
import { api } from './client'
import type { TaskDependencyDTO } from './types'

export interface TaskDependenciesListParams {
  projectId?: string
  taskId?: string
}

export async function listTaskDependencies(
  params: TaskDependenciesListParams = {},
): Promise<TaskDependencyDTO[]> {
  const { data } = await api.get<TaskDependencyDTO[]>('/task-dependencies', { params })
  return data
}

export interface TaskDependencyCreateRequest {
  id?: string
  predecessorId: string
  successorId: string
  type?: 'FS' | 'SS' | 'FF' | 'SF'
  lagDays?: number
}

export async function createTaskDependency(
  payload: TaskDependencyCreateRequest,
): Promise<TaskDependencyDTO> {
  const { data } = await api.post<TaskDependencyDTO>('/task-dependencies', {
    type: 'FS',
    lagDays: 0,
    ...payload,
  })
  return data
}

export async function deleteTaskDependency(id: string): Promise<void> {
  await api.delete(`/task-dependencies/${id}`)
}
