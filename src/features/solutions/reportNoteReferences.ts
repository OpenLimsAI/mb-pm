import type { Solution } from './types'

export function reportNoteReferences(doc: Solution) {
  return doc.sections.flatMap(section => Array.from(section.content.matchAll(/\]\(\/notes\?note=([^\s)]+)\)/g)).flatMap(match => {
    try { return [{ noteId: decodeURIComponent(match[1]), sectionId: section.id }] } catch { return [] }
  }))
}
