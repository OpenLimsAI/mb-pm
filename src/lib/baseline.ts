// 计划基线对标 —— 计算「当前计划 vs 基线快照」的进度/成本偏移。
//
// 里程碑按 id 匹配：基线有、当前也有 → 计算计划结束日漂移；基线有、当前无 → 已移除；
// 当前有、基线无 → 新增。项目结束日与预算各自比较。正的漂移天数=比基线更晚（计划顺延）。

import { differenceInCalendarDays, parseISO } from 'date-fns'
import type { BaselineSnapshot, Project, Task } from '../types'

export type MilestoneDriftStatus = 'on' | 'slip' | 'ahead' | 'added' | 'removed'

export interface MilestoneDrift {
  id: string
  code: string
  name: string
  isCriticalPath: boolean
  baselineEnd: string | null
  currentEnd: string | null
  /** 当前计划结束 − 基线计划结束（天）；正=顺延/延后，负=提前。 */
  slipDays: number
  status: MilestoneDriftStatus
}

export interface BaselineComparison {
  baselineProjectEnd: string
  currentProjectEnd: string
  projectEndSlipDays: number
  baselineBudget: number
  currentBudget: number
  budgetDelta: number
  baselineTaskCount: number
  currentTaskCount: number
  taskCountDelta: number
  milestones: MilestoneDrift[]
  slippedCount: number
  aheadCount: number
  addedCount: number
  removedCount: number
  /** 最大单点里程碑顺延天数（仅取正值）。 */
  maxSlipDays: number
}

const daysBetween = (a: string, b: string): number =>
  differenceInCalendarDays(parseISO(a), parseISO(b))

export function compareBaseline(
  snapshot: BaselineSnapshot,
  project: Project,
  currentMilestones: Pick<Task, 'id' | 'code' | 'name' | 'plannedEnd' | 'isCriticalPath'>[],
  currentBudget: number,
  currentTaskCount: number,
): BaselineComparison {
  const baseById = new Map(snapshot.milestones.map((m) => [m.id, m]))
  const curById = new Map(currentMilestones.map((m) => [m.id, m]))

  const drifts: MilestoneDrift[] = []

  // 基线里程碑：匹配当前 → slip / removed
  for (const b of snapshot.milestones) {
    const cur = curById.get(b.id)
    if (!cur) {
      drifts.push({
        id: b.id, code: b.code, name: b.name, isCriticalPath: b.isCriticalPath,
        baselineEnd: b.plannedEnd, currentEnd: null, slipDays: 0, status: 'removed',
      })
      continue
    }
    const slip = daysBetween(cur.plannedEnd, b.plannedEnd)
    drifts.push({
      id: b.id, code: b.code, name: b.name, isCriticalPath: cur.isCriticalPath,
      baselineEnd: b.plannedEnd, currentEnd: cur.plannedEnd, slipDays: slip,
      status: slip > 0 ? 'slip' : slip < 0 ? 'ahead' : 'on',
    })
  }
  // 当前里程碑：基线没有 → added
  for (const c of currentMilestones) {
    if (!baseById.has(c.id)) {
      drifts.push({
        id: c.id, code: c.code, name: c.name, isCriticalPath: c.isCriticalPath,
        baselineEnd: null, currentEnd: c.plannedEnd, slipDays: 0, status: 'added',
      })
    }
  }

  // 排序：顺延最多在前，其次提前/新增/移除
  drifts.sort((a, b) => b.slipDays - a.slipDays)

  const slippedCount = drifts.filter((d) => d.status === 'slip').length
  const aheadCount = drifts.filter((d) => d.status === 'ahead').length
  const addedCount = drifts.filter((d) => d.status === 'added').length
  const removedCount = drifts.filter((d) => d.status === 'removed').length
  const maxSlipDays = drifts.reduce((m, d) => Math.max(m, d.slipDays), 0)

  return {
    baselineProjectEnd: snapshot.projectPlannedEnd,
    currentProjectEnd: project.plannedEnd,
    projectEndSlipDays: daysBetween(project.plannedEnd, snapshot.projectPlannedEnd),
    baselineBudget: snapshot.totalBudget,
    currentBudget,
    budgetDelta: currentBudget - snapshot.totalBudget,
    baselineTaskCount: snapshot.taskCount,
    currentTaskCount,
    taskCountDelta: currentTaskCount - snapshot.taskCount,
    milestones: drifts,
    slippedCount, aheadCount, addedCount, removedCount, maxSlipDays,
  }
}
