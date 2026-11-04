import type { Reference, Solution } from './types'

const pattern = /\[\[cite:([^\]\n]+)\]\]/g
export const citationToken = (id: string) => `[[cite:${encodeURIComponent(id)}]]`
export const referenceKey = (ref: Reference) => `${ref.sourceId || ref.title}\u0000${ref.sourceVersion || ''}`
export interface NumberedReference { number: number; reference: Reference; aliases: string[]; sectionIds: string[] }
/** First occurrence in the report determines the bibliography order; old unmarked references follow chapter order. */
export function reportReferences(solution: Pick<Solution, 'sections' | 'references'>): NumberedReference[] {
  const ordered: Reference[] = [], byId = new Map(solution.references.map(ref => [ref.id, ref]))
  for (const section of solution.sections) {
    for (const match of section.content.matchAll(pattern)) {
      let id: string; try { id = decodeURIComponent(match[1]) } catch { continue }
      const ref = byId.get(id); if (ref) ordered.push(ref)
    }
  }
  for (const section of solution.sections) ordered.push(...solution.references.filter(ref => ref.sectionId === section.id))
  ordered.push(...solution.references)
  const result: NumberedReference[] = [], seen = new Map<string, NumberedReference>()
  for (const ref of ordered) {
    const key = referenceKey(ref), existing = seen.get(key)
    if (existing) {
      if (!existing.aliases.includes(ref.id)) existing.aliases.push(ref.id)
      if (ref.sectionId && !existing.sectionIds.includes(ref.sectionId)) existing.sectionIds.push(ref.sectionId)
    } else {
      const item = { number: result.length + 1, reference: ref, aliases: [ref.id], sectionIds: ref.sectionId ? [ref.sectionId] : [] }
      seen.set(key, item); result.push(item)
    }
  }
  return result
}
export function resolveCitations(content: string, references: NumberedReference[], links = false): string {
  const index = new Map(references.flatMap(item => item.aliases.map(id => [id, item] as const)))
  return content.replace(pattern, (_full, token: string) => {
    let id: string; try { id = decodeURIComponent(token) } catch { return '[引用待核对]' }
    const item = index.get(id)
    return item ? links ? `[${item.number}](#report-reference-${encodeURIComponent(item.reference.id)})` : `[${item.number}]` : '[引用待核对]'
  })
}
export function referenceEntry(item: NumberedReference, detailed = true): string {
  const ref = item.reference
  return `[${item.number}] ${ref.title}${detailed ? [ref.sourceVersion ? `版本 ${ref.sourceVersion}` : '', ref.locator].filter(Boolean).map(value => ` · ${value}`).join('') : ''}`
}
export function remapCitationTokens(content: string, idMap: Map<string, string>): string {
  return content.replace(pattern, (full, token: string) => {
    try { const next = idMap.get(decodeURIComponent(token)); return next ? citationToken(next) : full } catch { return full }
  })
}
export interface ReportCaption { kind: 'figure' | 'table'; number: number; title: string; sectionId: string; anchor?: string }
const captionPattern = /^(?:\*\*)?(?:\[(图|表)\s*\d+[ \t\u3000.：:、-]+(.+?)\]\((#report-(?:figure|table)-[a-zA-Z0-9_-]+)\)|(图|表)\s*\d+[ \t\u3000.：:、-]+(.+?))(?:\*\*)?$/gm
function prepareCaptions<T extends Pick<Solution, 'sections'>>(solution: T): { solution: T; captions: ReportCaption[] } {
  const counts = { figure: 0, table: 0 }, captions: ReportCaption[] = [], numbers = new Map<string, number>()
  let sections = solution.sections.map(section => ({ ...section, content: section.content.replace(captionPattern, (_full, linkedKind: string, linkedTitle: string, anchor: string, plainKind: string, plainTitle: string) => {
    const label = linkedKind || plainKind, title = linkedTitle || plainTitle, kind = label === '图' ? 'figure' : 'table', number = ++counts[kind]
    captions.push({ kind, number, title, sectionId: section.id, anchor })
    if (anchor) numbers.set(anchor, number)
    return anchor ? `[${label} ${number}\u3000${title}](${anchor})` : `${label} ${number}\u3000${title}`
  }) }))
  sections = sections.map(section => ({ ...section, content: section.content.replace(/\[(图|表)\s*\d+\]\((#report-(?:figure|table)-[a-zA-Z0-9_-]+)\)/g, (full, kind: string, anchor: string) => numbers.has(anchor) ? `[${kind} ${numbers.get(anchor)}](${anchor})` : full) }))
  return { solution: { ...solution, sections }, captions }
}
export function reportCaptions(solution: Pick<Solution, 'sections'>): ReportCaption[] { return prepareCaptions(solution).captions }
export function normalizedReport(solution: Solution): Solution { return prepareCaptions(solution).solution }
