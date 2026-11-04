import { describe, expect, it } from 'vitest'
import type { Task } from '../types'
import { calculateProgress, progressWeight } from './progress'

const task = (patch: Partial<Task>): Task => ({ id: 't', code: 'T', name: '任务', subProjectId: 's', ownerId: 'u', status: '进行中', priority: '中', plannedStart: '2026-11-01', plannedEnd: '2026-11-04', estimatedEffort: 1, progress: 0, isMilestone: false, isCriticalPath: false, ...patch })

describe('project progress policy', () => {
  it('uses legacy equal weights and rounds halves up', () => {
    expect(calculateProgress([task({ progress: 25 }), task({ isMilestone: true })])).toBe(13)
    expect(calculateProgress([])).toBe(0)
  })
  it('weights remaining project progress by planned effort, excluding milestones', () => {
    const tasks = [task({ progress: 100, estimatedEffort: 9 }), task({ estimatedEffort: 1 }), task({ isMilestone: true, estimatedEffort: 100 })]
    expect(calculateProgress(tasks, 'effort')).toBe(90)
    expect(calculateProgress([task({ estimatedEffort: 0 })], 'effort')).toBe(0)
  })
  it('distinguishes an explicit zero from an unset custom weight', () => {
    expect(progressWeight(task({ progressWeight: 0 }), 'custom')).toBe(0)
    expect(progressWeight(task({ progressWeight: null }), 'custom')).toBe(1)
    expect(progressWeight(task({ isMilestone: true }), 'custom')).toBe(0)
    expect(calculateProgress([task({ progress: 100 }), task({ progress: 50, progressWeight: 3 })], 'custom')).toBe(63)
  })
  it('retains exact rounding with large projects and four decimal custom weights', () => {
    const tasks = Array.from({ length: 5000 }, (_, i) => task({ progress: i % 2 ? 25 : 0, progressWeight: 999999.9999 }))
    expect(calculateProgress(tasks, 'custom')).toBe(13)
    expect(calculateProgress([task({ progress: 100, progressWeight: 0.0001 }), task({ progressWeight: 0.0003 })], 'custom')).toBe(25)
  })
})
