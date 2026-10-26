import { expect, test } from 'vitest'
import { amount, financeDraftState, toFinanceDraft } from './financeDraft'

const controls = [...Array.from({ length: 32 }, (_, code) => code), 127]
test.each(controls)('rejects embedded control character %i in year and notes', (code) => {
  for (const field of ['fiscalYear', 'notes'] as const) {
    const draft = toFinanceDraft(null, 100, '2026')
    draft[field] = 'a' + String.fromCharCode(code) + 'b'
    expect(financeDraftState(draft).invalid).toBe(true)
  }
})
test('retains unicode, trimming, amount limits and budget arithmetic', () => {
  const draft = toFinanceDraft(null, 100, ' 2026 ')
  draft.notes = '\t合成研发说明\n'
  draft.committed = '12.345'
  const result = financeDraftState(draft, 20)
  expect(result.invalid).toBe(false)
  expect(result.value.fiscalYear).toBe('2026')
  expect(result.value.notes).toBe('合成研发说明')
  expect(result.committed).toBe(12.35)
  expect(result.remaining).toBeCloseTo(67.65)
  expect(amount('')).toBe(0)
  expect(amount('-1')).toBeNull()
  expect(amount('100000000')).toBeNull()
})
