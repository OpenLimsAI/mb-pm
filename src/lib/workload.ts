// 人员负荷计算（多周热力图数据）

import { addDays, differenceInCalendarDays, format, parseISO, startOfWeek, startOfDay } from 'date-fns'
import { calendarForTask, getWeeklyCapacity, moveWorkingDays, workingDates } from './workingCalendar'
import { tasks, users, TODAY } from '../mock'
import type { User, Task } from '../types'

export interface WeekCell {
  weekStart: Date
  weekLabel: string
  weekKey: string  // yyyy-MM-dd
  rate: number
  level: 'low' | 'mid' | 'high'
  allocatedHours: number
  availableHours: number
  taskCount: number
}

export interface UserHeatmap {
  user: User
  cells: WeekCell[]
  avgRate: number
  peakRate: number
  hasOverload: boolean
}

const WORK_HOURS_PER_DAY = 8

function levelOf(rate: number): 'low' | 'mid' | 'high' {
  return rate <= 70 ? 'low' : rate <= 90 ? 'mid' : 'high'
}

function weekRange(weekStart: Date) {
  return { start: weekStart, end: addDays(weekStart, 6) }
}

export const taskAssignees = (task: Task): string[] => [...new Set([task.ownerId, ...(task.collaboratorIds ?? [])])]
export function remainingTaskHours(task: Task): number {
  if (task.isMilestone || task.status === '已完成' || task.status === '已验证') return 0
  const remainingDays = task.actualEffort !== undefined && task.actualEffort !== null
    ? Math.max(0, task.estimatedEffort - task.actualEffort)
    : Math.max(0, task.estimatedEffort * (1 - task.progress / 100))
  return remainingDays * WORK_HOURS_PER_DAY
}
function futureTaskDays(task: Task): Date[] {
  const calendar = calendarForTask(task)
  const start = parseISO(task.plannedStart) > startOfDay(TODAY) ? parseISO(task.plannedStart) : startOfDay(TODAY)
  let end = parseISO(task.plannedEnd) > start ? parseISO(task.plannedEnd) : start
  let days = workingDates(start, end, calendar)
  if (!days.length) { end = moveWorkingDays(end, 1, calendar); days = [end] }
  return days
}
function tasksInWeek(userTasks: Task[], weekStart: Date) {
  const { start, end } = weekRange(weekStart)
  return userTasks.filter(task => remainingTaskHours(task) > 0 && futureTaskDays(task).some(day => day >= start && day <= end))
}
/** A task's remaining effort is divided equally between its unique owner and collaborators. */
export function userWeekHours(userTasks: Task[], weekStart: Date, userId?: string): { hours: number; taskCount: number } {
  const { start, end } = weekRange(weekStart)
  let allocated = 0
  let count = 0
  for (const task of userTasks) {
    const remaining = remainingTaskHours(task)
    if (remaining <= 0) continue
    const assignees = taskAssignees(task)
    if (userId && !assignees.includes(userId)) continue
    const days = futureTaskDays(task)
    const overlap = days.filter(day => day >= start && day <= end).length
    if (!overlap) continue
    allocated += remaining / Math.max(1, assignees.length) * overlap / days.length
    count++
  }
  return { hours: Math.round(allocated * 10) / 10, taskCount: count }
}
export function availableWeekHours(user: User, weekStart: Date): number {
  const override = getWeeklyCapacity(user.id, format(weekStart, 'yyyy-MM-dd'))
  return override ? Math.max(0, override.availableHours - override.leaveHours) : Math.max(0, user.weeklyAvailableHours ?? 40)
}
const rateFor = (hours: number, available: number) => available > 0 ? Math.round(hours / available * 100) : hours > 0 ? Infinity : 0

export interface WorkloadParams {
  weeks?: number
  startWeek?: Date
  /** 仅计算这些用户 ID（用于按可见范围过滤）；undefined = 全员；空集 = 无可见成员 */
  userIds?: Set<string>
}

export function computeUserHeatmaps({ weeks = 8, startWeek, userIds }: WorkloadParams = {}): UserHeatmap[] {
  const today = TODAY  // 全局统一的「今日」（本机当前日期），口径与全局一致
  const baseWeek = startWeek || startOfWeek(today, { weekStartsOn: 1 })
  // 显示从前 1 周开始的 N 周
  const offset = -1
  const useFilter = userIds !== undefined

  const result: UserHeatmap[] = []
  for (const u of users) {
    if (!(u.role === 'rd' || u.role === 'project_lead' || u.role === 'production' || u.role === 'qa_qc') && !tasks.some(task => taskAssignees(task).includes(u.id))) continue
    if (!u.isActive) continue
    if (useFilter && !userIds!.has(u.id)) continue
    const userTasks = tasks.filter((t) => taskAssignees(t).includes(u.id))
    const cells: WeekCell[] = []
    for (let i = offset; i < offset + weeks; i++) {
      const ws = addDays(baseWeek, i * 7)
      const { hours, taskCount } = userWeekHours(userTasks, ws, u.id)
      const available = availableWeekHours(u, ws)
      const rate = rateFor(hours, available)
      cells.push({
        weekStart: ws,
        weekLabel: format(ws, 'MM/dd'),
        weekKey: format(ws, 'yyyy-MM-dd'),
        rate,
        level: levelOf(rate),
        allocatedHours: hours,
        availableHours: available,
        taskCount,
      })
    }
    const avgRate = rateFor(cells.reduce((sum, cell) => sum + cell.allocatedHours, 0), cells.reduce((sum, cell) => sum + cell.availableHours, 0))
    const peakRate = Math.max(...cells.map((c) => c.rate))
    const hasOverload = cells.some((c) => c.level === 'high')
    result.push({ user: u, cells, avgRate, peakRate, hasOverload })
  }
  return result
}

