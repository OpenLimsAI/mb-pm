import { describe, expect, it } from 'vitest'
import { citationToken, normalizedReport, reportReferences, resolveCitations, remapCitationTokens, reportCaptions } from './reportReferences'
import { applyPolishChoices, polishChanges } from './polishDiff'
import type { Reference, Solution } from './types'
const refs = [
  { id: 'a', sourceId: 'paper', sourceVersion: 'v1', title: '论文', sectionId: 's1' },
  { id: 'b', sourceId: 'paper', sourceVersion: 'v1', title: '论文', sectionId: 's2' },
  { id: 'c', sourceId: 'other', sourceVersion: 'v1', title: '记录', sectionId: 's1' },
] as Reference[]
describe('report citations and reviewable AI changes', () => {
  it('numbers by first citation and deduplicates the same source across chapters', () => {
    const report = { references: refs, sections: [{ id: 's1', title: '一', content: citationToken('c') }, { id: 's2', title: '二', content: citationToken('b') + citationToken('a') }] }
    const index = reportReferences(report)
    expect(index).toHaveLength(2)
    expect(index[1].aliases).toEqual(['b', 'a'])
    expect(resolveCitations(report.sections[1].content, index)).toBe('[2][2]')
    expect(resolveCitations(citationToken('missing'), index)).toBe('[引用待核对]')
  })
  it('renumbers figures and tables independently in export order without mutating the report', () => {
    const report = { sections: [{ id: 's', title: '一', content: '图 9　观察\n\n表 8　结果\n\n图 2　条件' }] } as Solution
    expect(normalizedReport(report).sections[0].content).toBe('图 1　观察\n\n表 1　结果\n\n图 2　条件')
    expect(report.sections[0].content).toContain('图 9')
  })
  it('remaps copied citations and updates anchored figure cross references with reordered captions', () => {
    expect(remapCitationTokens(citationToken('a') + citationToken('missing'), new Map([['a', 'new-a']]))).toBe(citationToken('new-a') + citationToken('missing'))
    const report = { sections: [{ id: 's', title: '一', content: '[图 8　条件](#report-figure-f)\n\n[图 2　观察](#report-figure-g)\n\n参见[图 8](#report-figure-f)和[图 2](#report-figure-g)。' }] } as Solution
    expect(normalizedReport(report).sections[0].content).toContain('参见[图 1](#report-figure-f)和[图 2](#report-figure-g)')
    expect(reportCaptions(report).map(caption => caption.title)).toEqual(['条件', '观察'])
  })
  it('allows accepting one change and retaining another while preserving unchanged text', () => {
    const original = '初始结论。保持。下一条结论。', proposed = '修订结论。保持。新的结论。'
    const changes = polishChanges(original, proposed)
    expect(changes.filter(part => part.changed)).toHaveLength(2)
    expect(applyPolishChoices(changes, new Set([0]))).toBe('初始结论。保持。新的结论。')
    expect(applyPolishChoices(changes, new Set(changes.map((_, i) => i)))).toBe(original)
    expect(applyPolishChoices(changes, new Set())).toBe(proposed)
  })
})
