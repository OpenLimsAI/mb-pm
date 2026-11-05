import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { Markdown } from '@tiptap/markdown'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { htmlToReportMarkdown } from './reportMarkup'
import { MarkdownBold, MarkdownItalic, MarkdownStrike, markdownMark } from './markdownMarks'
import { RichBodySegment } from './RichBodySegment'

const editors: Editor[] = []
function open(content: string, contentType: 'markdown' | 'html' = 'markdown') {
  const editor = new Editor({
    extensions: [StarterKit.configure({ bold: false, italic: false, strike: false }), MarkdownBold, MarkdownItalic, MarkdownStrike, TaskList, TaskItem.configure({ nested: true }), Markdown],
    content, contentType,
  })
  editors.push(editor)
  return editor
}
afterEach(() => { editors.splice(0).forEach(editor => editor.destroy()); cleanup() })

describe('Markdown format boundaries', () => {
  it('does not change ordinary Markdown marks', () => {
    expect(markdownMark('重点', '**', '重点')).toBe('**重点**')
    expect(markdownMark('重点', '*', '重点')).toBe('*重点*')
  })

  it.each([
    ['bold ending with CJK punctuation', '<p><strong>重点结论：</strong>每一项结论均应核对。</p>'],
    ['bold starting with punctuation', '<p>每<strong>：重点</strong>一项</p>'],
    ['bold at paragraph start with punctuation at both ends', '<p><strong>：重点：</strong>每一项</p>'],
    ['italic with CJK punctuation', '<p>每<em>：重点：</em>一项</p>'],
    ['nested bold and italic', '<p>每<strong><em>：重点：</em></strong>一项</p>'],
    ['neighboring distinct marks', '<p><strong>重点：</strong><em>另一项：</em>结束</p>'],
    ['ASCII punctuation', '<p>each<strong>(result)</strong>remains</p>'],
    ['symbol boundaries', '<p>每<strong>★重点★</strong>一项</p>'],
    ['strikethrough punctuation', '<p>每<del>：旧结论：</del>一项</p>'],
    ['formatted list item start', '<ul><li><strong>：重点：</strong>每一项</li></ul>'],
  ])('preserves exact text and marks through HTML paste and repeated reopening: %s', (_label, html) => {
    const expected = open(html, 'html')
    const pasted = open(htmlToReportMarkdown(html))
    expect(pasted.getJSON()).toEqual(expected.getJSON())
    expect(pasted.state.doc.textContent).toBe(expected.state.doc.textContent)

    const saved = pasted.getMarkdown()
    const reopened = open(saved)
    expect(reopened.getJSON()).toEqual(expected.getJSON())
    expect(reopened.getMarkdown()).toBe(saved)

    const preview = render(<ReactMarkdown skipHtml remarkPlugins={[remarkGfm]}>{saved}</ReactMarkdown>)
    expect(preview.container.textContent?.replaceAll('\n', '')).toBe(expected.state.doc.textContent)
    for (const selector of ['strong', 'em', 'del']) {
      const original = new DOMParser().parseFromString(html, 'text/html').querySelectorAll(selector)
      expect(preview.container.querySelectorAll(selector).length).toBe(original.length)
    }
  })

  it('uses the same stable serialization for marks created directly in the editor', () => {
    const editor = open('重点结论：每一项')
    editor.chain().setTextSelection({ from: 1, to: 6 }).setBold().run()
    const markdown = editor.getMarkdown()
    expect(markdown).toBe('**重点结论：**<span></span>每一项')
    expect(open(markdown).getJSON()).toEqual(editor.getJSON())
    expect(editor.state.doc.textContent).toBe('重点结论：每一项')
  })

  it('pastes CJK bold content through the shared writing surface without literal delimiters', () => {
    Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 100, height: 20, top: 0, right: 100, bottom: 20, left: 0, toJSON: () => ({}) })
    Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList
    const change = vi.fn()
    const view = render(<RichBodySegment value="" label="粘贴正文" disabled={false} onChange={change} onRange={() => {}} onActive={() => {}} onSlash={() => {}} />)
    fireEvent.paste(screen.getByRole('textbox', { name: '粘贴正文' }), { clipboardData: { files: [], getData: (type: string) => type === 'text/html' ? '<p><strong>重点结论：</strong>每一项结论均应核对。</p>' : '' } })
    expect(view.container.querySelector('strong')?.textContent).toBe('重点结论：')
    expect(view.container.querySelector('[contenteditable]')?.textContent).toBe('重点结论：每一项结论均应核对。')
    expect(open(change.mock.lastCall?.[0]).getHTML()).toBe('<p><strong>重点结论：</strong>每一项结论均应核对。</p>')
  })

  it('keeps existing task-list state while formatting and reopening', () => {
    const editor = open('- [ ] 待核对\n- [x] 已核对')
    editor.commands.selectAll()
    editor.commands.setBold()
    const reopened = open(editor.getMarkdown())
    expect(reopened.getJSON()).toEqual(editor.getJSON())
    const checked: boolean[] = []
    reopened.state.doc.descendants(node => { if (node.type.name === 'taskItem') checked.push(node.attrs.checked) })
    expect(checked).toEqual([false, true])
  })
})
