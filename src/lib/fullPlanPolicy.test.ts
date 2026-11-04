import { expect, it } from 'vitest'
import type { Task } from '../types'
import { fullPlanDifferences, type FullPlanSnapshot } from './fullPlanBaseline'

const task: Task = { id: 't', code: 'T', name: '任务', subProjectId: 's', ownerId: 'u', status: '进行中', priority: '中', plannedStart: '2026-11-01', plannedEnd: '2026-11-04', estimatedEffort: 1, progress: 50, isMilestone: false, isCriticalPath: false }
const base: FullPlanSnapshot = { projectPlannedStart: task.plannedStart, projectPlannedEnd: task.plannedEnd, progress: 50, totalBudget: 0, taskCount: 1, milestoneCount: 0, milestones: [], tasks: [{ ...task }], dependencies: [] }
it('shows weight changes for new snapshots and never invents a legacy default', () => {
  expect(fullPlanDifferences(base, [{ ...task, progressWeight: 2 }], [])).toEqual([])
  const captured = { ...base, progressMethod: 'custom' as const, tasks: [{ ...task, progressWeight: null }] }
  expect(fullPlanDifferences(captured, [{ ...task, progressWeight: 2 }], [])[0].changes).toEqual(['进度权重：默认 → 2'])
  expect(fullPlanDifferences(captured, [{ ...task, progressWeight: 0 }], [])[0].changes).toEqual(['进度权重：默认 → 0'])
})
