import { describe, expect, it } from 'vitest'
import { deleteChapter, restoreChapter } from './chapterActions'
import type { FormulaRow, Reference, Solution } from './types'

const reference = (id: string, sectionId: string, sourceId = 'paper-1'): Reference => ({
  id, sectionId, sourceId, title: '研究资料', excerpt: '研究条件和观察', locator: '方法章节', sourceVersion: '1',
})
const formulaRow = (id: string, evidenceIds: string[], verification: FormulaRow['verification'] = 'confirmed'): FormulaRow => ({
  id, evidenceIds, verification, material: '辅料', purpose: '稳定', specification: '研究级', amount: '5',
  unit: 'g', basis: '批次', range: '待验证', rationale: '专家判断',
})
const seed = (): Solution => ({
  id: 'one', title: '研究报告', projectName: '项目 A', productName: '研究制剂', ownerId: 'author', ownerName: '研究员',
  status: 'draft', revision: 1, version: 1, updatedAt: '2026-10-24T10:00:00Z',
  sections: [
    { id: 's1', title: '研究目标', content: '原始目标' },
    { id: 's2', title: '配方依据', content: '待删除的内容' },
    { id: 's3', title: '验证安排', content: '保留的验证计划' },
  ],
  references: [reference('r1', 's1'), reference('r2', 's2'), reference('r3', 's2'), reference('r4', 's3')],
  formula: [formulaRow('f1', ['r1', 'r2', 'r3']), formulaRow('f2', ['r4']), formulaRow('f3', ['r3'], 'pending')],
  reviewerId: null, reviewerName: '', reviewNotes: '', canEdit: true,
})

function deleted() {
  const original = seed()
  const result = deleteChapter(original, 's2')!
  return { original, ...result, current: { ...original, ...result.patch } }
}

