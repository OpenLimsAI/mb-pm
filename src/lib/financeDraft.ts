import type { ProjectFinanceInput } from '../api/finances'
import { FINANCE_CATEGORIES } from '../mock/finance'

const MAX_AMOUNT = 99_999_999
export const formatFinance = (v: number) => `¥${(Math.round(v * 100) / 100).toLocaleString('zh-CN')}万`

export type FinanceDraft = { totalBudget: string; committed: string; fiscalYear: string; notes: string; breakdown: Record<string, string> }

export function toFinanceDraft(finance: Partial<ProjectFinanceInput> | null | undefined, suggested: number, fiscalYear: string): FinanceDraft {
  const text = (v: number | undefined) => (v ? String(v) : '')
  return {
    totalBudget: finance ? String(finance.totalBudget) : suggested ? String(suggested) : '',
    committed: text(finance?.committed),
    fiscalYear: finance?.fiscalYear ?? fiscalYear,
    notes: finance?.notes ?? '',
    breakdown: Object.fromEntries(FINANCE_CATEGORIES.map((c) => [c, text(finance?.breakdown?.[c])])),
  }
}

/** 空串按 0；非法返回 null。 */
export function amount(value: string): number | null {
  if (!value.trim()) return 0
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 && n <= MAX_AMOUNT ? Math.round(n * 100) / 100 : null
}

export function financeDraftState(draft: FinanceDraft, spent = 0) {
  const total = amount(draft.totalBudget)
  const committed = amount(draft.committed)
  const parts = Object.fromEntries(FINANCE_CATEGORIES.map((c) => [c, amount(draft.breakdown[c] ?? '')]))
  const partsInvalid = Object.values(parts).some((v) => v === null)
  const partsTotal = Object.values(parts).reduce<number>((a, v) => a + (v ?? 0), 0)
  const totalMissing = !draft.totalBudget.trim()
  const invalid = totalMissing || total === null || committed === null || partsInvalid
    || draft.fiscalYear.trim().length > 20 || draft.notes.trim().length > 200
    || Array.from(draft.fiscalYear.trim() + draft.notes.trim()).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  const remaining = (total ?? 0) - spent - (committed ?? 0)
  const value: ProjectFinanceInput = {
    totalBudget: total ?? 0, committed: committed ?? 0,
    breakdown: Object.fromEntries(FINANCE_CATEGORIES.map((c) => [c, parts[c] ?? 0])),
    fiscalYear: draft.fiscalYear.trim() || null, notes: draft.notes.trim() || null,
  }
  return { total, committed, parts, partsInvalid, partsTotal, totalMissing, invalid, remaining, value }
}
