import { useState } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import InlineAssistantEditor from './InlineAssistantEditor'
import ReportMarkdown from './ReportMarkdown'
import { RichBodySegment } from './RichBodySegment'
import { getRange } from './richSelection'
import type { RichHandle } from './RichBodySegment'
import { htmlToReportMarkdown, readReportImage, stripReportImages } from './reportMarkup'

beforeEach(() => {
  localStorage.removeItem('ks-editor-mode')
  Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 100, height: 20, top: 0, right: 100, bottom: 20, left: 0, toJSON: () => ({}) })
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList
})
function mount(value = '# 目标\n\n**比较**实验') {
  let handle: RichHandle | null = null
  const change = vi.fn()
  function Harness() {
    const [content, setContent] = useState(value)
    return <RichBodySegment value={content} label="正文" disabled={false} onActive={value => { handle = value }} onRange={() => {}} onSlash={() => {}} onChange={value => { change(value); setContent(value) }} />
  }
  render(<Harness />)
  return { get handle() { return handle! }, change }
}
describe('visual report editor', () => {
  it('renders legacy Markdown as headings and marks without changing the saved content on mount', () => {
    const state = mount()
    expect(screen.getByRole('heading', { name: '目标' })).toBeInTheDocument()
    expect(screen.getByText('比较').tagName).toBe('STRONG')
    expect(state.change).not.toHaveBeenCalled()
  })
  it('supports structured editing and undo without losing Markdown persistence', () => {
    const state = mount('研究正文')
    act(() => { state.handle.editor.chain().focus().selectAll().toggleBold().run() })
    expect(state.change).toHaveBeenLastCalledWith('**研究正文**')
    act(() => { state.handle.editor.commands.undo() })
    expect(state.change).toHaveBeenLastCalledWith('研究正文')
    act(() => { state.handle.editor.chain().focus('end').insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run() })
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(state.handle.editor.getMarkdown()).toContain('|')
  })
  it('projects a marked text selection to the exact source range', () => {
    const state = mount('前 **实验** 后')
    act(() => { state.handle.editor.commands.setTextSelection({ from: 3, to: 5 }) })
    const range = getRange(state.handle.editor, '前 **实验** 后')!
    expect('前 **实验** 后'.slice(range.start, range.end)).toBe('实验')
  })
  it('defaults to visual editing with an explicit Markdown fallback', () => {
    render(<InlineAssistantEditor content="## 正文标题" cards={[]} disabled={false} scope="全部资料" onEdit={() => {}} onSelection={() => {}} onCreate={() => {}} onUpdate={() => {}} onRemove={() => {}} onAsk={() => {}} onAdopt={() => {}} onSource={() => {}} />)
    expect(screen.getByRole('heading', { name: '正文标题' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^Markdown$/ }))
    expect(screen.getByRole('textbox', { name: '章节正文' })).toHaveValue('## 正文标题')
  })
  it('does not emit remote image src in either visual editing or report preview, but retains normal hyperlinks', () => {
    const markdown = '![远程图片](https://example.org/tracker.png)\n\n[原始来源](https://example.org/paper)'
    mount(markdown)
    const preview = render(<ReportMarkdown>{markdown}</ReportMarkdown>)
    expect(document.querySelectorAll('img[src]')).toHaveLength(0)
    expect(preview.container.querySelector('a')?.getAttribute('href')).toBe('https://example.org/paper')
    expect(preview.container.textContent).toContain('远程图片')
  })
  it('converts Word HTML tables and marks and removes executable or external content', () => {
    const md = htmlToReportMarkdown('<h2>方法</h2><p><strong>证据</strong></p><table><tr><th>组别</th><th>结果</th></tr><tr><td>A</td><td>1</td></tr></table><script>alert(1)</script><img src="https://evil.test/t.png"><a href="javascript:alert(1)">坏链接</a>')
    expect(md).toContain('## 方法'); expect(md).toContain('**证据**'); expect(md).toContain('| 组别 | 结果 |'); expect(md).not.toContain('script'); expect(md).not.toContain('https://evil'); expect(md).not.toContain('javascript:')
  })
  it('rejects invalid/oversized images and strips image payloads from model context', async () => {
    await expect(readReportImage({ type: 'image/png', size: 2_000_000 } as File)).rejects.toThrow('1 MB')
    await expect(readReportImage({ type: 'image/png', size: 5, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4, 5]).buffer } as File)).rejects.toThrow('格式不符')
    expect(stripReportImages('结果 ![图](data:image/png;base64,aGVsbG8=)')).toBe('结果 [图片]')
  })
})