describe('chapter deletion and restoration', () => {
  it('rejects missing chapters and preserves the last chapter', () => {
    const solution = seed()
    expect(deleteChapter(solution, 'missing')).toBeNull()
    expect(deleteChapter({ ...solution, sections: [solution.sections[0]] }, 's1')).toBeNull()
    expect(deleteChapter({ ...solution, sections: [] }, 's1')).toBeNull()
  })

  it('removes only chapter references and marks only affected formula rows pending', () => {
    const original = seed()
    const before = structuredClone(original)
    const result = deleteChapter(original, 's2')!
    expect(result.patch.sections.map(section => section.id)).toEqual(['s1', 's3'])
    expect(result.patch.references.map(item => item.id)).toEqual(['r1', 'r4'])
    expect(result.patch.formula).toEqual([
      { ...original.formula[0], evidenceIds: ['r1'], verification: 'pending' },
      original.formula[1],
      { ...original.formula[2], evidenceIds: [] },
    ])
    expect(result.affectedFormulaCount).toBe(2)
    expect(result.undo).toMatchObject({
      solutionId: 'one', section: original.sections[1], index: 1, previousSectionId: 's1', nextSectionId: 's3',
      references: [original.references[1], original.references[2]],
    })
    expect(result.undo.formulaBindings).toHaveLength(2)
    expect(result.undo.formulaBindings[0]).toMatchObject({
      rowId: 'f1', evidenceIds: ['r1', 'r2', 'r3'], verification: 'confirmed', afterEvidenceIds: ['r1'],
    })
    expect(original).toEqual(before)
  })

  it('allows deleting an empty chapter without changing unrelated evidence', () => {
    const original = seed()
    original.sections.push({ id: 'empty', title: '空章节', content: '' })
    const result = deleteChapter(original, 'empty')!
    expect(result.affectedFormulaCount).toBe(0)
    expect(result.undo.references).toEqual([])
    expect(result.undo.formulaBindings).toEqual([])
    expect(result.patch.formula).toEqual(original.formula)
    expect(result.patch.references).toEqual(original.references)
  })

  it.each(['s1', 's2', 's3'])('restores %s to its original position and restores untouched formula state', sectionId => {
    const original = seed()
    const deletion = deleteChapter(original, sectionId)!
    const current = { ...original, ...deletion.patch }
    const before = structuredClone(current)
    const patch = restoreChapter(current, deletion.undo)!
    expect(patch.sections).toEqual(original.sections)
    expect(patch.formula).toEqual(original.formula)
    expect(patch.references).toHaveLength(original.references.length)
    expect(patch.references).toEqual(expect.arrayContaining(original.references))
    expect(current).toEqual(before)
    expect(restoreChapter({ ...current, ...patch }, deletion.undo)).toBeNull()
    expect(restoreChapter({ ...current, id: 'another-report' }, deletion.undo)).toBeNull()
  })

  it('positions a restored chapter relative to surviving neighbors after other chapter changes', () => {
    const { current, undo } = deleted()
    const newSection = { id: 'new', title: '新增章', content: '后续编辑' }
    current.sections = [newSection, current.sections[0], current.sections[1]]
    expect(restoreChapter(current, undo)!.sections.map(section => section.id)).toEqual(['new', 's1', 's2', 's3'])
    current.sections = [newSection, current.sections[2]]
    expect(restoreChapter(current, undo)!.sections.map(section => section.id)).toEqual(['new', 's2', 's3'])
    current.sections = [newSection]
    expect(restoreChapter(current, undo)!.sections.map(section => section.id)).toEqual(['new', 's2'])
  })

  it('preserves newer chapter content, formula edits, and new or deliberately removed evidence', () => {
    const { current, undo } = deleted()
    current.sections[0] = { ...current.sections[0], content: '后来修改的目标' }
    current.references.push(reference('new-ref', 's3', 'new-paper'))
    current.formula[0] = { ...current.formula[0], amount: '10', rationale: '新的专家判断', evidenceIds: ['new-ref'] }
    const patch = restoreChapter(current, undo)!
    expect(patch.sections[0].content).toBe('后来修改的目标')
    expect(patch.formula[0]).toMatchObject({
      amount: '10', rationale: '新的专家判断', evidenceIds: ['new-ref', 'r2', 'r3'], verification: 'pending',
    })
    expect(patch.references).toContainEqual(reference('new-ref', 's3', 'new-paper'))
  })

  it('keeps a changed formula row pending even if its remaining evidence is unchanged', () => {
    const { current, undo } = deleted()
    current.formula[0] = { ...current.formula[0], amount: '10' }
    expect(restoreChapter(current, undo)!.formula[0]).toMatchObject({ amount: '10', verification: 'pending' })
  })

  it('preserves an explicit later verification change', () => {
    const { current, undo } = deleted()
    current.formula[2] = { ...current.formula[2], verification: 'confirmed' }
    expect(restoreChapter(current, undo)!.formula[2]).toMatchObject({ evidenceIds: ['r3'], verification: 'confirmed' })
  })

  it('does not resurrect a subsequently deleted formula row', () => {
    const { current, undo } = deleted()
    current.formula = current.formula.filter(row => row.id !== 'f1')
    expect(restoreChapter(current, undo)!.formula.map(row => row.id)).toEqual(['f2', 'f3'])
  })

  it('rejects restoration when subsequent additions have filled the chapter limit', () => {
    const { current, undo } = deleted()
    current.sections = Array.from({ length: 60 }, (_, index) => ({ id: `added-${index}`, title: '新增章', content: '' }))
    expect(restoreChapter(current, undo)).toBeNull()
    current.sections.pop()
    expect(restoreChapter(current, undo)!.sections).toHaveLength(60)
  })

  it('deduplicates restored references and evidence without replacing newer reference content', () => {
    const { current, undo } = deleted()
    const replacement = { ...undo.references[0], sourceId: 'replacement-paper', title: '后续引用', sectionId: 's3' }
    current.references.push(replacement, { ...undo.references[1] })
    current.formula[0] = { ...current.formula[0], evidenceIds: ['r1', 'r3'] }
    const patch = restoreChapter(current, undo)!
    expect(patch.references.filter(item => item.id === 'r2')).toEqual([replacement])
    expect(patch.references.filter(item => item.id === 'r3')).toEqual([undo.references[1]])
    expect(patch.formula[0]).toMatchObject({ evidenceIds: ['r1', 'r3'], verification: 'pending' })
    expect(patch.formula[2].evidenceIds).toEqual(['r3'])
  })

  it('keeps undo snapshots independent from later edits to input objects', () => {
    const { original, undo } = deleted()
    original.sections[1].title = '变更标题'
    original.references[1].title = '变更资料'
    original.formula[0].evidenceIds.push('new')
    original.formula[0].amount = '99'
    expect(undo.section.title).toBe('配方依据')
    expect(undo.references[0].title).toBe('研究资料')
    expect(undo.formulaBindings[0].evidenceIds).toEqual(['r1', 'r2', 'r3'])
    expect(undo.formulaBindings[0].originalRow).toMatchObject({ amount: '5', evidenceIds: ['r1', 'r2', 'r3'] })
  })
})
