// 组合风险聚合 —— 把跨项目风险抽象为「进度族 + 质量族」两类来源，供首页风险预警消费。
//
// 设计意图（为后续偏差/批次/CAPA 模块预留注入点）：
//   · 进度族(schedule)：非质量门里程碑的逾期/临期 + 延迟/阻塞/逾期任务。
//   · 质量族(quality)：质量门里程碑（验证/鉴定/确认/放行/稳定性…）的逾期/临期 ——
//     这是当前数据即可派生的真实质量&合规风险；并声明「偏差未关闭 / CAPA 逾期 / 批次待放行」
//     等占位来源(connected=false)，待偏差/批次模块上线后从真实数据填充（见 QUALITY_INJECTION_POINTS）。
//   · 同一里程碑只归入一个族（按是否质量门），不重复计数。

import { differenceInCalendarDays, parseISO } from 'date-fns'
import type { Project, Task } from '../types'
import { isTaskDone } from './schedule'

export type RiskFamily = 'schedule' | 'quality'
export type RiskSeverity = 'high' | 'medium' | 'low'
export type RiskKind =
  | 'milestone-overdue' | 'milestone-due-soon'
  | 'task-overdue' | 'task-delayed' | 'task-blocked'
  | 'quality-gate-overdue' | 'quality-gate-due-soon'

export interface RiskItem {
  id: string
  family: RiskFamily
  kind: RiskKind
  title: string
  projectId: string
  projectCode: string
  ownerId?: string
  severity: RiskSeverity
  /** 简短中文徽标，如「逾期 12 天」「阻塞」。 */
  detail: string
  /** 距计划结束天数（负=逾期）；用于排序。 */
  days: number
  isCriticalPath?: boolean
}

/** 质量风险来源状态 —— connected=false 即为「待接入」占位与未来注入点。 */
export interface QualitySourceStatus {
  key: string
  label: string
  count: number
  connected: boolean
  note?: string
}

export interface PortfolioRisk {
  schedule: RiskItem[]
  quality: RiskItem[]
  qualitySources: QualitySourceStatus[]
  scheduleCount: number
  qualityCount: number
  totalCount: number
}

// 质量门关键词：命中即视为「质量/合规门里程碑」（验证/鉴定/确认/评审/放行/稳定性/寿命/SDM/PPQ 等）。
const QUALITY_GATE_KEYWORDS = [
  '验证', '鉴定', '确认', '评审', '放行', '稳定性', '寿命', '质量', '标准', 'SDM', 'PPQ', 'PV', 'QC',
]

function isQualityGate(t: Task): boolean {
  const text = `${t.name} ${t.notes ?? ''} ${(t.tags ?? []).join(' ')}`
  return QUALITY_GATE_KEYWORDS.some((k) => text.includes(k))
}

const SEV_RANK: Record<RiskSeverity, number> = { high: 0, medium: 1, low: 2 }

interface Ctx {
  activeProjects: Project[]
  activeTasks: Task[]
  projectOf: (t: Task) => string | undefined
  byId: Map<string, Project>
  today: Date
}

export function analyzePortfolioRisk(ctx: Ctx): PortfolioRisk {
  const { activeTasks, projectOf, byId, today } = ctx
  const schedule: RiskItem[] = []
  const quality: RiskItem[] = []

  // —— 里程碑：逾期 / 临期，按是否质量门分流 ——
  for (const t of activeTasks) {
    if (!t.isMilestone || isTaskDone(t)) continue
    const pid = projectOf(t)
    const proj = pid ? byId.get(pid) : undefined
    if (!proj) continue
    const days = differenceInCalendarDays(parseISO(t.plannedEnd), today)
    // 与首页既有口径一致：逾期(<0) / 临期(≤14d) / 非健康项目近端(≤90d) 才算风险
    const atRisk = days <= 14 || (proj.health !== 'green' && days <= 90)
    if (!atRisk) continue

    const overdue = days < 0
    const severity: RiskSeverity = overdue ? 'high' : days <= 14 ? 'medium' : 'low'
    const detail = overdue ? `逾期 ${-days} 天` : days === 0 ? '今日到期' : `还剩 ${days} 天`
    const qg = isQualityGate(t)
    const item: RiskItem = {
      id: t.id,
      family: qg ? 'quality' : 'schedule',
      kind: qg
        ? (overdue ? 'quality-gate-overdue' : 'quality-gate-due-soon')
        : (overdue ? 'milestone-overdue' : 'milestone-due-soon'),
      title: t.name,
      projectId: proj.id,
      projectCode: proj.code,
      ownerId: t.ownerId,
      severity,
      detail,
      days,
      isCriticalPath: t.isCriticalPath,
    }
    ;(qg ? quality : schedule).push(item)
  }

  // —— 任务：延迟 / 阻塞 / 逾期未完成（归进度族）——
  for (const t of activeTasks) {
    if (t.isMilestone || isTaskDone(t)) continue
    const pid = projectOf(t)
    const proj = pid ? byId.get(pid) : undefined
    if (!proj) continue
    const explicit = t.status === '延迟' || t.status === '阻塞'
    const overdueDays = differenceInCalendarDays(today, parseISO(t.plannedEnd))
    const overdue = overdueDays > 0 && t.progress < 100
    if (!explicit && !overdue) continue

    // 严重度口径差异（有意为之）：里程碑是点位事件，任何滑期即 high；任务带进度，分级更细 ——
    // 逾期 >14 天 high，其余（逾期或显式延迟/阻塞）至少 medium，不降级为 low/灰显。
    const severity: RiskSeverity = overdue && overdueDays > 14 ? 'high' : 'medium'
    schedule.push({
      id: t.id,
      family: 'schedule',
      kind: t.status === '阻塞' ? 'task-blocked' : explicit ? 'task-delayed' : 'task-overdue',
      title: t.name,
      projectId: proj.id,
      projectCode: proj.code,
      ownerId: t.ownerId,
      severity,
      detail: explicit ? t.status : `逾期 ${overdueDays} 天`,
      days: overdue ? -overdueDays : 0,
      isCriticalPath: t.isCriticalPath,
    })
  }

  const bySeverityThenDays = (a: RiskItem, b: RiskItem) =>
    SEV_RANK[a.severity] - SEV_RANK[b.severity] || a.days - b.days

  schedule.sort(bySeverityThenDays)
  quality.sort(bySeverityThenDays)

  // 质量风险来源：质量门里程碑已接入；偏差/CAPA/批次为占位注入点（见下）。
  const qualitySources: QualitySourceStatus[] = [
    { key: 'quality-gate', label: '质量门里程碑', count: quality.length, connected: true },
    ...QUALITY_INJECTION_POINTS,
  ]

  return {
    schedule,
    quality,
    qualitySources,
    scheduleCount: schedule.length,
    qualityCount: quality.length,
    totalCount: schedule.length + quality.length,
  }
}

// ============= 质量风险注入点（待偏差/批次模块上线后接入真实数据）=============
//
// 这些来源当前 connected=false、count=0，首页会优雅显示「待接入」。当对应模块就绪后，
// 把 count 改为真实统计、connected=true，并在 analyzePortfolioRisk 中把对应 RiskItem 推入 quality[]。
export const QUALITY_INJECTION_POINTS: QualitySourceStatus[] = [
  { key: 'deviation', label: '偏差未关闭', count: 0, connected: false, note: '待接入偏差模块' },
  { key: 'capa', label: 'CAPA 逾期', count: 0, connected: false, note: '待接入 CAPA 模块' },
  { key: 'batch', label: '批次待放行', count: 0, connected: false, note: '待接入批次模块' },
]
