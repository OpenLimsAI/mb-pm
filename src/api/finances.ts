// ProjectFinances API
import { api } from './client'

export interface ProjectFinanceDTO {
  projectId: string
  totalBudget: number
  spent: number
  committed: number
  breakdown: Record<string, number>
  fiscalYear: string | null
  notes: string | null
}

export async function listFinances(): Promise<ProjectFinanceDTO[]> {
  const { data } = await api.get<ProjectFinanceDTO[]>('/finances')
  return data
}
