// 看板/报表用计算函数（基于 Mock 数据派生）
import { differenceInCalendarDays, format, startOfWeek, addWeeks, isBefore, parseISO } from 'date-fns'
import {
  projects, tasks, subProjects, users, alerts, resourceBookings, resources, calcWorkload, findUser, TODAY,
} from '../mock'
import type { Project, Task, Health } from '../types'
import type { Scope } from './scope'
import { getTaskSchedule, isTaskDone } from './schedule'

// 与全局「今日」（mock/tasks.ts 的 TODAY，本机当前日期）一致：KPI/趋势/延迟/里程碑等派生
// 统一用它而不是各处各自 new Date()，口径与 risk.ts、schedule.ts、后端 rollup.py 保持一致。
const today = TODAY

// ===== 工具：按 scope 过滤项目/任务 =====
function visibleProjects(scope?: Scope): Project[] {
  if (!scope || scope.isAll) return projects
  return projects.filter((p) => scope.projectIds.has(p.id))
}
function visibleTasks(scope?: Scope): Task[] {
  if (!scope || scope.isAll) return tasks
  return tasks.filter((t) => scope.taskIds.has(t.id))
}

// ===== 健康度统计 =====
export function getHealthStats(scope?: Scope) {
  const counts: Record<Health, number> = { green: 0, yellow: 0, red: 0 }
  visibleProjects(scope).filter((p) => p.status === '活跃').forEach((p) => counts[p.health]++)
  return counts
}

// ===== 里程碑倒计时 =====
export interface MilestoneInfo {
  task: Task
  project: Project
  daysLeft: number
  isAtRisk: boolean
  blockingTasksCount: number
}

export function getUpcomingMilestones(limit = 6, scope?: Scope): MilestoneInfo[] {
  const visible = visibleTasks(scope)
  const ms = visible.filter(
    (t) => t.isMilestone && t.status !== '已完成' && t.status !== '已验证'
  )
  return ms
    .map((t) => {
      const sub = subProjects.find((s) => s.id === t.subProjectId)
      const proj = projects.find((p) => p.id === sub?.projectId)!
      const end = parseISO(t.plannedEnd)
      const daysLeft = differenceInCalendarDays(end, today)
      return {
        task: t,
        project: proj,
        daysLeft,
        isAtRisk: daysLeft <= 14 || proj.health !== 'green',
        blockingTasksCount: 0,
      }
    })
    .sort((a, b) => a.daysLeft - b.daysLeft)
    .slice(0, limit)
}

// ===== 延迟任务 Top-N =====
export interface DelayedTaskInfo {
  task: Task
  project: Project
  delayDays: number
  reason: string
}

export function getDelayedTasks(limit = 8, scope?: Scope): DelayedTaskInfo[] {
  const result: DelayedTaskInfo[] = []
  for (const t of visibleTasks(scope)) {
    if (t.status === '已完成' || t.status === '已验证') continue
    const end = parseISO(t.plannedEnd)
    const isDelayedByStatus = t.status === '延迟' || t.status === '阻塞'
    const isOverdue = isBefore(end, today) && t.progress < 100
    if (!isDelayedByStatus && !isOverdue) continue

    const sub = subProjects.find((s) => s.id === t.subProjectId)
    const proj = projects.find((p) => p.id === sub?.projectId)!
    const delayDays = isOverdue ? differenceInCalendarDays(today, end) : 0
    result.push({
      task: t,
      project: proj,
      delayDays,
      reason: t.notes || (t.status === '阻塞' ? '依赖阻塞' : '进度落后'),
    })
  }
  return result
    .sort((a, b) => b.delayDays - a.delayDays || (a.task.isCriticalPath ? -1 : 1))
    .slice(0, limit)
}

// ===== 人员负荷概览 =====
export interface UserWorkload {
  userId: string
  displayName: string
  group?: string
  rate: number
  level: 'low' | 'mid' | 'high'
  allocatedHours: number
  availableHours: number
}

export function getWorkloadOverview(scope?: Scope): UserWorkload[] {
  return users
    .filter((u) => u.role === 'rd' || u.role === 'project_lead')
    .filter((u) => {
      // project_lead 只看自己项目内涉及的人员
      if (!scope || scope.isAll) return true
      if (scope.userIds.size === 0) return true
      return scope.userIds.has(u.id)
    })
    .map((u) => {
      const w = calcWorkload(u.id)
      const level: 'low' | 'mid' | 'high' = w.rate <= 70 ? 'low' : w.rate <= 90 ? 'mid' : 'high'
      return {
        userId: u.id,
        displayName: u.displayName,
        group: u.specialtyGroup,
        rate: w.rate,
        level,
        allocatedHours: w.allocatedHours,
        availableHours: w.availableHours,
      }
    })
    .sort((a, b) => b.rate - a.rate)
}

// ===== 资源冲突检测 =====
export interface ResourceConflict {
  resourceId: string
  resourceName: string
  bookings: { projectId: string; projectName: string; taskName?: string; start: string; end: string }[]
  overlapDays: number
}

