import type { FormulaRow, Reference, Section, Solution } from './types'

type ChapterPatch = Pick<Solution, 'sections' | 'references' | 'formula'>

interface FormulaBinding {
  rowId: string
  originalRow: FormulaRow
  evidenceIds: string[]
  verification: FormulaRow['verification']
  afterEvidenceIds: string[]
}

export interface DeletedChapter {
  solutionId: string
  section: Section
  index: number
  previousSectionId: string | null
  nextSectionId: string | null
  references: Reference[]
  formulaBindings: FormulaBinding[]
  promotedChildren?: { id: string; parentId: string | null }[]
}

export function deleteChapter(solution: Solution, sectionId: string): {
  patch: ChapterPatch
  undo: DeletedChapter
  affectedFormulaCount: number
} | null {
  const index = solution.sections.findIndex(section => section.id === sectionId)
  if (index < 0 || solution.sections.length <= 1) return null

  const references = solution.references.filter(reference => reference.sectionId === sectionId)
  const removedReferenceIds = new Set(references.map(reference => reference.id))
  const formulaBindings: FormulaBinding[] = []
  const formula = solution.formula.map(row => {
    const evidenceIds = row.evidenceIds.filter(id => !removedReferenceIds.has(id))
    if (evidenceIds.length === row.evidenceIds.length) return row

    formulaBindings.push({
      rowId: row.id,
      originalRow: { ...row, evidenceIds: [...row.evidenceIds] },
      evidenceIds: [...row.evidenceIds],
      verification: row.verification,
      afterEvidenceIds: [...evidenceIds],
    })
    return { ...row, evidenceIds, verification: 'pending' as const }
  })

  return {
    patch: {
      sections: solution.sections.filter(section => section.id !== sectionId).map(section => section.parentId === sectionId ? { ...section, parentId: solution.sections[index].parentId || null } : section),
      references: solution.references.filter(reference => reference.sectionId !== sectionId),
      formula,
    },
    undo: {
      solutionId: solution.id,
      section: { ...solution.sections[index] },
      index,
      previousSectionId: solution.sections[index - 1]?.id ?? null,
      nextSectionId: solution.sections[index + 1]?.id ?? null,
      references: references.map(reference => ({ ...reference })),
      formulaBindings,
      promotedChildren: solution.sections.filter(section => section.parentId === sectionId).map(section => ({ id: section.id, parentId: solution.sections[index].parentId || null })),
    },
    affectedFormulaCount: formulaBindings.length,
  }
}

function sameIds(left: string[], right: string[]) {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

function matchesDeletedRow(row: FormulaRow, binding: FormulaBinding) {
  const original = binding.originalRow
  return row.verification === 'pending'
    && sameIds(row.evidenceIds, binding.afterEvidenceIds)
    && (Object.keys(original) as (keyof FormulaRow)[])
      .filter(key => key !== 'evidenceIds' && key !== 'verification')
      .every(key => row[key] === original[key])
}

function sameReference(left: Reference, right: Reference) {
  return (Object.keys(right) as (keyof Reference)[]).every(key => left[key] === right[key])
}

export function restoreChapter(solution: Solution, undo: DeletedChapter): ChapterPatch | null {
  if (solution.id !== undo.solutionId || solution.sections.length >= 60
    || solution.sections.some(section => section.id === undo.section.id)) return null

  const sections = solution.sections.map(section => undo.promotedChildren?.some(child => child.id === section.id && (section.parentId || null) === child.parentId) ? { ...section, parentId: undo.section.id } : section)
  const previousIndex = sections.findIndex(section => section.id === undo.previousSectionId)
  const nextIndex = sections.findIndex(section => section.id === undo.nextSectionId)
  const index = previousIndex >= 0 ? previousIndex + 1 : nextIndex >= 0 ? nextIndex : Math.min(undo.index, sections.length)
  sections.splice(index, 0, { ...undo.section, ...(undo.section.parentId && !solution.sections.some(section => section.id === undo.section.parentId) ? { parentId: null } : {}) })

  const references = [...solution.references]
  const referencesById = new Map(references.map(reference => [reference.id, reference]))
  const restorableReferenceIds = new Set<string>()
  for (const reference of undo.references) {
    const existing = referencesById.get(reference.id)
    if (!existing) {
      const restored = { ...reference }
      references.push(restored)
      referencesById.set(reference.id, restored)
      restorableReferenceIds.add(reference.id)
    } else if (sameReference(existing, reference)) {
      restorableReferenceIds.add(reference.id)
    }
  }

  const bindings = new Map(undo.formulaBindings.map(binding => [binding.rowId, binding]))
  const formula = solution.formula.map(row => {
    const binding = bindings.get(row.id)
    if (!binding) return row
    const removedIds = binding.evidenceIds.filter(id => !binding.afterEvidenceIds.includes(id))
    const restoredIds = removedIds.filter(id => restorableReferenceIds.has(id))
    const unchanged = matchesDeletedRow(row, binding)
    // An untouched row can recover its original evidence order and validation.
    // Otherwise merge only the deleted bindings, keeping subsequent edits.
    if (unchanged && restoredIds.length === removedIds.length) {
      return { ...row, evidenceIds: [...binding.evidenceIds], verification: binding.verification }
    }
    const evidenceIds = [...row.evidenceIds]
    for (const id of restoredIds) if (!evidenceIds.includes(id)) evidenceIds.push(id)
    return { ...row, evidenceIds }
  })

  return { sections, references, formula }
}
