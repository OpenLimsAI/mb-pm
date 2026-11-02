import type { AnswerMode } from '../answerModes/types'
export interface AssistantDraft { question: string; context: string; label: string }
export interface Preferences { answerMode: AnswerMode; model: string }
const MAX_AGE = 7 * 24 * 60 * 60 * 1000
const key = (scope: string, task: string) => `assistant-draft:v1:${encodeURIComponent(scope)}:${encodeURIComponent(task)}`
export function readDraft(scope: string, task: string): AssistantDraft | undefined {
  try {
    for (const storedKey of Object.keys(localStorage)) { if (!storedKey.startsWith('assistant-draft:v1:')) continue; try { const saved = JSON.parse(localStorage.getItem(storedKey) || '{}'); if (typeof saved.savedAt === 'number' && Date.now() - saved.savedAt > MAX_AGE) localStorage.removeItem(storedKey) } catch { /* Do not overwrite unreadable records. */ } }
    const raw = localStorage.getItem(key(scope, task))
    if (!raw) return
    const row = JSON.parse(raw)
    if (typeof row.savedAt !== 'number' || Date.now() - row.savedAt > MAX_AGE) { localStorage.removeItem(key(scope, task)); return }
    if (typeof row.question === 'string' && row.question.length <= 12000 && typeof row.context === 'string' && row.context.length <= 20000 && typeof row.label === 'string') return { question: row.question, context: row.context, label: row.label.slice(0, 300) }
  } catch { /* Storage is optional. */ }
}
export function writeDraft(scope: string, task: string, draft: AssistantDraft) {
  try { const existing = localStorage.getItem(key(scope, task)); if (existing) { try { const old = JSON.parse(existing); if (old.question === draft.question && old.context === draft.context && old.label === draft.label) return true } catch { /* Replace only this actively edited draft. */ } } if (!draft.question && !draft.context) localStorage.removeItem(key(scope, task)); else localStorage.setItem(key(scope, task), JSON.stringify({ ...draft, savedAt: Date.now() })); return true } catch { return false }
}
export function readPreferences(scope: string, task = 'default'): Partial<Preferences> {
  try { const row = JSON.parse(localStorage.getItem(`assistant-preferences:${scope}:${task}`) || '{}'); return { ...(['auto', 'general', 'knowledge', 'web'].includes(row.answerMode) ? { answerMode: row.answerMode } : {}), ...(typeof row.model === 'string' && row.model.length < 100 ? { model: row.model } : {}) } } catch { return {} }
}
export function writePreferences(scope: string, task: string, preferences: Preferences) {
  try { localStorage.setItem(`assistant-preferences:${scope}:${task}`, JSON.stringify(preferences)) } catch { /* Best effort. */ }
}
