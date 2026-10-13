// 项目结构编辑草稿（编辑模式）—— 纯函数、不可变更新；保存时整体提交（后端一个事务）。
//
// 已有对象的 key 就是其 id，新建对象用 new-* 临时 key；前置依赖一律用 key 引用。
// 规则与后端 services/structure.py 一致：已开始或已录实际花费的任务不能删；不自动顺延日期，只提示冲突。

import type { Module, Stage, TaskStatus } from '../types'
import type { StructureSaveRequest, StructureSnapshot } from '../api/structure'
import { detectCycle } from './dependency-utils'

export interface DraftTask {
  key: string
  id: string | null
  code: string
  name: string
  isMilestone: boolean
  ownerId: string
  plannedStart: string
  plannedEnd: string
  estimatedEffort: number
  costBudget: number | null
  notes: string
  predecessors: string[]
  status: TaskStatus
  progress: number
  lockedReason: string | null
}

export interface DraftSub {
  key: string
  id: string | null
  name: string
  module?: Module
  stage?: Stage
  tasks: DraftTask[]
}

export interface ProjectDraft {
  version: string
  projectCode: string
  projectStart: string
  ownerId: string
  subs: DraftSub[]
}

export interface TaskInput {
  name: string
  isMilestone: boolean
  ownerId: string
  plannedStart: string
  plannedEnd: string
  estimatedEffort: number
  costBudget: number | null
  notes: string
  predecessors: string[]
}

const DAY = 86400000
const toUTC = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10))

/** 计划工期（天）= 计划结束 − 计划开始，与模板实例化的口径一致。 */
export const durationDays = (start: string, end: string) => Math.max(0, Math.round((toUTC(end) - toUTC(start)) / DAY))
export const addDays = (d: string, days: number) => new Date(toUTC(d) + days * DAY).toISOString().slice(0, 10)

export function fromSnapshot(snap: StructureSnapshot): ProjectDraft {
  const preds = new Map<string, string[]>()
  for (const d of snap.dependencies) {
    preds.set(d.successorId, [...(preds.get(d.successorId) ?? []), d.predecessorId])
  }
  const taskIds = new Set(snap.tasks.map((t) => t.id))
  return {
    version: snap.version,
    projectCode: snap.project.code,
    projectStart: snap.project.plannedStart,
    ownerId: snap.project.ownerId,
    subs: [...snap.subProjects]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((s) => ({
        key: s.id,
        id: s.id,
        name: s.name,
        module: s.module as Module,
        stage: s.stage as Stage,
        tasks: snap.tasks
          .filter((t) => t.subProjectId === s.id)
          .sort((a, b) => a.code.localeCompare(b.code))
          .map((t) => ({
            key: t.id,
            id: t.id,
            code: t.code,
            name: t.name,
            isMilestone: t.isMilestone,
            ownerId: t.ownerId,
            plannedStart: t.plannedStart,
            plannedEnd: t.plannedEnd,
            estimatedEffort: t.estimatedEffort,
            costBudget: t.costBudget,
            notes: t.notes ?? '',
            // 跨项目的依赖不在编辑模式里管理
            predecessors: (preds.get(t.id) ?? []).filter((p) => taskIds.has(p)),
            status: t.status,
            progress: t.progress,
            lockedReason: t.lockedReason,
          })),
      })),
  }
}

export function toSaveRequest(draft: ProjectDraft, summary: string): StructureSaveRequest {
  return {
    version: draft.version,
    summary: summary.trim() || undefined,
    subProjects: draft.subs.map((s) => ({
      id: s.id,
      key: s.key,
      name: s.name.trim(),
      module: s.module ?? '',
      stage: s.stage ?? '',
      tasks: s.tasks.map((t) => ({
        id: t.id,
        key: t.key,
        code: t.code,
        name: t.name.trim(),
        isMilestone: t.isMilestone,
        ownerId: t.ownerId,
        plannedStart: t.plannedStart,
        // 里程碑是时间点（结束 = 开始）；工时原样提交 —— 模板生成的里程碑可能带工时，不能因保存其他修改被清零
        plannedEnd: t.isMilestone ? t.plannedStart : t.plannedEnd,
        estimatedEffort: t.estimatedEffort,
        costBudget: t.costBudget,
        notes: t.notes.trim() || null,
        predecessors: t.predecessors,
      })),
    })),
  }
}

/** 草稿是否有改动（与进入编辑模式时的结构比较）。 */
export const sameStructure = (a: ProjectDraft, b: ProjectDraft) =>
  JSON.stringify(toSaveRequest(a, '')) === JSON.stringify(toSaveRequest(b, ''))

export const allTasks = (draft: ProjectDraft) => draft.subs.flatMap((s) => s.tasks.map((t) => ({ task: t, sub: s })))

export function counts(draft: ProjectDraft) {
  const tasks = draft.subs.flatMap((s) => s.tasks)
  return { subProjects: draft.subs.length, tasks: tasks.filter((t) => !t.isMilestone).length, milestones: tasks.filter((t) => t.isMilestone).length }
}

/** 保存前的必填检查；返回第一条问题，没有则为 null。 */
export function draftProblem(draft: ProjectDraft): string | null {
  for (const s of draft.subs) {
    if (!s.name.trim()) return '有子项目没有填写名称'
    if (!s.module || !s.stage) return `子项目「${s.name}」需要选择模块和阶段`
  }
  return null
}

// ============= 子项目 =============

let seq = 0
const newKey = (prefix: string) => `new-${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`

export function addSub(draft: ProjectDraft, f: { name: string; module?: Module; stage?: Stage }): ProjectDraft {
  return { ...draft, subs: [...draft.subs, { key: newKey('sp'), id: null, name: f.name, module: f.module, stage: f.stage, tasks: [] }] }
}

