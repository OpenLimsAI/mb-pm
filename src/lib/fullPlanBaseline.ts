import { findUser } from '../mock'
import type { Task, TaskDependency, BaselineSnapshot } from '../types'
import type { WorkingCalendar } from '../api/planning'
import type { ProgressMethod } from '../api/progressPolicy'

interface PlanTask {
  id: string; code: string; name: string; subProjectId: string; plannedStart: string; plannedEnd: string
  ownerId: string; collaboratorIds?: string[]; estimatedEffort: number; costBudget?: number | null
  isMilestone: boolean; isCriticalPath: boolean
  progressWeight?: number | null
}
export interface FullPlanSnapshot extends BaselineSnapshot {
  schemaVersion?: number; tasks?: PlanTask[]; dependencies?: TaskDependency[]; calendar?: WorkingCalendar
  progressMethod?: ProgressMethod
}
const fields: [keyof PlanTask, string][] = [['name', '名称'], ['subProjectId', '子项目'], ['plannedStart', '开始'], ['plannedEnd', '结束'], ['ownerId', '负责人'], ['collaboratorIds', '协作者'], ['estimatedEffort', '预计工时(人天)'], ['costBudget', '预算(万元)'], ['isMilestone', '里程碑'], ['isCriticalPath', '关键标志'], ['progressWeight', '进度权重']]
const valueText = (field: keyof PlanTask, value: unknown) => {
  if (field === 'progressWeight' && (value === undefined || value === null)) return '默认'
  if (value === undefined || value === null) return '未填'
  if (field === 'ownerId') return findUser(String(value))?.displayName ?? String(value)
  if (field === 'collaboratorIds') return (value as string[]).map(id => findUser(id)?.displayName ?? id).join('、') || '无'
  if (typeof value === 'boolean') return value ? '是' : '否'
  return String(value)
}
const normalized = (value: unknown) => JSON.stringify(Array.isArray(value) ? [...value].sort() : value ?? null)
const edgeKey = (edge: TaskDependency) => `${edge.predecessorId}→${edge.successorId} ${edge.type} ${edge.lagDays}d`
const edgeLabel = (edge: TaskDependency, names: Map<string, { name: string }>) => `${names.get(edge.predecessorId)?.name ?? edge.predecessorId} · ${edge.type} ${edge.lagDays >= 0 ? "+" : ""}${edge.lagDays} 工作日`
export function fullPlanDifferences(snapshot: FullPlanSnapshot, currentTasks: Task[], currentDeps: TaskDependency[]) {
  const base = new Map((snapshot.tasks ?? []).map(task => [task.id, task]))
  const current = new Map(currentTasks.map(task => [task.id, task]))
  const rows: { id: string; name: string; kind: string; changes: string[] }[] = []
  for (const old of base.values()) {
    const task = current.get(old.id)
    if (!task) rows.push({ id: old.id, name: old.name, kind: '已删除', changes: [`原计划 ${old.plannedStart} → ${old.plannedEnd}`] })
    else {
      const changes = fields.filter(([field]) => (field !== 'progressWeight' || Object.hasOwn(old, 'progressWeight')) && normalized(field === 'collaboratorIds' ? old[field] ?? [] : old[field]) !== normalized(field === 'collaboratorIds' ? task[field] ?? [] : task[field])).map(([field, label]) => `${label}：${valueText(field, old[field])} → ${valueText(field, task[field])}`)
      const oldEdges = (snapshot.dependencies ?? []).filter(edge => edge.successorId === task.id).map(edgeKey).sort()
      const newEdges = currentDeps.filter(edge => edge.successorId === task.id).map(edgeKey).sort()
      if (normalized(oldEdges) !== normalized(newEdges)) {
        const oldLabels = (snapshot.dependencies ?? []).filter(edge => edge.successorId === task.id).map(edge => edgeLabel(edge, base))
        const newLabels = currentDeps.filter(edge => edge.successorId === task.id).map(edge => edgeLabel(edge, current))
        changes.push(`前置依赖：${oldLabels.join('；') || '无'} → ${newLabels.join('；') || '无'}`)
      }
      if (changes.length) rows.push({ id: task.id, name: task.name, kind: '已调整', changes })
    }
  }
  for (const task of currentTasks) if (!base.has(task.id)) rows.push({ id: task.id, name: task.name, kind: '新增', changes: [`计划 ${task.plannedStart} → ${task.plannedEnd}`] })
  return rows
}
