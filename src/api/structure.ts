// 项目结构编辑（编辑模式）API —— 读取结构快照，统一保存编辑后的完整结构（后端一个事务）。
import { api } from './client'
import type { ProjectFinanceDTO, ProjectFinanceInput } from './finances'
import type { TaskStatus } from '../types'

export interface StructureSnapshot {
  finance: ProjectFinanceDTO | null
  version: string
  /** plannedStart / plannedEnd 按任务实时派生 */
  project: { id: string; code: string; name: string; ownerId: string; plannedStart: string; plannedEnd: string }
  subProjects: { id: string; name: string; module: string; stage: string; sortOrder: number; status: TaskStatus; progress: number }[]
  tasks: {
    id: string
    subProjectId: string
    code: string
    name: string
    isMilestone: boolean
    ownerId: string
    plannedStart: string
    plannedEnd: string
    estimatedEffort: number
    costBudget: number | null
    notes: string | null
    status: TaskStatus
    progress: number
    actualCost: number | null
    /** 不能删除的原因：已开始 / 已录实际花费 */
    lockedReason: string | null
    /** 子项目内的手动顺序（老数据可能为空） */
    sortOrder: number | null
  }[]
  dependencies: { id: string; predecessorId: string; successorId: string; type: string; lagDays: number }[]
}

export interface StructureSaveRequest {
  finance?: ProjectFinanceInput
  version: string
  summary?: string
  /** 项目本身（Lv1）的编号与名称 */
  project?: { code: string; name: string }
  subProjects: {
    id: string | null
    key: string
    name: string
    module: string
    stage: string
    tasks: {
      id: string | null
      key: string
      code: string
      name: string
      isMilestone: boolean
      ownerId: string
      plannedStart: string
      plannedEnd: string
      estimatedEffort: number
      costBudget: number | null
      notes: string | null
      /** 前置任务的 id（已有任务）或 key（本次新建） */
      predecessors: string[]
    }[]
  }[]
}

export async function getStructure(projectId: string): Promise<StructureSnapshot> {
  const { data } = await api.get<StructureSnapshot>(`/projects/${encodeURIComponent(projectId)}/structure`)
  return data
}

/** 本次保存的变更统计 */
export interface StructureSaveResult {
  createdSubProjects: number
  deletedSubProjects: number
  createdTasks: number
  updatedTasks: number
  deletedTasks: number
  addedDependencies: number
  removedDependencies: number
  /** 子项目或任务的先后（或任务所属子项目）有调整 */
  reordered: boolean
  /** 改了项目编号 / 名称 */
  projectUpdated: boolean
  financeUpdated?: boolean
}

export async function saveStructure(
  projectId: string,
  body: StructureSaveRequest,
): Promise<StructureSnapshot & { result: StructureSaveResult }> {
  const { data } = await api.put<StructureSnapshot & { result: StructureSaveResult }>(
    `/projects/${encodeURIComponent(projectId)}/structure`,
    body,
  )
  return data
}
