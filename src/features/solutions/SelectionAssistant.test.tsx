import { useState } from 'react'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import InlineAssistantEditor from './InlineAssistantEditor'
import type { InlineQuestion } from './InlineAssistantEditor'
import type { Answer, PolishResult } from './types'

const answer: Answer = { id: 'selected-answer', question: '相关知识？', content: '这是有待核对的知识摘录。', mode: 'retrieval', context: '', scope: '', references: [], createdAt: '' }
function mount(initial = '前文。待润色的文字。后文。', cards: InlineQuestion[] = [], disabled = false) {
  const ask = vi.fn(async () => answer), polish = vi.fn(async (): Promise<PolishResult> => ({ content: '改进后的文字', model: 'test-editor', mode: 'ai' })), adopt = vi.fn(), edit = vi.fn()
  function Editor() {
    const [content, setContent] = useState(initial)
    return <div className="ks-app"><InlineAssistantEditor content={content} cards={cards} disabled={disabled} scope="选定资料" modelLabel="我的模型"
      onEdit={change => { edit(change); setContent(current => current.slice(0, change.from) + change.insert + current.slice(change.to)) }}
      onSelection={() => {}} onCreate={() => {}} onUpdate={() => {}} onRemove={() => {}} onAsk={() => {}} onAdopt={() => {}} onSource={() => {}}
      onAskSelectedText={ask} onPolishSelectedText={polish} onAdoptSelectedAnswer={adopt} /></div>
  }
  const view = render(<Editor />)
  return { ...view, ask, polish, adopt, edit, body: screen.getByRole('textbox', { name: '章节正文' }) as HTMLTextAreaElement }
}
function select(input: HTMLTextAreaElement, start = 3, end = 9) {
  fireEvent.focus(input)
  fireEvent.select(input, { target: { selectionStart: start, selectionEnd: end } })
}
function openPolish(body: HTMLTextAreaElement) {
  select(body)
  fireEvent.click(within(screen.getByRole('toolbar', { name: '选中文字操作' })).getByRole('button', { name: 'Polish 文字' }))
  return screen.getByRole('dialog', { name: 'Polish 文字 · 润色' })
}

beforeEach(() => { localStorage.setItem('ks-editor-mode', 'markdown') })

