// ProjectFinances API —— 金额单位万元
import { api } from './client'

export interface ProjectFinanceDTO {
  projectId: string
  totalBudget: number
  /** 已花费 = 该项目全部任务的实际花费合计（后端实时汇总） */
  spent: number
  committed: number
  breakdown: Record<string, number>
  fiscalYear: string | null
  notes: string | null
  /** 任务预算合计（后端汇总，含当前用户看不到的任务） */
  taskBudget: number
}

/** 管理员 / CMC 负责人维护的项目预算；已花费不可手工填写。 */
export interface ProjectFinanceInput {
  totalBudget: number
  committed: number
  breakdown: Record<string, number>
  fiscalYear: string | null
  notes: string | null
}

export async function listFinances(): Promise<ProjectFinanceDTO[]> {
  const { data } = await api.get<ProjectFinanceDTO[]>('/finances')
  return data
}

export async function updateFinance(projectId: string, input: ProjectFinanceInput): Promise<ProjectFinanceDTO> {
  const { data } = await api.put<ProjectFinanceDTO>(`/finances/${encodeURIComponent(projectId)}`, input)
  return data
}
