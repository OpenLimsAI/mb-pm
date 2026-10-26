// Projects API
import { api } from './client'
import type {
  Page, ProjectCreateRequest, ProjectDTO, ProjectUpdateRequest,
  SubProjectDTO, TaskDTO, TaskDependencyDTO,
} from './types'

/** 整包创建：项目 + 子项目 + 任务 + 依赖 + 财务（前端模板实例化结果）。 */
export interface ProjectImportPayload {
  project: ProjectCreateRequest
  subProjects: SubProjectDTO[]
  tasks: TaskDTO[]
  dependencies: TaskDependencyDTO[]
  finance?: {
    projectId: string
    totalBudget: number
    spent: number
    committed: number
    breakdown: Record<string, number>
    fiscalYear?: string | null
    notes?: string | null
  }
}

export async function importProject(payload: ProjectImportPayload): Promise<ProjectDTO> {
  const { data } = await api.post<ProjectDTO>('/projects/import', payload)
  return data
}

export interface ProjectsListParams {
  page?: number
  pageSize?: number
  status?: string
  health?: string
  keyword?: string
}

/** 复制项目：以已有项目为蓝本新建（结构与计划照搬，执行数据重置；规则见后端 services/project_copy.py）。 */
export interface ProjectCopyRequest {
  code: string
  name: string
  /** 缺省沿用原项目负责人 */
  ownerId?: string
  /** 新的计划开始；与原项目不同则全部计划日期按同样天数平移 */
  plannedStart?: string
}

export async function copyProject(sourceId: string, payload: ProjectCopyRequest): Promise<ProjectDTO> {
  const { data } = await api.post<ProjectDTO>(`/projects/${encodeURIComponent(sourceId)}/copy`, payload)
  return data
}

export async function listProjects(params: ProjectsListParams = {}): Promise<Page<ProjectDTO>> {
  const { data } = await api.get<Page<ProjectDTO>>('/projects', { params })
  return data
}

export async function getProjectMDMLaunchUrl(id: string): Promise<string> {
  const { data } = await api.get<{ url: string }>(`/projects/${encodeURIComponent(id)}/mdm-launch`)
  return data.url
}

export async function getProject(id: string): Promise<ProjectDTO> {
  const { data } = await api.get<ProjectDTO>(`/projects/${id}`)
  return data
}

export async function createProject(payload: ProjectCreateRequest): Promise<ProjectDTO> {
  const { data } = await api.post<ProjectDTO>('/projects', payload)
  return data
}

export async function updateProject(id: string, payload: ProjectUpdateRequest): Promise<ProjectDTO> {
  const { data } = await api.patch<ProjectDTO>(`/projects/${id}`, payload)
  return data
}

export async function deleteProject(id: string): Promise<void> {
  await api.delete(`/projects/${id}`)
}

export async function replaceProjectMembers(id: string, memberIds: string[]): Promise<ProjectDTO> {
  const { data } = await api.put<ProjectDTO>(`/projects/${id}/members`, memberIds)
  return data
}
