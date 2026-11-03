import { describe, expect, test } from 'vitest'
import { projectItems, workbenchGroups } from './projectWorkbench'
import type { Project, SubProject, Task } from '../types'

export const project = { id: 'p1', code: 'QA-01', name: '质量项目', ownerId: 'u1', productType: '其他', currentStage: '上市后', targetStage: '上市后', status: '活跃', health: 'green', plannedStart: '2026-11-01', plannedEnd: '2027-10-30', progress: 22, templateId: null, templateVersion: null } satisfies Project
export const sub = { id: 's1', projectId: 'p1', name: '质量研究', stage: '上市后', module: '其他', status: '进行中', progress: 22, sortOrder: 0 } satisfies SubProject
export const task = { id: 't1', code: 'T1', name: '供应商考察', subProjectId: 's1', ownerId: 'u1', status: '进行中', priority: '中', plannedStart: '2026-11-01', plannedEnd: '2026-11-10', estimatedEffort: 2, progress: 10, isMilestone: false, isCriticalPath: false } satisfies Task
const now = new Date(2026, 10, 3, 18, 30)
describe('workbench facts', () => {
  test('joins only visible projects and excludes completed, verified and orphan tasks', () => {
    const result = projectItems([project], [sub, { ...sub, id: 'hidden', projectId: 'hidden' }], [task, { ...task, id: 'done', status: '已完成' }, { ...task, id: 'verified', status: '已验证' }, { ...task, id: 'orphan', subProjectId: 'missing' }, { ...task, id: 'hidden', subProjectId: 'hidden' }], now)
    expect(result.map((i) => i.task.id)).toEqual(['t1'])
  })
  test('overdue and explicit blocked/delayed stay visible outside the horizon, without double counting', () => {
    const result = projectItems([project], [sub], [{ ...task, id: 'overdue', plannedEnd: '2026-10-31', status: '阻塞' }, { ...task, id: 'future', plannedEnd: '2027-12-01', status: '延迟' }, { ...task, id: 'undated', plannedEnd: '', status: '阻塞' }], now)
    const groups = workbenchGroups(result, 7)
    expect(groups.attention.map((i) => i.task.id)).toEqual(['overdue', 'future', 'undated'])
    expect(groups.attention[0].reason).toBe('逾期 3 天 · 已阻塞')
    expect(groups.upcoming).toEqual([])
    expect(groups.attention[2].days).toBeNull()
  })
  test('calendar-day boundaries include today, day 7 and day 30; both due lists use the same horizon', () => {
    const items = projectItems([project], [sub], [
      { ...task, id: 'today', plannedEnd: '2026-11-03' }, task,
      { ...task, id: 'ms7', isMilestone: true },
      { ...task, id: 'ms8', plannedEnd: '2026-11-11', isMilestone: true },
      { ...task, id: 'ms30', plannedEnd: '2026-12-03', isMilestone: true },
      { ...task, id: 'ms31', plannedEnd: '2026-12-04', isMilestone: true },
    ], now)
    expect(workbenchGroups(items, 7).upcoming.map((i) => i.task.id)).toEqual(['today', 't1'])
    expect(workbenchGroups(items, 7).milestones.map((i) => i.task.id)).toEqual(['ms7'])
    expect(workbenchGroups(items, 30).milestones.map((i) => i.task.id)).toEqual(['ms7', 'ms8', 'ms30'])
    expect(workbenchGroups(items, 30).attention).toEqual([])
  })
  test('my tasks use the task owner, not the project owner or collaborators', () => {
    const items = projectItems([project], [sub], [task, { ...task, id: 'other', ownerId: 'u2', collaboratorIds: ['u1'] }], now)
    expect(workbenchGroups(items, 7, 'u1').upcoming.map((i) => i.task.id)).toEqual(['t1'])
    expect(workbenchGroups(items, 7, 'nobody').upcoming).toEqual([])
  })
})