export function getResourceConflicts(scope?: Scope): ResourceConflict[] {
  const conflicts: ResourceConflict[] = []
  for (const r of resources) {
    let myBookings = resourceBookings.filter((b) => b.resourceId === r.id)
    // 仅显示与可见项目相关的占用
    if (scope && !scope.isAll) {
      myBookings = myBookings.filter((b) => scope.projectIds.has(b.projectId))
    }
    for (let i = 0; i < myBookings.length; i++) {
      for (let j = i + 1; j < myBookings.length; j++) {
        const a = myBookings[i], b = myBookings[j]
        const aStart = parseISO(a.startDate), aEnd = parseISO(a.endDate)
        const bStart = parseISO(b.startDate), bEnd = parseISO(b.endDate)
        if (aEnd < bStart || bEnd < aStart) continue
        const overlapStart = aStart > bStart ? aStart : bStart
        const overlapEnd = aEnd < bEnd ? aEnd : bEnd
        const overlapDays = differenceInCalendarDays(overlapEnd, overlapStart) + 1
        if (overlapDays <= 0) continue

        const lookupTask = (id?: string) => tasks.find((t) => t.id === id)?.name
        const lookupProject = (id: string) => projects.find((p) => p.id === id)
        conflicts.push({
          resourceId: r.id,
          resourceName: r.name,
          overlapDays,
          bookings: [
            { projectId: a.projectId, projectName: lookupProject(a.projectId)?.name || a.projectId, taskName: lookupTask(a.taskId), start: a.startDate, end: a.endDate },
            { projectId: b.projectId, projectName: lookupProject(b.projectId)?.name || b.projectId, taskName: lookupTask(b.taskId), start: b.startDate, end: b.endDate },
          ],
        })
      }
    }
  }
  return conflicts.sort((a, b) => b.overlapDays - a.overlapDays)
}

// ===== 进度趋势（过去 12 周 + 未来 4 周）=====
export interface TrendPoint {
  weekLabel: string
  weekDate: string
  avgProgress: number
  completedTasks: number
  newDelays: number
}

export function getProgressTrend(weeks = 12): TrendPoint[] {
  const result: TrendPoint[] = []
  const baseStart = startOfWeek(today, { weekStartsOn: 1 })
  for (let i = -weeks + 1; i <= 0; i++) {
    const w = addWeeks(baseStart, i)
    const weekIndex = i + weeks
    // 模拟：用 sigmoid 累进加上各项目当前进度的轻微随机化
    const t = weekIndex / weeks
    const sig = 1 / (1 + Math.exp(-6 * (t - 0.45)))
    const noise = Math.sin(weekIndex * 1.7) * 3
    const avgProgress = Math.max(0, Math.min(100, Math.round(sig * 60 + 15 + noise)))
    // 完成任务数：尾部加速
    const completed = Math.max(0, Math.round(2 + t * 8 + Math.cos(weekIndex * 1.2) * 2))
    // 新增延迟：早期波动
    const delays = Math.max(0, Math.round(1 + Math.sin(weekIndex * 0.8) * 1.5))
    result.push({
      weekLabel: format(w, 'MM/dd'),
      weekDate: format(w, 'yyyy-MM-dd'),
      avgProgress,
      completedTasks: completed,
      newDelays: delays,
    })
  }
  return result
}

// ===== 项目侧汇总 =====
export interface ProjectSummary {
  project: Project
  ownerName: string
  taskCount: number
  doneCount: number
  delayedCount: number
  upcomingMilestone?: { name: string; daysLeft: number }
  criticalPathCount: number
}

export function getProjectSummary(p: Project): ProjectSummary {
  const subIds = subProjects.filter((s) => s.projectId === p.id).map((s) => s.id)
  const myTasks = tasks.filter((t) => subIds.includes(t.subProjectId))
  const done = myTasks.filter(isTaskDone).length
  const delayed = myTasks.filter((t) => !isTaskDone(t) && (getTaskSchedule(t).state === 'overdue' || t.status === '延迟' || t.status === '阻塞')).length
  const cpCount = myTasks.filter((t) => t.isCriticalPath).length
  const upcoming = myTasks
    .filter((t) => t.isMilestone && !isTaskDone(t))
    .map((t) => ({
      name: t.name,
      daysLeft: differenceInCalendarDays(parseISO(t.plannedEnd), today),
    }))
    .sort((a, b) => a.daysLeft - b.daysLeft)[0]
  return {
    project: p,
    ownerName: findUser(p.ownerId)?.displayName || '-',
    taskCount: myTasks.length,
    doneCount: done,
    delayedCount: delayed,
    upcomingMilestone: upcoming,
    criticalPathCount: cpCount,
  }
}

// ===== 全局 KPI =====
export function getGlobalKpis(scope?: Scope) {
  const visibleP = visibleProjects(scope)
  const visibleT = visibleTasks(scope)
  const active = visibleP.filter((p) => p.status === '活跃').length
  const milestones = visibleT.filter((t) => t.isMilestone && !isTaskDone(t)).length
  const delayed = visibleT.filter(
    (t) => !isTaskDone(t) && (getTaskSchedule(t).state === 'overdue' || t.status === '延迟' || t.status === '阻塞')
  ).length
  // 预警：admin/cmc_lead 全部；其他角色仅本人项目相关
  let visibleAlerts = alerts
  if (scope && !scope.isAll) {
    visibleAlerts = alerts.filter((a) => {
      if (a.projectId && scope.projectIds.has(a.projectId)) return true
      if (a.taskId && scope.taskIds.has(a.taskId)) return true
      return false
    })
  }
  const unreadAlerts = visibleAlerts.filter((a) => !a.isRead).length
  return { active, milestones, delayed, unreadAlerts }
}
