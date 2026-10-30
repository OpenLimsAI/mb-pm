import { describe, expect, it } from 'vitest'
import { findSlashTrigger, insertAtInlineAnchor, rebaseInlineAnchors, splitInlineDocument, textEditFromValues } from './inlineAssistant'
import type { InlineAnchor } from './inlineAssistant'

const apply = (text: string, edit: ReturnType<typeof textEditFromValues>) => text.slice(0, edit.from) + edit.insert + text.slice(edit.to)

describe('slash command context', () => {
  it.each(['/', '研究目标\n/', '正文 /', '正文\t/'])('recognizes a slash directly before a collapsed caret: %s', text => {
    expect(findSlashTrigger(text, text.length)).toEqual({ from: text.length - 1, to: text.length })
  })
  it.each(['https://', '正文/', '\\/', '//', '/a', '/ '])('does not mistake normal text for a command: %s', text => {
    expect(findSlashTrigger(text, text.length)).toBeNull()
  })
  it('uses the actual caret, rejects selected text and out-of-range offsets', () => {
    expect(findSlashTrigger('/ later', 1)).toEqual({ from: 0, to: 1 })
    expect(findSlashTrigger('/', 0, 1)).toBeNull()
    expect(findSlashTrigger('/', 2)).toBeNull()
    expect(findSlashTrigger('/', -1)).toBeNull()
    expect(findSlashTrigger('/', 0.5)).toBeNull()
  })
})

describe('exact text edits and inline anchors', () => {
  it('preserves card metadata and repositions only anchors affected by an exact edit', () => {
    const anchors = [{ id: 'before', offset: 1, question: '保留问题' }, { id: 'inside', offset: 4 }, { id: 'end', offset: 6 }, { id: 'after', offset: 9 }]
    const result = rebaseInlineAnchors(anchors, { from: 3, to: 6, insert: '新段' })
    expect(result).toEqual([{ id: 'before', offset: 1, question: '保留问题' }, { id: 'inside', offset: 5 }, { id: 'end', offset: 5 }, { id: 'after', offset: 8 }])
    expect(anchors.map(item => item.offset)).toEqual([1, 4, 6, 9])
  })
  it('distinguishes insertion before and after several cards at the same offset', () => {
    const anchors: InlineAnchor[] = [{ id: 'a', offset: 2, affinity: 'before' }, { id: 'b', offset: 2, affinity: 'after' }, { id: 'c', offset: 2 }]
    expect(rebaseInlineAnchors(anchors, { from: 2, to: 2, insert: '输入' }).map(a => [a.id, a.offset])).toEqual([['a', 2], ['b', 4], ['c', 4]])
  })
  it('collapses removed spans without negative offsets or lost cards', () => {
    const anchors = [{ id: 'a', offset: 2 }, { id: 'b', offset: 3 }, { id: 'c', offset: 4 }]
    expect(rebaseInlineAnchors(anchors, { from: 1, to: 5, insert: '' })).toEqual(anchors.map(a => ({ ...a, offset: 1 })))
  })
  it('supports exact edits even where repeated text makes a full-value diff ambiguous', () => {
    const anchors = [{ id: 'card', offset: 2 }]
    expect(rebaseInlineAnchors(anchors, { from: 0, to: 0, insert: 'a' })[0].offset).toBe(3)
    expect(rebaseInlineAnchors(anchors, { from: 4, to: 4, insert: 'a' })[0].offset).toBe(2)
  })
  it.each([
    ['', ''], ['原文', '原文'], ['', '第一段'], ['原始段落', ''],
    ['前后', '前插入后'], ['abcdef', 'abXYef'], ['甲😀乙', '甲😁乙'],
    ['😀末尾', '开头末尾'], ['甲\n乙', '甲\n新增\n乙'],
  ])('reconstructs changes without splitting surrogate pairs: %s → %s', (before, after) => {
    const edit = textEditFromValues(before, after)
    expect(apply(before, edit)).toBe(after)
    expect(edit.insert).not.toMatch(/[\uD800-\uDFFF]/u)
    expect(before.slice(0, edit.from)).not.toMatch(/[\uD800-\uDFFF]/u)
    expect(before.slice(edit.to)).not.toMatch(/[\uD800-\uDFFF]/u)
  })
  it('keeps multiple anchors aligned through consecutive typing, removal and pasting', () => {
    let anchors = [{ id: 'one', offset: 2 }, { id: 'two', offset: 4 }]
    anchors = rebaseInlineAnchors(anchors, { from: 0, to: 0, insert: 'abc' })
    anchors = rebaseInlineAnchors(anchors, { from: 4, to: 6, insert: '' })
    anchors = rebaseInlineAnchors(anchors, { from: 4, to: 4, insert: '😀' })
    expect(anchors.map(a => a.offset)).toEqual([6, 7])
  })
})

