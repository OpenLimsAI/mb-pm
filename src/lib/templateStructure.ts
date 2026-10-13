// 模板结构（三级 WBS 树）的纯函数编辑操作 —— 供模板编辑器复用、可测试。
//
// 结构：root（项目级）→ children = Lv2 子项目 → children = Lv3 任务/里程碑。
// 所有操作返回新树（不可变更新）。删除任务/子项目时会同步清理其它任务对被删 taskCode 的悬挂前驱。

import type { Module, SpecialtyGroup, Stage, TemplateNode } from '../types'

let _seq = 0
const uid = (prefix: string) => {
  _seq += 1
  return `${prefix}-${Date.now().toString(36)}-${_seq.toString(36)}`
}

export const cloneTree = (n: TemplateNode): TemplateNode => JSON.parse(JSON.stringify(n))

/** 版本号自增：V1.0 → V1.1；V3.6 → V3.7；非标准格式追加 .1。 */
export function nextVersionNumber(cur: string): string {
  const m = (cur || '').match(/^[vV]?(\d+)\.(\d+)$/)
  if (m) return `V${m[1]}.${parseInt(m[2], 10) + 1}`
  return cur ? `${cur}.1` : 'V1.1'
}

export interface TaskCodeRef { code: string; name: string; subName: string }

/** 列出全部 Lv3 任务的编号（前驱选择器用）。 */
export function allTaskCodes(root: TemplateNode): TaskCodeRef[] {
  const out: TaskCodeRef[] = []
  for (const sub of root.children ?? []) {
    for (const t of sub.children ?? []) {
      if (t.taskCode) out.push({ code: t.taskCode, name: t.name, subName: sub.name })
    }
  }
  return out
}

/** 子项目下一个任务编号（继承既有兄弟前缀，如 USP-016；空则用 module）。 */
export function nextTaskCode(sub: TemplateNode): string {
  const codes = (sub.children ?? []).map((c) => c.taskCode).filter((x): x is string => !!x)
  let prefix = sub.module || 'TASK'
  let maxN = 0
  for (const c of codes) {
    const m = c.match(/^(.*)-(\d+)$/)
    if (m) { prefix = m[1]; maxN = Math.max(maxN, parseInt(m[2], 10)) }
  }
  return `${prefix}-${String(maxN + 1).padStart(3, '0')}`
}

export interface SubFields { name: string; module?: Module; stage?: Stage }

export interface TaskFields {
  name: string
  isMilestone: boolean
  defaultRole?: SpecialtyGroup
  defaultDuration?: number
  defaultEffort?: number
  costBudget?: number
  description?: string
  ctdSection?: string
  output?: string
  regulatoryRef?: string
  /** 前驱任务编号集合（统一为 FS、lag 0）。 */
  predecessorCodes: string[]
}

const toPreds = (codes: string[]) => codes.map((taskCode) => ({ taskCode, type: 'FS' as const, lagDays: 0 }))

/** 把表单字段映射为 TemplateNode 的可写字段（不含 id/taskCode/module/stage，update 时保留）。 */
function fieldsToNode(f: TaskFields): Partial<TemplateNode> {
  const milestone = f.isMilestone
  return {
    name: f.name.trim() || '新任务',
    isMilestone: milestone,
    defaultRole: f.defaultRole,
    defaultDuration: milestone ? 0 : (f.defaultDuration ?? 0),
    defaultEffort: milestone ? 0 : (f.defaultEffort ?? 0),
    costBudget: f.costBudget,
    description: f.description?.trim() || undefined,
    ctdSection: f.ctdSection?.trim() || undefined,
    output: f.output?.trim() || undefined,
    regulatoryRef: f.regulatoryRef?.trim() || undefined,
    predecessors: f.predecessorCodes.length ? toPreds(f.predecessorCodes) : undefined,
  }
}

/** 反向：把现有节点读成表单字段（编辑回填用）。 */
export function nodeToFields(t: TemplateNode): TaskFields {
  return {
    name: t.name,
    isMilestone: !!t.isMilestone,
    defaultRole: t.defaultRole,
    defaultDuration: t.defaultDuration,
    defaultEffort: t.defaultEffort,
    costBudget: t.costBudget,
    description: t.description,
    ctdSection: t.ctdSection,
    output: t.output,
    regulatoryRef: t.regulatoryRef,
    predecessorCodes: (t.predecessors ?? []).map((p) => p.taskCode),
  }
}

