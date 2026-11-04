import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { RichBodySegment } from './RichBodySegment'
import { getRange } from './richSelection'
import type { RichHandle } from './RichBodySegment'
import type { Reference } from './types'
const ref: Reference = { id: 'private-reference-uuid', sourceId: 'kb:source', sectionId: 'one', title: '原始研究', excerpt: '原始条件', sourceVersion: 'v1', locator: '方法' }
beforeEach(() => { Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 100, height: 20, top: 0, right: 100, bottom: 20, left: 0, toJSON: () => ({}) }); Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList })
it('renders numbered clickable atoms while serializing stable citations and preserving undo', () => {
  let handle: RichHandle | null = null
  const open = vi.fn(), change = vi.fn(), content = '结论[[cite:private-reference-uuid]]。'
  const props = { value: content, label: '正文', disabled: false, onActive: (value: RichHandle) => { handle = value }, onRange: () => {}, onSlash: () => {}, onChange: change, onCitation: open }
  const view = render(<RichBodySegment {...props} references={[{ number: 2, reference: ref, aliases: [ref.id], sectionIds: ['one'] }]} />)
  expect(screen.getByRole('textbox', { name: '正文' })).not.toHaveTextContent(ref.id)
  fireEvent.click(screen.getByRole('button', { name: '引用 2：原始研究' }))
  expect(open).toHaveBeenCalledWith(ref)
  expect(handle!.editor.getMarkdown()).toBe(content)
  expect(change).not.toHaveBeenCalled()
  act(() => handle!.editor.commands.setTextSelection({ from: 1, to: handle!.editor.state.doc.content.size - 1 }))
  const selected = getRange(handle!.editor, content)!
  expect(content.slice(selected.start, selected.end)).toContain('[[cite:private-reference-uuid]]')
  view.rerender(<RichBodySegment {...props} references={[{ number: 1, reference: ref, aliases: [ref.id], sectionIds: ['one'] }]} />)
  expect(screen.getByRole('button', { name: '引用 1：原始研究' })).toHaveTextContent('[1]')
  expect(change).not.toHaveBeenCalled()
  act(() => handle!.editor.chain().focus('end').insertContent('新增').run())
  expect(handle!.editor.getMarkdown()).toContain('[[cite:private-reference-uuid]]')
  act(() => handle!.editor.commands.undo())
  expect(handle!.editor.getMarkdown()).toBe(content)
})
it('shows a short unresolved reference marker without exposing its internal identifier', () => {
  render(<RichBodySegment value="[[cite:unavailable-private-id]]" label="正文" disabled={false} onActive={() => {}} onRange={() => {}} onSlash={() => {}} onChange={() => {}} />)
  expect(screen.getByRole('button', { name: '引用来源待核对' })).toHaveTextContent('[?]')
  expect(screen.getByRole('textbox', { name: '正文' })).not.toHaveTextContent('unavailable-private-id')
})
