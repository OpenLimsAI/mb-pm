import type { Task, TaskStatus } from '../../types'
import type { TaskProgressPatch } from '../../data/bootstrap'

export interface ProgressDraft {
  status: TaskStatus; progress: number; plannedStart: string; plannedEnd: string
  actualStart: string; actualEnd: string; actualEffort: string; actualCost: string; note: string
}
export const draftFromTask = (task: Task): ProgressDraft => ({
  status: task.status, progress: task.progress, plannedStart: task.plannedStart, plannedEnd: task.plannedEnd,
  actualStart: task.actualStart ?? '', actualEnd: task.actualEnd ?? '',
  actualEffort: task.actualEffort != null ? String(task.actualEffort) : '',
  actualCost: task.actualCost != null ? String(task.actualCost) : '', note: '',
})
export function progressPatch(task: Task, draft: ProgressDraft, canPlan: boolean): TaskProgressPatch {
  const changes: TaskProgressPatch = {}
  if (draft.status !== task.status) changes.status = draft.status
  if (draft.progress !== task.progress) changes.progress = draft.progress
  if (canPlan && draft.plannedStart !== task.plannedStart) changes.plannedStart = draft.plannedStart
  if (canPlan && draft.plannedEnd !== task.plannedEnd) changes.plannedEnd = draft.plannedEnd
  if ((draft.actualStart || null) !== (task.actualStart ?? null)) changes.actualStart = draft.actualStart || null
  if ((draft.actualEnd || null) !== (task.actualEnd ?? null)) changes.actualEnd = draft.actualEnd || null
  const effort = draft.actualEffort === '' ? null : Number(draft.actualEffort)
  const cost = draft.actualCost === '' ? null : Number(draft.actualCost)
  if (effort !== (task.actualEffort ?? null)) changes.actualEffort = effort
  if (cost !== (task.actualCost ?? null)) changes.actualCost = cost
  if (draft.note.trim()) changes.progressNote = draft.note.trim()
  return changes
}
export const progressFingerprint = (task: Task) => JSON.stringify([task.revision, draftFromTask(task)])

const draftKey = (userId: string, taskId: string) => `mb-pm:task-draft:${userId}:${taskId}`
export function clearProgressDraft(userId: string, taskId: string) {
  try { sessionStorage.removeItem(draftKey(userId, taskId)) } catch { /* Draft recovery is optional. */ }
}
export function storeProgressDraft(userId: string, task: Task, draft: ProgressDraft) {
  try {
    sessionStorage.setItem(draftKey(userId, task.id), JSON.stringify({
      version: 1, expires: Date.now() + 24 * 60 * 60 * 1000,
      base: { ...draftFromTask(task), actualEffort: task.actualEffort, actualCost: task.actualCost, revision: task.revision }, draft,
    }))
  } catch { /* Saving business data never depends on browser storage. */ }
}
export function loadProgressDraft(userId: string, task: Task, canPlan: boolean): { base: Task; draft: ProgressDraft; restored: boolean } {
  const empty = { base: task, draft: draftFromTask(task), restored: false }
  try {
    const value = JSON.parse(sessionStorage.getItem(draftKey(userId, task.id)) || 'null')
    if (!value || value.version !== 1 || value.expires < Date.now() || !value.base || !value.draft) return empty
    const parsed: ProgressDraft = value.draft
    if (!['未开始', '进行中', '已完成', '已验证', '阻塞', '延迟'].includes(parsed.status) || !Number.isFinite(parsed.progress) || parsed.progress < 0 || parsed.progress > 100) return empty
    if (['plannedStart', 'plannedEnd', 'actualStart', 'actualEnd', 'actualEffort', 'actualCost', 'note'].some(key => typeof parsed[key as keyof ProgressDraft] !== 'string')) return empty
    if (parsed.note.length > 5000 || [parsed.actualEffort, parsed.actualCost].some(x => x !== '' && (!Number.isFinite(Number(x)) || Number(x) < 0))) return empty
    const baseDraft: ProgressDraft = value.base
    if (!['未开始', '进行中', '已完成', '已验证', '阻塞', '延迟'].includes(baseDraft.status) || !Number.isFinite(baseDraft.progress)) return empty
    const base = { ...task, status: baseDraft.status, progress: baseDraft.progress, plannedStart: baseDraft.plannedStart, plannedEnd: baseDraft.plannedEnd, actualStart: baseDraft.actualStart || undefined, actualEnd: baseDraft.actualEnd || undefined, actualEffort: value.base.actualEffort ?? undefined, actualCost: value.base.actualCost ?? undefined, revision: value.base.revision }
    if (!canPlan) { base.plannedStart = task.plannedStart; base.plannedEnd = task.plannedEnd; parsed.plannedStart = task.plannedStart; parsed.plannedEnd = task.plannedEnd }
    return { base, draft: parsed, restored: true }
  } catch { return empty }
}
