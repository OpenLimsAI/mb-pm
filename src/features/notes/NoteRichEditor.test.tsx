import { useState } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import NoteRichEditor from './NoteRichEditor'
import NoteEditor from './NoteEditor'
import { createPreviewNotesClient } from './client'
import { newNote } from './draft'

beforeEach(() => {
  localStorage.clear()
  Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 100, height: 20, top: 0, right: 100, bottom: 20, left: 0, toJSON: () => ({}) })
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList
})
function mount(value = '') {
  const changed = vi.fn()
  function Harness() {
    const [content, setContent] = useState(value)
    return <NoteRichEditor value={content} disabled={false} onChange={next => { changed(next); setContent(next) }} />
  }
  render(<Harness />)
  return changed
}
function paste(html: string) {
  const body = screen.getByRole('textbox', { name: '笔记正文' })
  act(() => body.focus())
  fireEvent.paste(body, { clipboardData: { files: [], getData: (type: string) => type === 'text/html' ? html : '' } })
}

describe('note document editor', () => {
  it('displays formatted legacy Markdown without rewriting it on mount or mode switches', () => {
    const original = '# 研究目标\n\n**实验** 和 *观察*\n\n- 资料一\n- 资料二\n\n| 项目 | 结果 |\n| --- | --- |\n| A | 1 |'
    const changed = mount(original)
    expect(screen.getByRole('textbox', { name: '笔记正文' })).toHaveAttribute('contenteditable', 'true')
    expect(screen.getByRole('heading', { name: '研究目标' })).toBeInTheDocument()
    expect(screen.getByText('实验').tagName).toBe('STRONG')
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(changed).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Markdown' }))
    expect(screen.getByRole('textbox', { name: '笔记正文' })).toHaveValue(original)
    fireEvent.click(screen.getByRole('button', { name: '可视编辑' }))
    expect(screen.getByRole('heading', { name: '研究目标' })).toBeInTheDocument()
    expect(changed).not.toHaveBeenCalled()
  })
  it('pastes formatted document content and supports paragraph formats, undo and redo', () => {
    const changed = mount()
    paste('<p>研究内容</p>')
    fireEvent.keyDown(screen.getByRole('textbox', { name: '笔记正文' }), { key: 'a', ctrlKey: true })
    fireEvent.click(screen.getByRole('button', { name: '加粗' }))
    expect(changed).toHaveBeenLastCalledWith('**研究内容**')
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    expect(changed).toHaveBeenLastCalledWith('研究内容')
    fireEvent.click(screen.getByRole('button', { name: '重做' }))
    expect(changed).toHaveBeenLastCalledWith('**研究内容**')
    fireEvent.change(screen.getByRole('combobox', { name: '段落样式' }), { target: { value: '2' } })
    expect(screen.getByRole('heading', { name: '研究内容', level: 2 })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '项目列表' }))
    expect(screen.getByRole('list')).toBeInTheDocument()
  })
  it('keeps completed and incomplete task items when editing existing notes', () => {
    const changed = mount('- [ ] 待完成\n- [x] 已完成')
    expect(screen.getAllByRole('checkbox')).toHaveLength(2)
    expect(screen.getAllByRole('checkbox')[0]).not.toBeChecked()
    expect(screen.getAllByRole('checkbox')[1]).toBeChecked()
    paste('<p>补充</p>')
    expect(changed.mock.lastCall?.[0]).toContain('- [ ]')
    expect(changed.mock.lastCall?.[0]).toContain('- [x]')
  })
  it('inserts and edits a table and retains its Markdown when switching modes', () => {
    mount('表格之前')
    fireEvent.click(screen.getByRole('button', { name: '插入表格' }))
    expect(screen.getByRole('table')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '增加行' }))
    expect(screen.getAllByRole('row')).toHaveLength(4)
    fireEvent.click(screen.getByRole('button', { name: 'Markdown' }))
    expect((screen.getByRole('textbox', { name: '笔记正文' }) as HTMLTextAreaElement).value).toContain('|')
    fireEvent.click(screen.getByRole('button', { name: '可视编辑' }))
    expect(screen.getAllByRole('row')).toHaveLength(4)
  })
  it('validates links and applies a link with Enter without submitting the note', () => {
    const submitted = vi.fn()
    render(<form onSubmit={event => { event.preventDefault(); submitted() }}><NoteRichEditor value="" disabled={false} onChange={() => {}} /></form>)
    fireEvent.click(screen.getByRole('button', { name: '插入链接' }))
    const input = screen.getByRole('textbox', { name: '链接地址' })
    fireEvent.change(input, { target: { value: 'javascript:alert(1)' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByRole('alert')).toHaveTextContent('http')
    fireEvent.change(input, { target: { value: 'https://example.org/source' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.queryByRole('textbox', { name: '链接地址' })).not.toBeInTheDocument()
    expect(submitted).not.toHaveBeenCalled()
  })
  it('cleans pasted HTML while retaining headings, marks and table structure', () => {
    const changed = mount()
    paste('<h2>实验方法</h2><p><strong>重要</strong>结果</p><table><tr><td>组别</td><td>结果</td></tr><tr><td>A</td><td>1</td></tr></table><script>alert(1)</script><img src="https://example.org/pixel.png" alt="外部图"><a href="javascript:alert(1)">坏链接</a>')
    expect(screen.getByRole('heading', { name: '实验方法' })).toBeInTheDocument()
    expect(screen.getByText('重要').tagName).toBe('STRONG')
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(document.querySelector('img[src^="http"]')).toBeNull()
    expect(changed.mock.lastCall?.[0]).not.toContain('javascript:')
    expect(changed.mock.lastCall?.[0]).not.toContain('<script>')
  })
  it('preserves Markdown content across a save failure and freezes the document during saving', async () => {
    const client = createPreviewNotesClient('rich-failure')
    const draft = newNote({ title: '格式笔记', content: '# 研究\n\n**原始正文**' })
    let reject!: (error: Error) => void
    vi.spyOn(client, 'create').mockImplementation(() => new Promise((_, fail) => { reject = fail }))
    render(<NoteEditor client={client} draft={draft} onClose={vi.fn()} onSaved={vi.fn()} inline />)
    fireEvent.click(screen.getByRole('button', { name: '保存笔记' }))
    expect(screen.getByRole('textbox', { name: '笔记正文' })).toHaveAttribute('contenteditable', 'false')
    expect(screen.getByRole('button', { name: '插入表格' })).toBeDisabled()
    await act(async () => reject(new Error('连接中断，草稿已保留')))
    expect(await screen.findByRole('alert')).toHaveTextContent('草稿已保留')
    expect(screen.getByRole('heading', { name: '研究' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: '笔记正文' })).toHaveAttribute('contenteditable', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Markdown' }))
    expect(screen.getByRole('textbox', { name: '笔记正文' })).toHaveValue(draft.content)
  })
  it('retains oversized text and prevents saving without truncating it', async () => {
    const client = createPreviewNotesClient('rich-limit'), saved = vi.spyOn(client, 'create')
    render(<NoteEditor client={client} draft={newNote({ title: '完整保留' })} onClose={vi.fn()} onSaved={vi.fn()} inline />)
    paste(`<p>${'文'.repeat(50001)}</p>`)
    expect(screen.getByRole('button', { name: '保存笔记' })).toBeDisabled()
    expect(screen.getByText(/请缩短正文后保存/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Markdown' }))
    expect((screen.getByRole('textbox', { name: '笔记正文' }) as HTMLTextAreaElement).value).toHaveLength(50001)
    expect(saved).not.toHaveBeenCalled()
  })
  it('rejects an image exceeding the note capacity and keeps the original text', async () => {
    const changed = mount('已有正文')
    const bytes = new Uint8Array(40000); bytes.set([137, 80, 78, 71, 13, 10, 26, 10])
    const file = new File([bytes], 'large.png', { type: 'image/png' })
    Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes.buffer })
    fireEvent.change(screen.getByLabelText('选择笔记图片'), { target: { files: [file] } })
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('超过笔记容量'))
    expect(screen.getByRole('textbox', { name: '笔记正文' })).toHaveTextContent('已有正文')
    expect(changed).not.toHaveBeenCalled()
  })
})
