import { describe, expect, it } from 'vitest'
import { applyPolishChoices, polishChangeGroups, polishChanges } from './polishDiff'

describe('polish diff presentation groups', () => {
  it('recognizes the expert-template blank lines and punctuation spacing as layout, without changing either text', () => {
    const original = '专家判断\n结论:\n支持 / 反对的依据:\n适用条件:\n选择理由:'
    const proposed = '专家判断\n\n结论:\n\n支持/反对的依据:\n\n适用条件:\n\n选择理由:'
    const changes = polishChanges(original, proposed)
    const groups = polishChangeGroups(changes)
    expect(groups.text).toEqual([])
    expect(groups.layout.length).toBeGreaterThan(0)
    expect(applyPolishChoices(changes, new Set())).toBe(proposed)
    expect(applyPolishChoices(changes, new Set(groups.layout))).toBe(original)
  })

  it('keeps meaningful word boundaries and numeric spacing in the text review', () => {
    for (const [original, proposed] of [['not able', 'notable'], ['1 00 mg', '100 mg'], ['1 . 5', '1.5']]) {
      const groups = polishChangeGroups(polishChanges(original, proposed))
      expect(groups.text.length).toBeGreaterThan(0)
    }
  })

  it('separates an added blank line from a changed conclusion and retains the raw choice indexes', () => {
    const original = '旧结论。\n稳定句。', proposed = '新结论。\n\n稳定句。'
    const changes = polishChanges(original, proposed), groups = polishChangeGroups(changes)
    expect(groups.text.length).toBeGreaterThan(0)
    expect(groups.layout.length).toBeGreaterThan(0)
    expect(applyPolishChoices(changes, new Set(groups.text))).toBe('旧结论。\n\n稳定句。')
    expect(applyPolishChoices(changes, new Set(groups.layout))).toBe('新结论。\n稳定句。')
  })
})
