import { api } from './client'
import type { TaskDependency } from '../types'

export type MilestoneDependencies = [string, string, string, string, number][]
export function milestoneDependencySnapshot(taskId: string, dependencies: TaskDependency[]): MilestoneDependencies {
  return dependencies.filter(row => row.predecessorId === taskId || row.successorId === taskId)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(row => [row.id, row.predecessorId, row.successorId, row.type, row.lagDays])
}

export interface MilestoneSaveContext {
  requestId: string
  projectId?: string
  expectedRevision?: number
  expectedDependencies?: MilestoneDependencies
}

export async function saveMilestoneAtomic(payload: MilestoneSaveContext & {
  operation: 'create' | 'update' | 'delete'
  projectId: string
  taskId?: string
  subProjectId?: string
  name?: string
  plannedEnd?: string
  priority?: string
  notes?: string | null
  predecessorIds?: string[]
}): Promise<{ taskId: string; removedDependencies: number; replayed: boolean }> {
  const { data } = await api.post('/milestones/atomic', payload)
  return data
}
