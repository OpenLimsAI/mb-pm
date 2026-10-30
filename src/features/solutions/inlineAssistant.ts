/** Temporary cards live outside section.content. All offsets use textarea UTF-16 indices. */
export interface InlineAnchor {
  id: string
  offset: number
  affinity?: 'before' | 'after'
}

export interface InlineTextEdit {
  /** Replace the half-open [from, to) range with insert. */
  from: number
  to: number
  insert: string
}

export interface InlineRange { from: number; to: number }

export type InlineDocumentBlock<T extends InlineAnchor = InlineAnchor> =
  | { type: 'text'; key: string; from: number; to: number; text: string }
  | { type: 'card'; key: string; anchor: T }

function validOffset(offset: number): boolean {
  return Number.isSafeInteger(offset) && offset >= 0
}

function textBoundary(text: string, offset: number): boolean {
  const previous = text.charCodeAt(offset - 1), current = text.charCodeAt(offset)
  return !(previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff)
}

function checkEdit(edit: InlineTextEdit): void {
  if (!validOffset(edit.from) || !validOffset(edit.to) || edit.to < edit.from || typeof edit.insert !== 'string') {
    throw new RangeError('Invalid inline text edit')
  }
}

function checkAnchors(anchors: readonly InlineAnchor[], text?: string): void {
  const ids = new Set<string>()
  for (const anchor of anchors) {
    if (!anchor.id || ids.has(anchor.id) || !validOffset(anchor.offset)
      || (anchor.affinity !== undefined && anchor.affinity !== 'before' && anchor.affinity !== 'after')
      || (text !== undefined && (anchor.offset > text.length || !textBoundary(text, anchor.offset)))) {
      throw new RangeError('Invalid inline card anchor')
    }
    ids.add(anchor.id)
  }
}

/** The caller gates newly typed input, paste and IME composition; this only recognizes the caret context. */
export function findSlashTrigger(text: string, start: number, end = start): InlineRange | null {
  if (!validOffset(start) || start !== end || start > text.length || text[start - 1] !== '/') return null
  const from = start - 1
  return from === 0 || /\s/u.test(text[from - 1]) ? { from, to: start } : null
}

/** Minimal contiguous replacement. Prefer an exact edit from the affected textarea segment when available. */
export function textEditFromValues(before: string, after: string): InlineTextEdit {
  let from = 0
  while (from < before.length && from < after.length && before[from] === after[from]) from++
  while (from > 0 && (!textBoundary(before, from) || !textBoundary(after, from))) from--
  let suffix = 0
  while (before.length - suffix > from && after.length - suffix > from
    && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++
  while (suffix > 0 && (!textBoundary(before, before.length - suffix) || !textBoundary(after, after.length - suffix))) suffix--
  return { from, to: before.length - suffix, insert: after.slice(from, after.length - suffix) }
}

/**
 * Keeps input order and every caller-owned field. Inside a replaced range, anchors
 * collapse to its start/end according to affinity (default: after).
 * At a segment boundary set prior cards to before and following cards to after;
 * identical numeric offsets alone cannot identify which side the user edited.
 */
export function rebaseInlineAnchors<T extends InlineAnchor>(anchors: readonly T[], edit: InlineTextEdit): T[] {
  checkAnchors(anchors)
  checkEdit(edit)
  const delta = edit.insert.length - (edit.to - edit.from)
  return anchors.map(anchor => {
    let offset = anchor.offset
    if (offset > edit.to || (offset === edit.to && edit.to > edit.from)) offset += delta
    else if (offset >= edit.from) offset = edit.from + (anchor.affinity === 'before' ? 0 : edit.insert.length)
    return { ...anchor, offset }
  })
}

/**
 * Inserts only explicitly accepted text. Removes just the accepted card and
 * preserves same-position card ordering: earlier cards stay before the inserted
 * passage; later cards move after it. No AI draft or marker is serialized.
 */
export function insertAtInlineAnchor<T extends InlineAnchor>(
  text: string,
  anchors: readonly T[],
  cardId: string,
  acceptedText: string,
): { text: string; anchors: T[]; range: InlineRange } | null {
  checkAnchors(anchors, text)
  const index = anchors.findIndex(anchor => anchor.id === cardId)
  if (index < 0 || !acceptedText.trim()) return null
  const from = anchors[index].offset, to = from + acceptedText.length
  return {
    text: text.slice(0, from) + acceptedText + text.slice(from),
    anchors: anchors.flatMap((anchor, position) => {
      if (position === index) return []
      const moves = anchor.offset > from || (anchor.offset === from && position > index)
      return [{ ...anchor, offset: anchor.offset + (moves ? acceptedText.length : 0) }]
    }),
    range: { from, to },
  }
}

/** Stable card order and segment keys keep adjacent textareas mounted while typing. */
export function splitInlineDocument<T extends InlineAnchor>(text: string, anchors: readonly T[]): InlineDocumentBlock<T>[] {
  checkAnchors(anchors, text)
  const sorted = anchors.map((anchor, order) => ({ anchor, order }))
    .sort((a, b) => a.anchor.offset - b.anchor.offset || a.order - b.order)
  const blocks: InlineDocumentBlock<T>[] = []
  let from = 0, previousId: string | null = null
  for (const { anchor } of sorted) {
    blocks.push({ type: 'text', key: `text:${JSON.stringify([previousId, anchor.id])}`, from, to: anchor.offset, text: text.slice(from, anchor.offset) })
    blocks.push({ type: 'card', key: `card:${anchor.id}`, anchor })
    previousId = anchor.id
    from = anchor.offset
  }
  blocks.push({ type: 'text', key: `text:${JSON.stringify([previousId, null])}`, from, to: text.length, text: text.slice(from) })
  return blocks
}
