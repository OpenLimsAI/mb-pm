// Mock 数据统一出口
export * from './users'
export * from './dictionaries'
export * from './projects'
export * from './tasks'
export * from './templates'
export * from './resources'
export * from './production'
export * from './finance'
export * from './baselines'

import { users } from './users'
import { projects } from './projects'
import { subProjects, tasks, TODAY } from './tasks'
import { byWbsOrder } from '../lib/taskOrder'

// 工具函数
export const findUser = (id: string) => users.find((u) => u.id === id)
export const findProject = (id: string) => projects.find((p) => p.id === id)
export const findSubProject = (id: string) => subProjects.find((s) => s.id === id)
export const findTask = (id: string) => tasks.find((t) => t.id === id)

export const getProjectSubs = (projectId: string) => subProjects.filter((s) => s.projectId === projectId)
/** 子项目下的任务，按 WBS 显示顺序（手动顺序）排列 */
export const getSubTasks = (subId: string) => tasks.filter((t) => t.subProjectId === subId).sort(byWbsOrder)
export const getProjectTasks = (projectId: string) => {
  const subIds = subProjects.filter((s) => s.projectId === projectId).map((s) => s.id)
  return tasks.filter((t) => subIds.includes(t.subProjectId))
}

// 计算用户当前周负荷率（FR-SW-001）
export const calcWorkload = (userId: string) => {
  const user = findUser(userId)
  if (!user) return { rate: 0, allocatedHours: 0, availableHours: 40 }
  const today = TODAY  // 全局统一的「今日」（本机当前日期）
  const weekStart = new Date(today)
  weekStart.setDate(today.getDate() - today.getDay() + 1)
  const weekEnd = new Date(weekStart)
  weekEnd.setDate(weekStart.getDate() + 6)

  let allocated = 0
  for (const t of tasks) {
    if (t.ownerId !== userId) continue
    if (t.status === '已完成' || t.status === '已验证') continue
    if (t.isMilestone) continue
    const ts = new Date(t.plannedStart)
    const te = new Date(t.plannedEnd)
    if (te < weekStart || ts > weekEnd) continue
    // 简化：把任务工时按计划区间均摊到本周
    const totalDays = Math.max(1, Math.ceil((te.getTime() - ts.getTime()) / 86400000))
    const overlapStart = ts > weekStart ? ts : weekStart
    const overlapEnd = te < weekEnd ? te : weekEnd
    const overlapDays = Math.max(0, Math.ceil((overlapEnd.getTime() - overlapStart.getTime()) / 86400000) + 1)
    allocated += (t.estimatedEffort / totalDays) * overlapDays * 8 // 1 人天 = 8h
  }
  const available = user.weeklyAvailableHours
  return {
    rate: Math.round((allocated / available) * 100),
    allocatedHours: Math.round(allocated * 10) / 10,
    availableHours: available,
  }
}