describe('accepting an inline answer', () => {
  it('inserts at the current anchor and preserves intervening user edits and other cards', () => {
    const anchors = [{ id: 'chosen', offset: 3, question: '临时问题' }, { id: 'later', offset: 5 }]
    const current = '新写的原正文'
    const result = insertAtInlineAnchor(current, anchors, 'chosen', '\n已确认的摘录\n[依据：来源]\n')!
    expect(result.text).toBe('新写的\n已确认的摘录\n[依据：来源]\n原正文')
    expect(result.text).not.toContain('临时问题')
    expect(result.text.slice(result.range.from, result.range.to)).toBe('\n已确认的摘录\n[依据：来源]\n')
    expect(result.anchors).toEqual([{ id: 'later', offset: 5 + result.range.to - result.range.from }])
    expect(anchors).toHaveLength(2)
  })
  it('preserves same-offset creation order when accepting the middle card', () => {
    const anchors = [{ id: 'first', offset: 1 }, { id: 'middle', offset: 1 }, { id: 'last', offset: 1 }]
    const result = insertAtInlineAnchor('前后', anchors, 'middle', '采纳')!
    expect(result.text).toBe('前采纳后')
    expect(result.anchors).toEqual([{ id: 'first', offset: 1 }, { id: 'last', offset: 3 }])
  })
  it('supports start/end positions and makes repeated acceptance a no-op', () => {
    const first = insertAtInlineAnchor('文', [{ id: 'a', offset: 0 }, { id: 'b', offset: 1 }], 'a', '前')!
    const last = insertAtInlineAnchor(first.text, first.anchors, 'b', '后')!
    expect(last.text).toBe('前文后')
    expect(last.anchors).toEqual([])
    expect(insertAtInlineAnchor(last.text, last.anchors, 'a', '重复')).toBeNull()
  })
  it('does not consume a card when the accepted value is empty', () => {
    expect(insertAtInlineAnchor('正文', [{ id: 'a', offset: 0 }], 'a', ' \n')).toBeNull()
  })
})

describe('temporary editor segments', () => {
  it('round-trips original text while retaining stable same-position card order and empty segments', () => {
    const text = '甲😀乙'
    const anchors = [{ id: 'end', offset: text.length }, { id: 'first', offset: 1 }, { id: 'second', offset: 1 }, { id: 'start', offset: 0 }]
    const blocks = splitInlineDocument(text, anchors)
    expect(blocks.filter(b => b.type === 'text').map(b => b.text).join('')).toBe(text)
    expect(blocks.filter(b => b.type === 'card').map(b => b.anchor.id)).toEqual(['start', 'first', 'second', 'end'])
    expect(blocks.filter(b => b.type === 'text')).toHaveLength(5)
    expect(anchors.map(a => a.id)).toEqual(['end', 'first', 'second', 'start'])
  })
  it('keeps segment keys stable as edits move their boundaries', () => {
    const before = splitInlineDocument('前后', [{ id: 'a', offset: 1 }])
    const after = splitInlineDocument('新增前后', [{ id: 'a', offset: 3 }])
    expect(after.map(b => b.key)).toEqual(before.map(b => b.key))
    expect(new Set(after.map(b => b.key)).size).toBe(after.length)
  })
  it('returns one editable text segment for a chapter without cards', () => {
    expect(splitInlineDocument('', [])).toEqual([{ type: 'text', key: 'text:[null,null]', from: 0, to: 0, text: '' }])
  })
  it('rejects corrupt or duplicate anchors instead of silently placing a card elsewhere', () => {
    expect(() => splitInlineDocument('abc', [{ id: 'a', offset: 4 }])).toThrow(RangeError)
    expect(() => splitInlineDocument('😀', [{ id: 'a', offset: 1 }])).toThrow(RangeError)
    expect(() => splitInlineDocument('abc', [{ id: 'a', offset: 1 }, { id: 'a', offset: 2 }])).toThrow(RangeError)
    expect(() => rebaseInlineAnchors([{ id: 'a', offset: -1 }], { from: 0, to: 0, insert: '' })).toThrow(RangeError)
    expect(() => rebaseInlineAnchors([], { from: 3, to: 1, insert: '' })).toThrow(RangeError)
  })
})
