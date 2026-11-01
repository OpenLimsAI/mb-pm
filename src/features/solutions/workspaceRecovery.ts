import type { ConversationDraft } from './conversations'
import type { InlineQuestion } from './InlineAssistantEditor'
import type { Answer, Solution } from './types'

export const RECOVERY_TTL_MS = 2 * 60 * 60 * 1000
export const RECOVERY_MAX_CHARS = 240_000
const PREFIX = 'ks-workspace:v1:'
const MAX_REPORTS = 5
type SavedCard = Pick<InlineQuestion, 'id' | 'sectionId' | 'offset' | 'question' | 'includeContext' | 'status'>
export interface WorkspaceRecovery {
  reportId: string
  sectionId: string
  topicId: string
  question: string
  context: string
  showContext: boolean
  topicDrafts: Record<string, ConversationDraft>
  selectedSourceIds: string[]
  projectFilter: string
  inlineCards: SavedCard[]
  interrupted: boolean
  pendingTopicId: string
  listOpen: boolean
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max
}
function id(value: unknown): value is string {
  return text(value, 80) && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value) && !['constructor', 'prototype'].includes(value)
}
function draft(value: unknown): value is ConversationDraft {
  return object(value) && text(value.question, 4000) && text(value.context, 16000) && typeof value.showContext === 'boolean'
}
function valid(value: unknown): value is WorkspaceRecovery {
  if (!object(value) || !id(value.reportId) || !text(value.sectionId, 80) || !id(value.topicId)
    || !draft(value) || !object(value.topicDrafts) || Object.keys(value.topicDrafts).length > 20
    || !Object.entries(value.topicDrafts).every(([key, entry]) => id(key) && draft(entry))
    || !Array.isArray(value.selectedSourceIds) || value.selectedSourceIds.length > 100
    || !value.selectedSourceIds.every(source => text(source, 1200) && source.length > 0 && !Array.from(source).some(char => char.charCodeAt(0) < 32))
    || !text(value.projectFilter, 200) || typeof value.listOpen !== 'boolean'
    || typeof value.interrupted !== 'boolean' || !text(value.pendingTopicId, 80)
    || !Array.isArray(value.inlineCards) || value.inlineCards.length > 40) return false
  const seen = new Set<string>()
  return value.inlineCards.every(card => {
    if (!object(card) || !id(card.id) || seen.has(card.id) || !id(card.sectionId)
      || !Number.isSafeInteger(card.offset) || (card.offset as number) < 0 || (card.offset as number) > 50000
      || !text(card.question, 4000) || typeof card.includeContext !== 'boolean'
      || !['idle', 'asking', 'answered', 'error'].includes(card.status as string)) return false
    seen.add(card.id)
    return true
  })
}

/** Namespace comes only from the authenticated portal identity, never from cached claims. */
export function workspaceRecoveryScope(namespace: string | undefined, subject: string, preview: boolean): string | null {
  return namespace && namespace.length <= 1024 && subject && subject.length <= 255
    ? `${PREFIX}${encodeURIComponent(JSON.stringify([preview ? 'preview' : 'live', namespace, subject]))}:` : null
}

function fresh(value: unknown, now: number): value is { savedAt: number; state: WorkspaceRecovery } {
  return object(value) && typeof value.savedAt === 'number' && Number.isFinite(value.savedAt)
    && value.savedAt <= now + 30_000 && now - value.savedAt < RECOVERY_TTL_MS && valid(value.state)
}

export function readWorkspaceRecovery(scope: string | null, reportId?: string, now = Date.now()): WorkspaceRecovery | null {
  if (!scope) return null
  const key = scope + (reportId ? `report:${encodeURIComponent(reportId)}` : 'active')
  try {
    const raw = sessionStorage.getItem(key)
    if (!raw) return null
    const value: unknown = raw.length <= RECOVERY_MAX_CHARS ? JSON.parse(raw) : null
    if (!fresh(value, now) || reportId && value.state.reportId !== reportId) { sessionStorage.removeItem(key); return null }
    return value.state
  } catch { return null }
}

export function writeWorkspaceRecovery(scope: string | null, state: WorkspaceRecovery, now = Date.now()): boolean {
  if (!scope) return true
  try {
    // Store drafts and locations only. Answers, citations, roles, model keys and request IDs are never cached here.
    const minimal: WorkspaceRecovery = {
      reportId: state.reportId, sectionId: state.sectionId, topicId: state.topicId,
      question: state.question, context: state.context, showContext: state.showContext,
      topicDrafts: Object.fromEntries(Object.entries(state.topicDrafts).map(([key, entry]) => [key, { question: entry.question, context: entry.context, showContext: entry.showContext }])),
      selectedSourceIds: [...state.selectedSourceIds], projectFilter: state.projectFilter,
      inlineCards: state.inlineCards.map(({ id, sectionId, offset, question, includeContext, status }) => ({ id, sectionId, offset, question, includeContext, status })),
      interrupted: state.interrupted, pendingTopicId: state.pendingTopicId, listOpen: state.listOpen,
    }
    if (!valid(minimal)) return false
    const payload = JSON.stringify({ savedAt: now, state: minimal })
    if (payload.length > RECOVERY_MAX_CHARS) return false
    const owned = Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index))
      .filter((key): key is string => !!key?.startsWith(scope + 'report:'))
    const retained: { key: string; savedAt: number }[] = []
    for (const key of owned) {
      const raw = sessionStorage.getItem(key)
      let value: unknown
      try { value = raw && raw.length <= RECOVERY_MAX_CHARS ? JSON.parse(raw) : null } catch { value = null }
      if (!fresh(value, now)) sessionStorage.removeItem(key)
      else retained.push({ key, savedAt: value.savedAt })
    }
    const key = scope + `report:${encodeURIComponent(state.reportId)}`
    const others = retained.filter(item => item.key !== key).sort((a, b) => b.savedAt - a.savedAt)
    for (const entry of others.slice(MAX_REPORTS - 1)) sessionStorage.removeItem(entry.key)
    sessionStorage.setItem(key, payload)
    sessionStorage.setItem(scope + 'active', payload)
    return true
  } catch { return false }
}

export function discardWorkspaceRecovery(scope: string | null, reportId: string): void {
  if (!scope) return
  try {
    sessionStorage.removeItem(scope + `report:${encodeURIComponent(reportId)}`)
    if (readWorkspaceRecovery(scope)?.reportId === reportId) sessionStorage.removeItem(scope + 'active')
  } catch { /* Storage may be unavailable. */ }
}

/** Called only after a fresh authorized report read. Cached fields never grant editing access. */
export function recoveredInlineCards(saved: WorkspaceRecovery, report: Solution, subject: string, history: Answer[] = []): InlineQuestion[] {
  if (!report.canEdit || report.ownerId !== subject || report.status !== 'draft') return []
  return saved.inlineCards.flatMap(card => {
    const section = report.sections.find(entry => entry.id === card.sectionId)
    if (!section || card.offset > section.content.length) return []
    const before = section.content.charCodeAt(card.offset - 1), after = section.content.charCodeAt(card.offset)
    if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) return []
    const answer = history.findLast(item => item.conversationId === card.id && item.question === card.question.trim())
    return [{ ...card, status: answer ? 'answered' : card.status === 'idle' ? 'idle' : 'error', answer,
      error: answer || card.status === 'idle' ? undefined : '上次提问已中断。请先核对问答历史，再决定是否重试。' } satisfies InlineQuestion]
  })
}
