import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SolutionsApp from './SolutionsApp'
import { createDemoClient } from './demo'
import type { ModelSettingsClient } from './modelSettings'
import type { Answer, PolishResult } from './types'

const answer: Answer = { id: 'selection-question', question: '相关依据', content: '已核对的演示依据。', mode: 'retrieval', references: [], context: '', scope: '', createdAt: '' }
async function mount() {
  const client = createDemoClient('selected-writing', 'author', '研究员')
  const ask = vi.spyOn(client, 'ask').mockResolvedValue(answer)
  const polish = vi.spyOn(client, 'polish').mockResolvedValue({ content: '润色后的研究目标。', model: 'my-model', mode: 'ai' })
  const modelClient: ModelSettingsClient = {
    get: vi.fn(async () => ({ revision: 1, defaultProfileId: 'my-profile', profiles: [{ id: 'my-profile', name: '我的编辑模型', provider: 'deepseek' as const, model: 'my-model', baseUrl: 'https://api.deepseek.com', keySet: true }] })),
    save: vi.fn(), test: vi.fn(),
  }
  render(<SolutionsApp client={client} userId="author" userName="研究员" preview={false} modelClient={modelClient} />)
  const body = await screen.findByRole('textbox', { name: '章节正文' }) as HTMLTextAreaElement
  await waitFor(() => expect(screen.getByRole('combobox', { name: '当前 AI 模型' })).toHaveValue('my-profile'))
  return { client, ask, polish, body }
}
function select(body: HTMLTextAreaElement) {
  fireEvent.focus(body)
  fireEvent.select(body, { target: { selectionStart: 5, selectionEnd: 24 } })
  return body.value.slice(5, 24)
}
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('ks-writing-mode', 'split') })

describe('selected text model integration', () => {
  it('sends selected text and the current model without altering the report, then uses the existing adoption confirmation', async () => {
    const { body, ask } = await mount()
    const original = body.value, text = select(body)
    fireEvent.click(screen.getByRole('button', { name: '询问 AI' }))
    const dialog = screen.getByRole('dialog', { name: '询问 AI · 选中文字' })
    fireEvent.change(within(dialog).getByRole('textbox', { name: '关于选中文字的问题' }), { target: { value: '这段有哪些依据？' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '发送问题' }))
    await within(dialog).findByText(answer.content)
    expect(ask).toHaveBeenCalledWith('demo-solution', expect.objectContaining({ question: '这段有哪些依据？', context: text, modelProfileId: 'my-profile' }))
    expect(body).toHaveValue(original)
    fireEvent.click(within(dialog).getByRole('button', { name: '插入报告…' }))
    const confirm = screen.getByRole('dialog', { name: '确认采纳 · 知识摘录' })
    expect(body).toHaveValue(original)
    fireEvent.click(within(confirm).getByRole('button', { name: '确认插入并保留引用' }))
    expect(body.value).toContain(answer.content)
  })

  it('uses the same chosen model for polish, locks model changes in flight, and supports a text undo', async () => {
    const { body, polish } = await mount()
    let resolve!: (result: PolishResult) => void
    polish.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const original = body.value, text = select(body)
    fireEvent.click(screen.getByRole('button', { name: 'Polish 文字' }))
    const dialog = screen.getByRole('dialog', { name: 'Polish 文字 · 润色' })
    fireEvent.click(within(dialog).getByRole('button', { name: '开始润色' }))
    await waitFor(() => expect(polish).toHaveBeenCalledWith('demo-solution', expect.objectContaining({ text, instruction: '', modelProfileId: 'my-profile' })))
    expect(polish.mock.calls[0][1]).not.toHaveProperty('answerMode')
    expect(screen.getByRole('combobox', { name: '当前 AI 模型' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'AI模型设置' })).toBeDisabled()
    expect(body).toHaveValue(original)
    await act(async () => resolve({ content: '润色后的研究目标。', model: 'my-model', mode: 'ai' }))
    await within(dialog).findByRole('textbox', { name: '润色后的文字' })
    fireEvent.click(within(dialog).getByRole('button', { name: '替换选中文字' }))
    expect(body).toHaveValue(original.slice(0, 5) + '润色后的研究目标。' + original.slice(24))
    expect(screen.getByRole('combobox', { name: '当前 AI 模型' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: '撤销正文编辑' }))
    expect(body).toHaveValue(original)
  })

  it('does not call a generation model for polish when only retrieval was selected', async () => {
    const { body, polish } = await mount()
    fireEvent.change(screen.getByRole('combobox', { name: '当前 AI 模型' }), { target: { value: 'retrieval' } })
    select(body)
    fireEvent.click(screen.getByRole('button', { name: 'Polish 文字' }))
    const dialog = screen.getByRole('dialog', { name: 'Polish 文字 · 润色' })
    fireEvent.click(within(dialog).getByRole('button', { name: '开始润色' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('文字润色需要 AI 模型')
    expect(polish).not.toHaveBeenCalled()
  })
})
