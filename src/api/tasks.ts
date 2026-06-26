// Tasks / SubProjects / TaskDependencies API
import { api } from './client'
import type {
  Page, SubProjectDTO, TaskDTO, TaskDependencyDTO, TaskUpdateRequest,
} from './types'

// ============= Tasks =============

export interface TasksListParams {
  page?: number
  pageSize?: number
  projectId?: string
  subProjectId?: string
  status?: string
  ownerId?: string
  isMilestone?: boolean
  isCriticalPath?: boolean
  keyword?: string
}

export async function listTasks(params: TasksListParams = {}): Promise<Page<TaskDTO>> {
  const { data } = await api.get<Page<TaskDTO>>('/tasks', { params })
  return data
}

export async function getTask(id: string): Promise<TaskDTO> {
  const { data } = await api.get<TaskDTO>(`/tasks/${id}`)
  return data
}

/** 创建任务（含里程碑 isMilestone=true）。后端要求 TaskBase 全字段。 */
export type TaskCreateRequest =
  Omit<TaskDTO, 'id'> & { id?: string }

export async function createTask(payload: TaskCreateRequest): Promise<TaskDTO> {
  const { data } = await api.post<TaskDTO>('/tasks', payload)
  return data
}

export async function updateTask(id: string, payload: TaskUpdateRequest): Promise<TaskDTO> {
  const { data } = await api.patch<TaskDTO>(`/tasks/${id}`, payload)
  return data
}

export async function deleteTask(id: string): Promise<void> {
  await api.delete(`/tasks/${id}`)
}

// ============= SubProjects =============

export async function listSubProjects(projectId?: string): Promise<SubProjectDTO[]> {
  const { data } = await api.get<SubProjectDTO[]>('/sub-projects', {
    params: projectId ? { projectId } : {},
  })
  return data
}

// ============= TaskDependencies =============

export async function listDependencies(projectId?: string): Promise<TaskDependencyDTO[]> {
  const { data } = await api.get<TaskDependencyDTO[]>('/task-dependencies', {
    params: projectId ? { projectId } : {},
  })
  return data
}
