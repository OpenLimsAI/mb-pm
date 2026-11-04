import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RichBodySegment } from './RichBodySegment'
import type { RichHandle } from './RichBodySegment'
import { captionMarkdown, moveDocumentBlock, moveSelectedDocumentBlock, nextCaptionNumber, reportFigureLinks, remapCopiedFigureAnchors } from './editorDocumentTools'
import InlineAssistantEditor from './InlineAssistantEditor'

beforeEach(() => {
  localStorage.clear()
  Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 100, height: 20, top: 0, right: 100, bottom: 20, left: 0, toJSON: () => ({}) })
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList
})
function mount() {
  let handle: RichHandle | null = null
  render(<RichBodySegment value={'第一段\n\n第二段\n\n第三段'} label="正文" disabled={false} onActive={value => { handle = value }} onRange={() => {}} onSlash={() => {}} onChange={() => {}} />)
  return { get editor() { return handle!.editor }, get dragOwner() { return handle!.dragOwner } }
}
describe('document block and illustration editing', () => {
  it('moves complete blocks in both directions, retaining undo', () => {
    const state = mount()
    act(() => { state.editor.commands.setTextSelection(7); expect(moveSelectedDocumentBlock(state.editor, -1)).toBe(true) })
    expect(state.editor.getMarkdown()).toBe('第二段\n\n第一段\n\n第三段')
    act(() => state.editor.commands.undo())
    expect(state.editor.getMarkdown()).toBe('第一段\n\n第二段\n\n第三段')
    act(() => { expect(moveDocumentBlock(state.editor, 0, state.editor.state.doc.content.size)).toBe(true) })
    expect(state.editor.getMarkdown()).toBe('第二段\n\n第三段\n\n第一段')
  })
  it('drops the selected block before another paragraph using its editor identity', () => {
    const state = mount(), editor = state.editor
    vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({ pos: 1, inside: 0 })
    const event = { clientX: 0, clientY: 0, preventDefault: vi.fn(), dataTransfer: { files: [], getData: () => JSON.stringify({ owner: state.dragOwner, from: 5 }) } } as unknown as DragEvent
    act(() => { editor.view.someProp('handleDrop', handler => handler(editor.view, event, undefined as never, false)) })
    expect(editor.getMarkdown()).toBe('第二段\n\n第一段\n\n第三段')
    expect(event.preventDefault).toHaveBeenCalled()
  })
  it('pastes a local image with an editable caption, retaining the surrounding text', async () => {
    mount()
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6lAAAAABJRU5ErkJggg=='), char => char.charCodeAt(0))
    const file = new File([bytes], '实验图.png', { type: 'image/png' })
    Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes.buffer })
    fireEvent.paste(screen.getByRole('textbox', { name: '正文' }), { clipboardData: { files: [file], getData: () => '' } })
    expect(await screen.findByRole('img', { name: '实验图.png' })).toHaveAttribute('src', expect.stringMatching(/^data:image\/png;base64,/))
    expect(screen.getByText(/图 1/)).toBeInTheDocument()
    expect(screen.getByText('第三段')).toBeInTheDocument()
  })
  it('renames copied caption anchors while preserving links to other chapters', () => {
    const markdown = '[图 1\u3000本章结果](#report-figure-here)\n\n参见[图 1](#report-figure-here)与[图 2](#report-figure-other)'
    const copied = remapCopiedFigureAnchors(markdown, () => 'new-id')
    expect(copied.match(/#report-figure-new-id/g)).toHaveLength(2)
    expect(copied).toContain('#report-figure-other')
  })
  it('generates portable anchored captions and separates figures from tables', () => {
    const figure = captionMarkdown('图', 2, '稳定性[结果]', 'figure-id')
    expect(figure).toBe('[图 2\u3000稳定性结果](#report-figure-figure-id)')
    expect(nextCaptionNumber(`${figure}\n\n表 7\u3000旧表`, '图')).toBe(3)
    expect(nextCaptionNumber(`${figure}\n\n表 7\u3000旧表`, '表')).toBe(8)
    expect(reportFigureLinks(figure)).toEqual([{ label: '图 2', target: '#report-figure-figure-id' }])
  })
  it('exposes table editing and inserts an anchored table caption', async () => {
    const edit = () => {}
    render(<InlineAssistantEditor content="" cards={[]} disabled={false} scope="资料" onEdit={edit} onSelection={edit} onCreate={edit} onUpdate={edit} onRemove={edit} onAsk={edit} onAdopt={edit} onSource={edit} />)
    fireEvent.click(screen.getByRole('button', { name: '插入表格' }))
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '增加行' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '增加行' }))
    await waitFor(() => expect(screen.getByRole('table').querySelectorAll('tr')).toHaveLength(4))
    expect(screen.getByRole('link', { name: /表 1\s+表格标题/ })).toHaveAttribute('href', expect.stringContaining('#report-table-'))
  })
})