export function updateSub(draft: ProjectDraft, key: string, f: { name: string; module?: Module; stage?: Stage }): ProjectDraft {
  return { ...draft, subs: draft.subs.map((s) => (s.key === key ? { ...s, name: f.name, module: f.module, stage: f.stage } : s)) }
}

export const subDeleteBlocked = (sub: DraftSub) =>
  sub.tasks.some((t) => t.lockedReason) ? '含已开始或已录实际花费的任务，不能删除' : null

export function deleteSub(draft: ProjectDraft, key: string): ProjectDraft {
  const sub = draft.subs.find((s) => s.key === key)
  if (!sub || subDeleteBlocked(sub)) return draft
  const removed = new Set(sub.tasks.map((t) => t.key))
  return {
    ...draft,
    subs: draft.subs
      .filter((s) => s.key !== key)
      .map((s) => ({ ...s, tasks: s.tasks.map((t) => ({ ...t, predecessors: t.predecessors.filter((p) => !removed.has(p)) })) })),
  }
}

// ============= 任务 =============

const MODULE_CODES: Record<string, string> = {
  细胞株: 'CLD', USP: 'USP', DSP: 'DSP', DP: 'DP', 分析方法: 'AM', 稳定性: 'STB', 工艺验证: 'PV', CTD: 'CTD', 其他: 'OTH',
}

/** 新任务编号：沿用该子项目已有编号的前缀并顺延（如 CMB820-USP-016）；空子项目按「项目编号-模块-001」。 */
export function nextTaskCode(draft: ProjectDraft, subKey: string): string {
  const sub = draft.subs.find((s) => s.key === subKey)
  const used = new Set(allTasks(draft).map(({ task }) => task.code))
  const pattern = /^(.*?)(\d+)$/
  const counts = new Map<string, number>()
  for (const t of sub?.tasks ?? []) {
    const m = pattern.exec(t.code)
    if (m) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1)
  }
  const prefix = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    ?? `${draft.projectCode}-${MODULE_CODES[sub?.module ?? ''] ?? 'T'}-`
  let max = 0
  let width = 3
  for (const code of used) {
    const m = pattern.exec(code)
    if (m && m[1] === prefix) {
      max = Math.max(max, Number(m[2]))
      width = Math.max(width, m[2].length)
    }
  }
  let n = max + 1
  while (used.has(`${prefix}${String(n).padStart(width, '0')}`)) n++
  return `${prefix}${String(n).padStart(width, '0')}`
}

export function addTask(draft: ProjectDraft, subKey: string, input: TaskInput): ProjectDraft {
  const task: DraftTask = {
    key: newKey('t'),
    id: null,
    code: nextTaskCode(draft, subKey),
    ...input,
    status: '未开始',
    progress: 0,
    lockedReason: null,
  }
  return { ...draft, subs: draft.subs.map((s) => (s.key === subKey ? { ...s, tasks: [...s.tasks, task] } : s)) }
}

export function updateTask(draft: ProjectDraft, key: string, input: TaskInput): ProjectDraft {
  return { ...draft, subs: draft.subs.map((s) => ({ ...s, tasks: s.tasks.map((t) => (t.key === key ? { ...t, ...input } : t)) })) }
}

export function deleteTask(draft: ProjectDraft, key: string): ProjectDraft {
  const target = allTasks(draft).find(({ task }) => task.key === key)?.task
  if (!target || target.lockedReason) return draft
  return {
    ...draft,
    subs: draft.subs.map((s) => ({
      ...s,
      tasks: s.tasks.filter((t) => t.key !== key).map((t) => ({ ...t, predecessors: t.predecessors.filter((p) => p !== key) })),
    })),
  }
}

/** 把「pred 作为 task 的前置」加进去是否会成环。 */
export function wouldCycle(draft: ProjectDraft, taskKey: string, predKey: string): boolean {
  if (taskKey === predKey) return true
  const edges = allTasks(draft).flatMap(({ task }) =>
    task.predecessors.map((p) => ({ id: '', predecessorId: p, successorId: task.key, type: 'FS' as const, lagDays: 0 })),
  )
  return detectCycle(edges, [{ predecessorId: predKey, successorId: taskKey }])
}

/** 日期冲突：开始早于某个前置任务的结束（不自动顺延，只提示）。 */
export function dateConflicts(draft: ProjectDraft): Map<string, string> {
  const byKey = new Map(allTasks(draft).map(({ task }) => [task.key, task]))
  const result = new Map<string, string>()
  for (const { task } of allTasks(draft)) {
    const late = task.predecessors
      .map((p) => byKey.get(p))
      .filter((p): p is DraftTask => !!p && (p.isMilestone ? p.plannedStart : p.plannedEnd) > task.plannedStart)
    if (late.length) {
      const latest = late.reduce((a, b) => ((a.isMilestone ? a.plannedStart : a.plannedEnd) > (b.isMilestone ? b.plannedStart : b.plannedEnd) ? a : b))
      result.set(task.key, `开始早于前置 ${latest.code} 的结束（${latest.isMilestone ? latest.plannedStart : latest.plannedEnd}）`)
    }
  }
  return result
}

/** 前置任务中最晚的结束日期（新建任务的默认开始 / 一键修正冲突用）。 */
export function latestPredecessorEnd(draft: ProjectDraft, predecessors: string[]): string | null {
  const byKey = new Map(allTasks(draft).map(({ task }) => [task.key, task]))
  const ends = predecessors.map((p) => byKey.get(p)).filter((p): p is DraftTask => !!p).map((p) => (p.isMilestone ? p.plannedStart : p.plannedEnd))
  return ends.length ? ends.sort().at(-1)! : null
}
