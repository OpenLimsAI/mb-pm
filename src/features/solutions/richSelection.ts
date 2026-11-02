import type { Editor } from '@tiptap/react'
import type { RichRange } from './RichBodySegment'
import { textEditFromValues } from './inlineAssistant'

/** Project a ProseMirror selection onto its Markdown representation without mutating it. */
export function getRange(editor: Editor, source: string): RichRange | null {
  const { from, to } = editor.state.selection
  const marker = `KS${crypto.randomUUID().replaceAll('-', '')}`
  const marked = editor.state.tr.insertText(marker, from, to).doc.toJSON()
  const serial = editor.markdown?.serialize(marked)
  if (!serial) return null
  const offset = serial.indexOf(marker)
  if (offset < 0) return null
  const canonical = editor.getMarkdown()
  const before = serial.slice(0, offset), after = serial.slice(offset + marker.length)
  const edit = textEditFromValues(canonical, serial)
  let start = canonical.startsWith(before) && canonical.endsWith(after) ? before.length : edit.from
  let end = canonical.startsWith(before) && canonical.endsWith(after) ? canonical.length - after.length : edit.to
  const text = editor.state.doc.textBetween(from, to, '\n')
  if (canonical !== source) {
    // A freshly opened legacy document may use different Markdown whitespace.
    // Only project an unambiguous textual selection; never guess a replacement range.
    if (text && source.indexOf(text) === source.lastIndexOf(text) && source.includes(text)) { start = source.indexOf(text); end = start + text.length }
    else if (from === to && from <= 1) { start = 0; end = 0 }
    else if (from === to && from >= editor.state.doc.content.size - 1) { start = source.length; end = start }
    else return null
  }
  const rect = editor.view.coordsAtPos(to)
  return { start, end, text, from, to, left: rect.left, top: rect.bottom, input: editor.view.dom }
}
