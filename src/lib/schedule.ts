// 任务进度 / 排程状态的单一事实来源。
//
// 之前各处各自用 `differenceInCalendarDays(plannedEnd, today)` 判断逾期，导致：
//   1. 已完成任务（实际已按时交付）仍显示「已逾期 N 天」——因为只看了计划结束 vs 今天，
//      没有判断任务是否已完成。这是 CTO 反馈的核心 bug。
//   2. 有的地方用 TODAY 锚点、有的地方用真实 `new Date()`，演示数据日期漂移、口径不一致。
//
// 统一规则（getTaskSchedule）：
//   - 已完成 / 已验证：看「实际结束 vs 计划结束」——按时完成 or 延期 N 天完成，永远不再算「逾期」。
//   - 未完成：看「计划结束 vs 今天」——逾期 / 今日到期 / 临期(≤7d) / 进行中 / 未开始。
//
// 所有展示「逾期 / 还剩 / 倒计时」的地方都应走这个 helper，保证全局口径一致。

import { differenceInCalendarDays, parseISO } from 'date-fns'
import type { Task } from '../types'
import { TODAY } from '../mock/tasks'

export type ScheduleState =
  | 'done-ontime' // 已完成且未超期
  | 'done-late' // 已完成但晚于计划
  | 'overdue' // 未完成且已过计划结束
  | 'due-today' // 今日到期
  | 'due-soon' // 临期（≤7 天）
  | 'in-progress' // 进行中、计划内
  | 'not-started' // 未开始、计划内

export type ScheduleTone = 'green' | 'amber' | 'red' | 'gray'

export interface ScheduleStatus {
  state: ScheduleState
  done: boolean
  /** 正=距计划结束剩余天数；负=逾期天数（仅未完成）。已完成任务为相对计划结束的偏差天数（≥0）。 */
  days: number
  /** 简短中文标签，如「已逾期 12 天」「按时完成」「还剩 5 天」。 */
  label: string
  tone: ScheduleTone
}

const DONE_STATUSES = new Set(['已完成', '已验证'])

export function isTaskDone(task: Pick<Task, 'status'>): boolean {
  return DONE_STATUSES.has(task.status)
}

/**
 * 计算任务的排程状态。`today` 默认使用与 mock 数据一致的 TODAY 锚点，
 * 调用方也可显式传入（例如未来接入真实系统时间）。
 */
export function getTaskSchedule(
  task: Pick<Task, 'status' | 'plannedEnd' | 'actualEnd'>,
  today: Date = TODAY,
): ScheduleStatus {
  const plannedEnd = parseISO(task.plannedEnd)

  // —— 已完成：按「实际 vs 计划」判定，绝不再算逾期 ——
  if (isTaskDone(task)) {
    const ref = task.actualEnd ? parseISO(task.actualEnd) : plannedEnd
    const slip = differenceInCalendarDays(ref, plannedEnd) // >0 = 延期完成
    if (slip > 0) {
      return { state: 'done-late', done: true, days: slip, label: `延期 ${slip} 天完成`, tone: 'amber' }
    }
    return { state: 'done-ontime', done: true, days: 0, label: '按时完成', tone: 'green' }
  }

  // —— 未完成：按「计划结束 vs 今天」判定 ——
  const left = differenceInCalendarDays(plannedEnd, today)
  if (left < 0) {
    return { state: 'overdue', done: false, days: left, label: `已逾期 ${-left} 天`, tone: 'red' }
  }
  if (left === 0) {
    return { state: 'due-today', done: false, days: 0, label: '今日到期', tone: 'amber' }
  }
  if (left <= 7) {
    return { state: 'due-soon', done: false, days: left, label: `还剩 ${left} 天`, tone: 'amber' }
  }
  if (task.status === '未开始') {
    return { state: 'not-started', done: false, days: left, label: `还剩 ${left} 天`, tone: 'gray' }
  }
  return { state: 'in-progress', done: false, days: left, label: `还剩 ${left} 天`, tone: 'gray' }
}

/** Tailwind 文字色映射，供徽标 / 倒计时数字复用。 */
export const scheduleToneText: Record<ScheduleTone, string> = {
  green: 'text-emerald-600',
  amber: 'text-amber-600',
  red: 'text-red-600',
  gray: 'text-ink-500',
}
