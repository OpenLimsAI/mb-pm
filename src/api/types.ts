// API DTO 类型 — 与 cmc-pms-backend/app/schemas/ 1:1 对应
//
// 注意：经过 client.ts 的 camelize 拦截器后，原始 snake_case 字段已变成 camelCase。
// 这些 DTO 大部分能直接复用 src/types.ts 的业务类型，但显式列出便于演化。

import type {
  Health, Priority, ProductType, ProjectStatus, Role, Stage, TaskStatus,
} from '../types'

// ============= 分页 =============

export interface PageMeta {
  page: number
  pageSize: number
  total: number
}

export interface Page<T> {
  items: T[]
  meta: PageMeta
}

// ============= Auth =============

export interface LoginRequest {
  username: string
}

export interface TokenResponse {
  accessToken: string
  tokenType: string
  user: UserDTO
}

// ============= User =============

export interface UserDTO {
  id: string
  username: string
  displayName: string
  email: string
  role: Role
  specialtyGroup: string | null
  weeklyAvailableHours: number
  isActive: boolean
  avatarColor: string | null
}

// ============= Project =============

export interface ProjectDTO {
  id: string
  code: string
  name: string
  productType: ProductType
  currentStage: Stage
  targetStage: Stage
  ownerId: string
  memberIds: string[]
  status: ProjectStatus
  health: Health
  progress: number
  plannedStart: string  // YYYY-MM-DD
  plannedEnd: string
  templateId: string | null
  templateVersion: string | null
  description: string | null
}

export interface ProjectCreateRequest {
  code: string
  name: string
  productType: ProductType
  currentStage: Stage
  targetStage: Stage
  ownerId: string
  memberIds?: string[]
  status: ProjectStatus
  health: Health
  progress?: number
  plannedStart: string
  plannedEnd: string
  templateId?: string | null
  templateVersion?: string | null
  description?: string | null
}

export type ProjectUpdateRequest = Partial<Omit<ProjectCreateRequest, 'code' | 'productType'>>

// ============= SubProject =============

export interface SubProjectDTO {
  id: string
  name: string
  projectId: string
  stage: Stage
  module: string
  ownerId: string | null
  status: TaskStatus
  progress: number
  sortOrder: number
}

// ============= Task =============

export interface TaskDTO {
  id: string
  code: string
  name: string
  subProjectId: string
  ownerId: string
  collaboratorIds: string[] | null
  status: TaskStatus
  priority: Priority
  plannedStart: string
  plannedEnd: string
  actualStart: string | null
  actualEnd: string | null
  estimatedEffort: number
  actualEffort: number | null
  progress: number
  isMilestone: boolean
  isCriticalPath: boolean
  notes: string | null
  tags: string[] | null
}

export type TaskUpdateRequest = Partial<Pick<TaskDTO, 'name' | 'ownerId' | 'collaboratorIds' | 'status' | 'priority' | 'plannedStart' | 'plannedEnd' | 'actualStart' | 'actualEnd' | 'estimatedEffort' | 'actualEffort' | 'progress' | 'isMilestone' | 'isCriticalPath' | 'notes' | 'tags'>>

// ============= TaskDependency =============

export interface TaskDependencyDTO {
  id: string
  predecessorId: string
  successorId: string
  type: 'FS' | 'SS' | 'FF' | 'SF'
  lagDays: number
}

// ============= Template =============

export interface TemplateVersionDTO {
  id: string
  templateId: string
  versionNumber: string
  structureJson: Record<string, unknown>
  changeSummary: string | null
  changeSource: 'visual_edit' | 'excel_import'
  modifiedBy: string | null
  modifiedAt: string  // ISO
  isCurrent: boolean
}

export interface TemplateDTO {
  id: string
  name: string
  productType: ProductType
  currentVersion: string
  description: string | null
  isActive: boolean
  createdBy: string | null
  createdAt: string
  updatedAt: string
  versions: TemplateVersionDTO[]
}

export interface TemplateCreateRequest {
  name: string
  productType: ProductType
  description?: string | null
  isActive?: boolean
  initialStructure: Record<string, unknown>
}

export interface TemplateVersionCreateRequest {
  versionNumber: string
  structureJson: Record<string, unknown>
  changeSummary?: string | null
  changeSource?: 'visual_edit' | 'excel_import'
}

export type ImportLevel = 'format' | 'reference' | 'logic' | 'business'

export interface ImportErrorDTO {
  sheet: string
  row: number | string
  col: string
  level: ImportLevel
  message: string
}

export interface ImportResultDTO {
  success: boolean
  templateId: string | null
  versionId: string | null
  errors: ImportErrorDTO[]
  summary: Record<string, number>
}