describe('selected report text assistant', () => {
  it('offers two actions after selecting text, without sending requests or editing', () => {
    const { body, ask, polish, edit } = mount()
    select(body)
    const menu = screen.getByRole('toolbar', { name: '选中文字操作' })
    expect(within(menu).getByRole('button', { name: '询问 AI' })).toBeVisible()
    expect(within(menu).getByRole('button', { name: 'Polish 文字' })).toBeVisible()
    expect(ask).not.toHaveBeenCalled(); expect(polish).not.toHaveBeenCalled(); expect(edit).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('toolbar', { name: '选中文字操作' })).not.toBeInTheDocument()
    select(body); fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('toolbar', { name: '选中文字操作' })).not.toBeInTheDocument()
    select(body); select(body, 3, 3)
    expect(screen.queryByRole('toolbar', { name: '选中文字操作' })).not.toBeInTheDocument()
  })

  it('attaches exactly the selection to a question and adopts only on explicit request', async () => {
    const { body, ask, adopt, edit } = mount()
    select(body)
    const original = body.value, selected = original.slice(3, 9)
    fireEvent.click(screen.getByRole('button', { name: '询问 AI' }))
    const dialog = screen.getByRole('dialog', { name: '询问 AI · 选中文字' })
    expect(within(dialog).getByText(selected, { exact: true })).toBeVisible()
    fireEvent.change(within(dialog).getByRole('textbox', { name: '关于选中文字的问题' }), { target: { value: '有哪些依据？' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '发送问题' }))
    expect(await within(dialog).findByText(answer.content)).toBeVisible()
    expect(ask).toHaveBeenCalledWith('有哪些依据？', selected)
    expect(edit).not.toHaveBeenCalled(); expect(adopt).not.toHaveBeenCalled()
    expect(body).toHaveValue(original)
    fireEvent.click(within(dialog).getByRole('button', { name: '插入报告…' }))
    expect(adopt).toHaveBeenCalledWith(answer)
  })

  it('previews editable polish and replaces only the selected occurrence, with undo and redo', async () => {
    const { body, polish } = mount('前文。重复文字。重复文字。后文。')
    select(body, 8, 12)
    fireEvent.click(screen.getByRole('button', { name: 'Polish 文字' }))
    const dialog = screen.getByRole('dialog', { name: 'Polish 文字 · 润色' })
    fireEvent.change(within(dialog).getByRole('textbox', { name: '润色要求' }), { target: { value: '更简洁' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '开始润色' }))
    const result = await within(dialog).findByRole('textbox', { name: '润色后的文字' })
    expect(polish).toHaveBeenCalledWith('重复文字', '更简洁')
    expect(body).toHaveValue('前文。重复文字。重复文字。后文。')
    fireEvent.change(result, { target: { value: '专家修订' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '替换选中文字' }))
    expect(body).toHaveValue('前文。重复文字。专家修订。后文。')
    fireEvent.click(screen.getByRole('button', { name: '撤销正文编辑' }))
    expect(body).toHaveValue('前文。重复文字。重复文字。后文。')
    fireEvent.click(screen.getByRole('button', { name: '重做正文编辑' }))
    expect(body).toHaveValue('前文。重复文字。专家修订。后文。')
  })

  it('keeps the original after a failure or cancellation and permits retrying', async () => {
    const { body, polish, edit } = mount()
    polish.mockRejectedValueOnce(new Error('模型暂时不可用'))
    const dialog = openPolish(body)
    fireEvent.click(within(dialog).getByRole('button', { name: '开始润色' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('模型暂时不可用')
    expect(edit).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: '开始润色' }))
    await within(dialog).findByRole('textbox', { name: '润色后的文字' })
    fireEvent.click(within(dialog).getByRole('button', { name: '保留原文' }))
    expect(edit).not.toHaveBeenCalled()
    expect(body).toHaveValue('前文。待润色的文字。后文。')
  })

  it('does not overwrite text changed while a suggestion was pending', async () => {
    const { body } = mount()
    const dialog = openPolish(body)
    fireEvent.click(within(dialog).getByRole('button', { name: '开始润色' }))
    await within(dialog).findByRole('textbox', { name: '润色后的文字' })
    fireEvent.change(body, { target: { value: '其他编辑已经改变原文' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '替换选中文字' }))
    expect(within(dialog).getByRole('alert')).toHaveTextContent('原文已发生变化')
    expect(body).toHaveValue('其他编辑已经改变原文')
  })

  it('replaces a selection after an inline card using its document offset and retains the card node', async () => {
    const cards: InlineQuestion[] = [{ id: 'card-one', offset: 3, sectionId: 's1', question: '保留问题', includeContext: false, status: 'idle' }]
    const { edit } = mount('前文。待润色的文字。后文。', cards)
    const body = screen.getByRole('textbox', { name: '章节正文（续 1）' }) as HTMLTextAreaElement
    const card = screen.getByRole('region', { name: '正文 AI 问答' })
    select(body, 0, 6)
    fireEvent.click(screen.getByRole('button', { name: 'Polish 文字' }))
    const dialog = screen.getByRole('dialog', { name: 'Polish 文字 · 润色' })
    fireEvent.click(within(dialog).getByRole('button', { name: '开始润色' }))
    await within(dialog).findByRole('textbox', { name: '润色后的文字' })
    fireEvent.click(within(dialog).getByRole('button', { name: '替换选中文字' }))
    expect(edit).toHaveBeenCalledWith(expect.objectContaining({ from: 3 }))
    expect(body).toHaveValue('改进后的文字。后文。')
    expect(screen.getByRole('region', { name: '正文 AI 问答' })).toBe(card)
    expect(within(card).getByRole('textbox', { name: '想了解什么？' })).toHaveValue('保留问题')
  })

  it('ignores a late response after the window is dismissed', async () => {
    const { body, polish } = mount()
    let done!: (result: PolishResult) => void
    polish.mockImplementationOnce(() => new Promise(resolve => { done = resolve }))
    const dialog = openPolish(body)
    fireEvent.click(within(dialog).getByRole('button', { name: '开始润色' }))
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭选中文字助手' }))
    await act(async () => done({ content: '迟到的结果', mode: 'ai', model: 'test' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(body).toHaveValue('前文。待润色的文字。后文。')
  })

  it('rejects an oversized selection before sending and omits actions for read-only reports', () => {
    const view = mount('a'.repeat(5001))
    select(view.body, 0, 5001)
    fireEvent.click(screen.getByRole('button', { name: 'Polish 文字' }))
    const dialog = screen.getByRole('dialog', { name: 'Polish 文字 · 润色' })
    expect(within(dialog).getByRole('button', { name: '开始润色' })).toBeDisabled()
    expect(within(dialog).getByRole('alert')).toHaveTextContent('5,000')
    expect(view.polish).not.toHaveBeenCalled()
    view.unmount()
    const readonly = mount('只读报告', [], true)
    select(readonly.body, 0, 4)
    expect(screen.queryByRole('toolbar', { name: '选中文字操作' })).not.toBeInTheDocument()
  })
})
