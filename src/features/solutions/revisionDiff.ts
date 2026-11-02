export interface DiffLine { kind: 'same' | 'added' | 'removed'; text: string }
/** Bounded line diff: long documents retain full before/after content without quadratic work. */
export function revisionDiff(before: string, after: string): DiffLine[] {
  if (before === after) return before.split('\n').map(text => ({ kind: 'same', text }))
  const a = before.split('\n'), b = after.split('\n')
  if (a.length * b.length > 250000) return [...a.map(text => ({ kind: 'removed' as const, text })), ...b.map(text => ({ kind: 'added' as const, text }))]
  const rows = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) rows[i][j] = a[i] === b[j] ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1])
  const lines: DiffLine[] = []; let i = 0, j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { lines.push({ kind: 'same', text: a[i++] }); j++ }
    else if (j < b.length && (i === a.length || rows[i][j + 1] > rows[i + 1][j])) lines.push({ kind: 'added', text: b[j++] })
    else lines.push({ kind: 'removed', text: a[i++] })
  }
  return lines
}

