export interface TextChange { before: string; after: string; changed: boolean }
const tokens = (text: string) => text.match(/[^。！？.!?\n]+[。！？.!?]*|[。！？.!?]+|\n/g) || []
/** Sentence-level LCS keeps each proposal reviewable and caps work for unusually long selections. */
export function polishChanges(original: string, proposed: string): TextChange[] {
  if (original === proposed) return [{ before: original, after: proposed, changed: false }]
  const a = tokens(original), b = tokens(proposed)
  if (a.length * b.length > 160_000) return [{ before: original, after: proposed, changed: true }]
  const matrix = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) matrix[i][j] = a[i] === b[j] ? matrix[i + 1][j + 1] + 1 : Math.max(matrix[i + 1][j], matrix[i][j + 1])
  const parts: TextChange[] = []
  const push = (before: string, after: string, changed: boolean) => { const last = parts.at(-1); if (last?.changed === changed) { last.before += before; last.after += after } else parts.push({ before, after, changed }) }
  let i = 0, j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { push(a[i++], b[j++], false); continue }
    if (j < b.length && (i >= a.length || matrix[i][j + 1] > matrix[i + 1][j])) push('', b[j++], true)
    else push(a[i++], '', true)
  }
  return parts
}
export function applyPolishChoices(changes: TextChange[], rejected: ReadonlySet<number>): string { return changes.map((part, index) => rejected.has(index) ? part.before : part.after).join('') }

// Classify presentation only. Never normalize the actual proposal or the strings
// used by applyPolishChoices. Keep word boundaries and numeric spacing meaningful.
function layoutText(text: string): string {
  return text.split(/\r?\n/).map(line => line.trim().replace(/[ \t\u3000]+/g, ' ').replace(/ *([，。！？；：、:／/]) */g, '$1')).filter(Boolean).join('\n')
}
export function polishChangeGroups(changes: TextChange[]): { text: number[]; layout: number[] } {
  const onlyLayout = layoutText(changes.map(part => part.before).join('')) === layoutText(changes.map(part => part.after).join(''))
  const groups: { text: number[]; layout: number[] } = { text: [], layout: [] }
  changes.forEach((part, index) => {
    if (!part.changed) return
    groups[onlyLayout || layoutText(part.before) === layoutText(part.after) ? 'layout' : 'text'].push(index)
  })
  return groups
}
