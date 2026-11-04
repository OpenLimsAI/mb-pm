import { afterEach, describe, expect, test, vi } from 'vitest'
import type { Task } from '../types'
import type { Project, SubProject } from '../types'
const project = { id: 'p1', ownerId: 'u1' } as Project
const sub = { id: 's1', projectId: 'p1' } as SubProject
const task = { id: 't1', name: '任务', subProjectId: 's1', status: '进行中', plannedEnd: '2026-11-10', isMilestone: false } as Task

vi.mock('../mock', () => ({ projects: [], tasks: [], subProjects: [], users: [], alerts: [], resourceBookings: [], resources: [], calcWorkload: () => 0, findUser: () => undefined, TODAY: new Date(2026, 10, 3) }))
import { projects, tasks, subProjects } from '../mock'
import { getGlobalKpis, getProjectSummary } from './analytics'

afterEach(() => { projects.splice(0); tasks.splice(0); subProjects.splice(0) })
describe('consistent project metrics', () => {
  test('overdue date and explicit blocked are counted once; done and verified are excluded', () => {
    projects.push(project); subProjects.push(sub)
    tasks.push(...[
      { ...task, id: 'late', plannedEnd: '2026-11-01', status: '阻塞' },
      { ...task, id: 'auto', plannedEnd: '2026-11-01' },
      { ...task, id: 'verified', status: '已验证', isMilestone: true, plannedEnd: '2026-10-01' },
      { ...task, id: 'done', status: '已完成', isMilestone: true },
      { ...task, id: 'future', isMilestone: true },
    ] as Task[])
    expect(getProjectSummary(project)).toMatchObject({ delayedCount: 2, doneCount: 2, taskCount: 5 })
    expect(getProjectSummary(project).upcomingMilestone?.name).toBe(task.name)
    expect(getGlobalKpis()).toMatchObject({ delayed: 2, milestones: 1 })
  })
})