// ============= 子项目操作 =============

export function addSubProject(root: TemplateNode, f: SubFields): TemplateNode {
  const next = cloneTree(root)
  if (!next.children) next.children = []
  next.children.push({ id: uid('sub'), name: f.name.trim() || '新子项目', module: f.module, stage: f.stage, children: [] })
  return next
}

export function updateSubProject(root: TemplateNode, subId: string, f: SubFields): TemplateNode {
  const next = cloneTree(root)
  const sub = next.children?.find((s) => s.id === subId)
  if (sub) {
    sub.name = f.name.trim() || sub.name
    sub.module = f.module
    sub.stage = f.stage
  }
  return next
}

export function deleteSubProject(root: TemplateNode, subId: string): TemplateNode {
  const next = cloneTree(root)
  const sub = next.children?.find((s) => s.id === subId)
  const removed = new Set((sub?.children ?? []).map((t) => t.taskCode).filter((x): x is string => !!x))
  next.children = (next.children ?? []).filter((s) => s.id !== subId)
  stripPredecessors(next, removed)
  return next
}

// ============= 任务操作 =============

/** 新增任务；index 为插入位置（缺省接在末尾）。 */
export function addTask(root: TemplateNode, subId: string, f: TaskFields, index?: number): TemplateNode {
  const next = cloneTree(root)
  const sub = next.children?.find((s) => s.id === subId)
  if (!sub) return next
  if (!sub.children) sub.children = []
  sub.children.splice(index ?? sub.children.length, 0, {
    id: uid('custom'),
    taskCode: nextTaskCode(sub),
    module: sub.module,
    stage: sub.stage,
    ...fieldsToNode(f),
  } as TemplateNode)
  return next
}

/** 移动任务到某子项目的 toIndex（按移动前的位置计）；可跨子项目，前置引用按编号保持不变。 */
export function moveTask(root: TemplateNode, taskId: string, toSubId: string, toIndex: number): TemplateNode {
  const next = cloneTree(root)
  const from = next.children?.find((s) => s.children?.some((t) => t.id === taskId))
  const to = next.children?.find((s) => s.id === toSubId)
  if (!from?.children || !to) return root
  const fromIndex = from.children.findIndex((t) => t.id === taskId)
  const index = from === to && fromIndex < toIndex ? toIndex - 1 : toIndex
  if (from === to && index === fromIndex) return root
  const [moving] = from.children.splice(fromIndex, 1)
  if (!to.children) to.children = []
  to.children.splice(index, 0, moving)
  return next
}

export function updateTask(root: TemplateNode, taskId: string, f: TaskFields): TemplateNode {
  const next = cloneTree(root)
  for (const sub of next.children ?? []) {
    const t = sub.children?.find((x) => x.id === taskId)
    if (t) { Object.assign(t, fieldsToNode(f)); break }
  }
  return next
}

export function deleteTask(root: TemplateNode, taskId: string): TemplateNode {
  const next = cloneTree(root)
  let removed: string | undefined
  for (const sub of next.children ?? []) {
    const found = sub.children?.find((t) => t.id === taskId)
    if (found) removed = found.taskCode
  }
  for (const sub of next.children ?? []) {
    if (sub.children) sub.children = sub.children.filter((t) => t.id !== taskId)
  }
  if (removed) stripPredecessors(next, new Set([removed]))
  return next
}

/** 从所有任务的前驱中移除给定 taskCode（删除任务/子项目后清理悬挂引用）。 */
function stripPredecessors(root: TemplateNode, codes: Set<string>) {
  if (codes.size === 0) return
  for (const sub of root.children ?? []) {
    for (const t of sub.children ?? []) {
      if (t.predecessors) t.predecessors = t.predecessors.filter((p) => !codes.has(p.taskCode))
    }
  }
}

/** Lv3 任务/里程碑计数（任务与里程碑互斥，口径与 lib/template.computeStats 一致；不把空子项目误计为任务）。 */
export function countStructure(root: TemplateNode): { subProjects: number; tasks: number; milestones: number } {
  const subs = root.children ?? []
  let tasks = 0
  let milestones = 0
  for (const sub of subs) {
    for (const t of sub.children ?? []) {
      if (t.isMilestone) milestones++
      else tasks++
    }
  }
  return { subProjects: subs.length, tasks, milestones }
}