// 获取某人某周的具体任务列表（用于点击单元格弹窗）
export function getUserWeekTasks(userId: string, weekStart: Date): Task[] {
  const userTasks = tasks.filter((t) => taskAssignees(t).includes(userId))
  return tasksInWeek(userTasks, weekStart)
}

// === 任务推荐（FR-SW-002）===
export interface RecommendationCandidate {
  user: User
  currentRate: number
  currentLevel: 'low' | 'mid' | 'high'
  predictedRate: number  // 接受新任务后的预计负荷率
  predictedLevel: 'low' | 'mid' | 'high'
  currentTaskCount: number
  matchesGroup: boolean
}

export function recommendForTask(opts: {
  module?: string; estimatedEffort: number; plannedStart: string; plannedEnd: string; task?: Task
}): RecommendationCandidate[] {
  const { module, estimatedEffort, plannedStart, plannedEnd, task } = opts
  const start = parseISO(plannedStart) > TODAY ? parseISO(plannedStart) : TODAY
  const end = parseISO(plannedEnd) > start ? parseISO(plannedEnd) : start
  const ws = startOfWeek(start, { weekStartsOn: 1 })
  const we = startOfWeek(end, { weekStartsOn: 1 })
  const numWeeks = Math.max(1, Math.round(differenceInCalendarDays(we, ws) / 7) + 1)
  return users.filter(u => u.isActive && ['rd', 'production', 'qa_qc', 'project_lead'].includes(u.role)).map(u => {
    const userTasks = tasks.filter(t => taskAssignees(t).includes(u.id))
    const proposed = task ? { ...task, ownerId: u.id, collaboratorIds: (task.collaboratorIds ?? []).filter(id => id !== u.id) }
      : { id: 'proposal', code: '', name: '', subProjectId: '', ownerId: u.id, collaboratorIds: [], plannedStart, plannedEnd, estimatedEffort, status: '未开始' as const, priority: '中' as const, progress: 0, isMilestone: false, isCriticalPath: false }
    let sumCurrent = 0, sumPredicted = 0
    for (let i = 0; i < numWeeks; i++) {
      const week = addDays(ws, i * 7)
      const current = userWeekHours(userTasks, week, u.id).hours
      const withoutTask = task ? userWeekHours(userTasks.filter(t => t.id !== task.id), week, u.id).hours : current
      const additional = userWeekHours([proposed], week, u.id).hours
      const available = availableWeekHours(u, week)
      sumCurrent += rateFor(current, available)
      sumPredicted += rateFor(withoutTask + additional, available)
    }
    const currentRate = Math.round(sumCurrent / numWeeks), predictedRate = Math.round(sumPredicted / numWeeks)
    return { user: u, currentRate, currentLevel: levelOf(currentRate), predictedRate, predictedLevel: levelOf(predictedRate),
      currentTaskCount: userTasks.filter(t => remainingTaskHours(t) > 0).length, matchesGroup: module ? userMatchesModule(u, module) : true }
  }).sort((a, b) => a.matchesGroup !== b.matchesGroup ? (a.matchesGroup ? -1 : 1) : a.predictedRate - b.predictedRate)
}

export function userMatchesModule(user: User, module: string): boolean {
  if (!user.specialtyGroup) return false
  const map: Record<string, string[]> = {
    'USP': ['上游'], '细胞株': ['上游'],
    'DSP': ['下游'],
    'DP': ['制剂'],
    '分析方法': ['分析'],
    '稳定性': ['稳定性'],
    '工艺验证': ['工艺验证'],
    'CTD': ['CMC综合'], '其他': ['CMC综合'],
  }
  const acceptable = map[module] || []
  return acceptable.includes(user.specialtyGroup)
}

export interface OverloadAlert {
  user: User
  weeks: { weekKey: string; weekLabel: string; rate: number }[]
  peakRate: number
}

export function findOverloadAlerts(weeks = 4, userIds?: Set<string>): OverloadAlert[] {
  const heatmaps = computeUserHeatmaps({ weeks: weeks + 1, userIds })
  const result: OverloadAlert[] = []
  for (const h of heatmaps) {
    const future = h.cells.slice(1, weeks + 1) // 跳过过去那一周
    const overloaded = future.filter((c) => c.level === 'high')
    if (overloaded.length === 0) continue
    result.push({
      user: h.user,
      weeks: overloaded.map((c) => ({ weekKey: c.weekKey, weekLabel: c.weekLabel, rate: c.rate })),
      peakRate: Math.max(...overloaded.map((c) => c.rate)),
    })
  }
  return result.sort((a, b) => b.peakRate - a.peakRate)
}
