import { afterEach, describe, expect, it } from 'vitest'
import { format, parseISO, startOfWeek } from 'date-fns'
import { users, tasks, subProjects, TODAY } from '../mock'
import type { Task, User } from '../types'
import { computeCPM } from './cpm'
import { defaultCalendar, setWorkingCalendars, setWeeklyCapacities, workingDates } from './workingCalendar'
import { availableWeekHours, computeUserHeatmaps, remainingTaskHours, userWeekHours } from './workload'
import { fullPlanDifferences, type FullPlanSnapshot } from './fullPlanBaseline'

const task = (overrides: Partial<Task> = {}): Task => ({ id: 'planning-task', code: 'P', name: '长任务', subProjectId: 'planning-sub', ownerId: 'planning-owner', status: '未开始', priority: '中', plannedStart: '2026-11-06', plannedEnd: '2026-11-10', estimatedEffort: 10, progress: 0, isMilestone: false, isCriticalPath: false, ...overrides })
const originalTasks = [...tasks], originalUsers = [...users], originalSubs = [...subProjects]
afterEach(() => { tasks.splice(0, tasks.length, ...originalTasks); users.splice(0, users.length, ...originalUsers); subProjects.splice(0, subProjects.length, ...originalSubs); setWorkingCalendars([]); setWeeklyCapacities([]) })

describe('working calendars and resource planning', () => {
  it('uses working weekdays, holidays and exceptional working dates in CPM', () => {
    const calendar = { ...defaultCalendar, weekdays: [1, 2, 3, 4, 5], holidays: ['2026-11-09'], workingDates: ['2026-11-07'] }
    const days = workingDates(parseISO('2026-11-06'), parseISO('2026-11-10'), calendar)
    expect(days.map(day => day.getDate())).toEqual([6, 7, 10])
    const a = task(), b = task({ id: 'second', plannedStart: '2026-11-06', plannedEnd: '2026-11-06' })
    const result = computeCPM([a, b], [{ id: 'dep', predecessorId: a.id, successorId: b.id, type: 'FS', lagDays: 1 }], calendar)
    expect(result.byId.get('second')?.earliestStart).toBe('2026-11-11')
    expect(result.byId.get(a.id)?.durationDays).toBe(2)
  })
  it('splits remaining effort between unique collaborators without counting actual work twice', () => {
    const current = format(TODAY, 'yyyy-MM-dd')
    const value = task({ plannedStart: current, plannedEnd: current, actualEffort: 6, collaboratorIds: ['planning-helper', 'planning-helper'] })
    const week = startOfWeek(TODAY, { weekStartsOn: 1 })
    expect(remainingTaskHours(value)).toBe(32)
    expect(userWeekHours([value], week, 'planning-owner').hours).toBe(16)
    expect(userWeekHours([value], week, 'planning-helper').hours).toBe(16)
    expect(userWeekHours([value], week, 'unrelated').hours).toBe(0)
    expect(remainingTaskHours({ ...value, status: '已验证' })).toBe(0)
  })
  it('preserves zero capacity and includes production and QA staff', () => {
    const staff = { id: 'planning-owner', username: 'p', displayName: '生产', email: '', role: 'production', weeklyAvailableHours: 40, isActive: true, avatarColor: '' } satisfies User
    users.splice(0, users.length, staff, { ...staff, id: 'planning-qa', role: 'qa_qc' })
    setWeeklyCapacities([{ userId: staff.id, weekStart: '2026-11-02', availableHours: 40, leaveHours: 8, revision: 1 }])
    expect(availableWeekHours(staff, parseISO('2026-11-02'))).toBe(32)
    setWeeklyCapacities([{ userId: staff.id, weekStart: '2026-11-02', availableHours: 0, leaveHours: 0, revision: 2 }])
    expect(availableWeekHours(staff, parseISO('2026-11-02'))).toBe(0)
    expect(computeUserHeatmaps({ weeks: 4 }).map(row => row.user.id)).toEqual(['planning-owner', 'planning-qa'])
    expect(computeUserHeatmaps({ userIds: new Set() })).toEqual([])
  })
  it('compares changes to ordinary tasks, assignments, budgets and dependencies', () => {
    const value = task()
    const snapshot = { tasks: [value], dependencies: [], milestones: [], projectPlannedStart: value.plannedStart, projectPlannedEnd: value.plannedEnd, progress: 0, totalBudget: 0, taskCount: 1, milestoneCount: 0 } satisfies FullPlanSnapshot
    const differences = fullPlanDifferences(snapshot, [{ ...value, ownerId: 'new-owner', costBudget: 10, plannedEnd: '2026-11-20' }, task({ id: 'added' })], [])
    expect(differences).toHaveLength(2)
    expect(differences[0].changes.join(' ')).toContain('负责人')
    expect(differences[0].changes.join(' ')).toContain('预算')
    expect(fullPlanDifferences(snapshot, [], [])[0].kind).toBe('已删除')
  })
})
