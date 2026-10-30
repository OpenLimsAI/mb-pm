export type TextFormat = 'bold' | 'italic' | 'heading' | 'list' | 'quote'
export interface FormattedText { value: string; start: number; end: number }

/** Keep paragraph boundaries when a model trims the selected snippet. */
export function preserveSelectionWhitespace(original: string, replacement: string): string {
  return (original.match(/^\s*/)?.[0] || '') + replacement.trim() + (original.match(/\s*$/)?.[0] || '')
}

/** Textarea offsets stay in UTF-16, matching the inline question anchors. */
export function formatEditorText(value: string, start: number, end: number, format: TextFormat): FormattedText {
  if (format === 'bold' || format === 'italic') {
    const marker = format === 'bold' ? '**' : '*'
    if (start >= marker.length && value.slice(start - marker.length, start) === marker && value.slice(end, end + marker.length) === marker) {
      return { value: value.slice(0, start - marker.length) + value.slice(start, end) + value.slice(end + marker.length), start: start - marker.length, end: end - marker.length }
    }
    const text = value.slice(start, end) || '文字'
    return { value: value.slice(0, start) + marker + text + marker + value.slice(end), start: start + marker.length, end: start + marker.length + text.length }
  }
  const from = start === 0 ? 0 : value.lastIndexOf('\n', start - 1) + 1
  const selectedEnd = end > start && value[end - 1] === '\n' ? end - 1 : end
  const nextBreak = value.indexOf('\n', selectedEnd)
  const to = nextBreak === -1 ? value.length : nextBreak
  const lines = value.slice(from, to).split('\n')
  const prefix = format === 'heading' ? '## ' : format === 'list' ? '- ' : '> '
  const remove = lines.every(line => line.startsWith(prefix))
  const text = lines.map(line => remove ? line.slice(prefix.length) : prefix + line).join('\n')
  return { value: value.slice(0, from) + text + value.slice(to), start: from, end: from + text.length }
}

/** Continue a Markdown list, or leave it when the current item is empty. */
export function continueEditorList(value: string, start: number, end: number): FormattedText | null {
  if (start !== end) return null
  const from = start === 0 ? 0 : value.lastIndexOf('\n', start - 1) + 1
  const beforeCaret = value.slice(from, start)
  const match = /^(\s*)([-*+] |\d+\. |> )(.*)$/.exec(beforeCaret)
  if (!match) return null
  if (!match[3].trim() && (start === value.length || value[start] === '\n')) {
    return { value: value.slice(0, from) + match[1] + value.slice(start), start: from + match[1].length, end: from + match[1].length }
  }
  const marker = /^\d/.test(match[2]) ? `${parseInt(match[2], 10) + 1}. ` : match[2]
  const insert = `\n${match[1]}${marker}`
  return { value: value.slice(0, start) + insert + value.slice(end), start: start + insert.length, end: start + insert.length }
}
