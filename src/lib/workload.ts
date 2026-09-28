// 人员负荷计算（多周热力图数据）

import { addDays, differenceInCalendarDays, format, parseISO, startOfWeek } from 'date-fns'
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

function tasksInWeek(userTasks: Task[], weekStart: Date) {
  const { start, end } = weekRange(weekStart)
  return userTasks.filter((t) => {
    if (t.isMilestone) return false
    if (t.status === '已完成' || t.status === '已验证') return false
    const ts = parseISO(t.plannedStart)
    const te = parseISO(t.plannedEnd)
    return !(te < start || ts > end)
  })
}

function userWeekHours(userTasks: Task[], weekStart: Date): { hours: number; taskCount: number } {
  const { start, end } = weekRange(weekStart)
  let allocated = 0
  let count = 0
  for (const t of userTasks) {
    if (t.isMilestone) continue
    if (t.status === '已完成' || t.status === '已验证') continue
    const ts = parseISO(t.plannedStart)
    const te = parseISO(t.plannedEnd)
    if (te < start || ts > end) continue
    const totalDays = Math.max(1, differenceInCalendarDays(te, ts) + 1)
    const overlapStart = ts > start ? ts : start
    const overlapEnd = te < end ? te : end
    const overlapDays = Math.max(0, differenceInCalendarDays(overlapEnd, overlapStart) + 1)
    // 简化：把工时按区间平均分配，每天 8h
    allocated += (t.estimatedEffort / totalDays) * overlapDays * WORK_HOURS_PER_DAY
    count++
  }
  return { hours: Math.round(allocated * 10) / 10, taskCount: count }
}

export interface WorkloadParams {
  weeks?: number
  startWeek?: Date
  /** 仅计算这些用户 ID（用于按可见范围过滤）；undefined / 空集 = 全员 */
  userIds?: Set<string>
}

export function computeUserHeatmaps({ weeks = 8, startWeek, userIds }: WorkloadParams = {}): UserHeatmap[] {
  const today = TODAY  // 全局统一的「今日」（本机当前日期），口径与全局一致
  const baseWeek = startWeek || startOfWeek(today, { weekStartsOn: 1 })
  // 显示从前 1 周开始的 N 周
  const offset = -1
  const useFilter = userIds && userIds.size > 0

  const result: UserHeatmap[] = []
  for (const u of users) {
    if (!(u.role === 'rd' || u.role === 'project_lead')) continue
    if (!u.isActive) continue
    if (useFilter && !userIds!.has(u.id)) continue
    const userTasks = tasks.filter((t) => t.ownerId === u.id)
    const cells: WeekCell[] = []
    for (let i = offset; i < offset + weeks; i++) {
      const ws = addDays(baseWeek, i * 7)
      const { hours, taskCount } = userWeekHours(userTasks, ws)
      const available = (u.weeklyAvailableHours || 40)
      const rate = available > 0 ? Math.round((hours / available) * 100) : 0
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
    const avgRate = Math.round(cells.reduce((s, c) => s + c.rate, 0) / cells.length)
    const peakRate = Math.max(...cells.map((c) => c.rate))
    const hasOverload = cells.some((c) => c.level === 'high')
    result.push({ user: u, cells, avgRate, peakRate, hasOverload })
  }
  return result
}

// 获取某人某周的具体任务列表（用于点击单元格弹窗）
export function getUserWeekTasks(userId: string, weekStart: Date): Task[] {
  const userTasks = tasks.filter((t) => t.ownerId === userId)
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
  module?: string
  estimatedEffort: number
  plannedStart: string
  plannedEnd: string
}): RecommendationCandidate[] {
  const { module, estimatedEffort, plannedStart, plannedEnd } = opts
  const start = parseISO(plannedStart)
  const end = parseISO(plannedEnd)
  // 找出与任务区间重叠的所有周
  const ws = startOfWeek(start, { weekStartsOn: 1 })
  const we = startOfWeek(end, { weekStartsOn: 1 })
  const numWeeks = Math.max(1, Math.round(differenceInCalendarDays(we, ws) / 7) + 1)
  const totalDays = Math.max(1, differenceInCalendarDays(end, start) + 1)

  return users
    .filter((u) => u.isActive && u.role === 'rd')
    .map((u) => {
      const userTasks = tasks.filter((t) => t.ownerId === u.id)
      // 计算这些周的平均负荷
      let sumCurrent = 0, sumPredicted = 0
      for (let i = 0; i < numWeeks; i++) {
        const w = addDays(ws, i * 7)
        const { hours } = userWeekHours(userTasks, w)
        const available = u.weeklyAvailableHours || 40
        const currentRate = available > 0 ? (hours / available) * 100 : 0
        // 本周与任务区间重叠天数，按比例新增工时
        const wEnd = addDays(w, 6)
        const oStart = start > w ? start : w
        const oEnd = end < wEnd ? end : wEnd
        const overlap = Math.max(0, differenceInCalendarDays(oEnd, oStart) + 1)
        const additionalHours = (estimatedEffort / totalDays) * overlap * WORK_HOURS_PER_DAY
        const predicted = available > 0 ? ((hours + additionalHours) / available) * 100 : 0
        sumCurrent += currentRate
        sumPredicted += predicted
      }
      const currentRate = Math.round(sumCurrent / numWeeks)
      const predictedRate = Math.round(sumPredicted / numWeeks)
      const matchesGroup = module ? userMatchesModule(u, module) : true
      return {
        user: u,
        currentRate,
        currentLevel: levelOf(currentRate),
        predictedRate,
        predictedLevel: levelOf(predictedRate),
        currentTaskCount: userTasks.filter((t) => t.status !== '已完成' && t.status !== '已验证').length,
        matchesGroup,
      }
    })
    // 按 URS：筛选负荷率 ≤ 70% 的候选人，按负荷率从低到高
    .sort((a, b) => {
      // 模块匹配优先
      if (a.matchesGroup !== b.matchesGroup) return a.matchesGroup ? -1 : 1
      return a.currentRate - b.currentRate
    })
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
