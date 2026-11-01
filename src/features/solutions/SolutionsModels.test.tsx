import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SolutionsApp from './SolutionsApp'
import { createDemoClient } from './demo'
import type { ModelProfileDraft, ModelSettings, ModelSettingsClient, ModelSettingsInput } from './modelSettings'
import type { Answer } from './types'

const configuration = (): ModelSettings => ({ revision: 3, defaultProfileId: 'profile-one', profiles: [
  { id: 'profile-one', name: '研究模型', provider: 'deepseek', model: 'research-model', baseUrl: 'https://api.deepseek.com', keySet: true },
  { id: 'profile-two', name: '审阅模型', provider: 'glm', model: 'review-model', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', keySet: true },
] })
function models(): ModelSettingsClient {
  return {
    get: vi.fn(async () => configuration()),
    save: vi.fn(async (input: ModelSettingsInput) => ({ revision: input.revision + 1, defaultProfileId: input.defaultProfileId, profiles: input.profiles.map(profile => ({ id: profile.id, name: profile.name, provider: profile.provider, model: profile.model, baseUrl: profile.baseUrl, keySet: true })) })),
    test: vi.fn(async (profile: ModelProfileDraft) => ({ ok: true, model: profile.model, ms: 20 })),
  }
}
async function mount(modelClient = models()) {
  const client = createDemoClient('model-integration', 'author', '研究员')
  const ask = vi.spyOn(client, 'ask')
  render(<SolutionsApp client={client} userId="author" userName="研究员" preview={false} modelClient={modelClient} />)
  await screen.findByRole('textbox', { name: '章节正文' })
  return { client, ask, modelClient }
}
function insertCard() {
  const body = screen.getByRole('textbox', { name: '章节正文' }) as HTMLTextAreaElement
  fireEvent.input(body, { target: { value: '/' + body.value, selectionStart: 1, selectionEnd: 1 }, inputType: 'insertText', data: '/' })
  fireEvent.click(screen.getByRole('menuitem', { name: /AI 问答/ }))
  return screen.getByRole('region', { name: '正文 AI 问答' })
}
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('ks-writing-mode', 'split') })

describe('knowledge report model integration', () => {
  it('keeps layout in the top bar and the single highlighted AI settings entry inside the assistant', async () => {
    await mount()
    const header = document.querySelector('.ks-topbar') as HTMLElement
    expect(within(header).getByRole('button', { name: '排列布局' })).toBeVisible()
    expect(within(header).queryByRole('button', { name: 'AI模型设置' })).not.toBeInTheDocument()
    const assistant = screen.getByRole('region', { name: 'AI研究助手面板' })
    expect(within(assistant).getByRole('button', { name: 'AI模型设置' })).toHaveClass('ks-primary')
    expect(screen.getAllByRole('button', { name: 'AI模型设置' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('switch', { name: '专注模式' }))
    expect(within(header).getByRole('button', { name: '排列布局' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'AI模型设置' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '打开AI研究助手' }))
    fireEvent.click(screen.getByRole('button', { name: 'AI模型设置' }))
    expect(screen.getByRole('dialog', { name: 'AI 模型设置' })).toBeVisible()
  })

  it('loads the personal default and sends an explicitly chosen profile for assistant questions', async () => {
    const { ask, modelClient } = await mount()
    const select = screen.getByRole('combobox', { name: '当前 AI 模型' })
    await waitFor(() => expect(select).toHaveValue('profile-one'))
    expect(modelClient.test).not.toHaveBeenCalled()
    fireEvent.change(select, { target: { value: 'profile-two' } })
    fireEvent.change(screen.getByRole('combobox', { name: '回答方式' }), { target: { value: 'knowledge' } })
    fireEvent.change(screen.getByRole('textbox', { name: '向AI提问' }), { target: { value: '缓冲体系有哪些证据？' } })
    fireEvent.click(screen.getByRole('button', { name: '发送问题' }))
    await waitFor(() => expect(ask).toHaveBeenCalledWith('demo-solution', expect.objectContaining({ modelProfileId: 'profile-two', question: '缓冲体系有哪些证据？', answerMode: 'knowledge' })))
    expect(await screen.findByText(/找到 .* 份相关演示资料/)).toBeVisible()
    expect(select).toHaveValue('profile-two')
  })

  it('uses the same selected model for inline questions and locks switching during a request', async () => {
    const { ask } = await mount()
    const select = screen.getByRole('combobox', { name: '当前 AI 模型' })
    await waitFor(() => expect(select).toHaveValue('profile-one'))
    fireEvent.change(select, { target: { value: 'profile-two' } })
    const card = insertCard()
    expect(within(card).getByText('审阅模型 · review-model')).toBeVisible()
    let resolve!: (answer: Answer) => void
    ask.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    fireEvent.change(within(card).getByRole('textbox', { name: '想了解什么？' }), { target: { value: '比较研究条件' } })
    fireEvent.click(within(card).getByRole('button', { name: '提问' }))
    await waitFor(() => expect(ask).toHaveBeenCalledWith('demo-solution', expect.objectContaining({ modelProfileId: 'profile-two', question: '比较研究条件' })))
    expect(select).toBeDisabled()
    expect(screen.getByRole('button', { name: 'AI模型设置' })).toBeDisabled()
    await act(async () => resolve({ id: 'answer-model', question: '比较研究条件', content: '模型回答', mode: 'ai', model: 'review-model', references: [], context: '', scope: '授权资料', createdAt: new Date().toISOString() }))
    expect(await within(card).findByText('模型回答')).toBeVisible()
    expect(select).toBeEnabled()
    expect(within(card).getByText('review-model')).toBeVisible()
  })

  it('keeps report and inline drafts mounted while saving a new default model', async () => {
    const { modelClient } = await mount()
    await waitFor(() => expect(screen.getByRole('combobox', { name: '当前 AI 模型' })).toHaveValue('profile-one'))
    const card = insertCard(), body = screen.getByRole('textbox', { name: '章节正文' })
    fireEvent.change(within(card).getByRole('textbox', { name: '想了解什么？' }), { target: { value: '尚未发送的问题' } })
    fireEvent.click(screen.getByRole('button', { name: 'AI模型设置' }))
    const dialog = screen.getByRole('dialog', { name: 'AI 模型设置' })
    fireEvent.click(await within(dialog).findByRole('button', { name: '编辑配置：审阅模型' }))
    fireEvent.click(within(dialog).getByRole('checkbox', { name: '设为个人默认模型' }))
    fireEvent.click(within(dialog).getByRole('button', { name: '保存全部配置' }))
    await waitFor(() => expect(modelClient.save).toHaveBeenCalledWith(expect.objectContaining({ defaultProfileId: 'profile-two', revision: 3 })))
    await waitFor(() => expect(within(dialog).getByText('全部模型配置已保存。')).toBeVisible())
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }))
    expect(screen.getByRole('combobox', { name: '当前 AI 模型' })).toHaveValue('profile-two')
    expect(screen.getByRole('textbox', { name: '章节正文' })).toBe(body)
    expect(screen.getByRole('region', { name: '正文 AI 问答' })).toBe(card)
    expect(within(card).getByRole('textbox', { name: '想了解什么？' })).toHaveValue('尚未发送的问题')
  })

  it('does not send through an unknown configuration after a load error and permits explicit retrieval', async () => {
    const modelClient = models()
    vi.mocked(modelClient.get).mockRejectedValue(new Error('读取失败'))
    const { ask } = await mount(modelClient)
    expect(await screen.findByText('模型配置加载失败，当前仍可选择“仅检索资料”。')).toBeVisible()
    fireEvent.change(screen.getByRole('textbox', { name: '向AI提问' }), { target: { value: '缓冲体系' } })
    expect(screen.getByRole('button', { name: '发送问题' })).toBeDisabled()
    expect(ask).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('combobox', { name: '当前 AI 模型' }), { target: { value: 'retrieval' } })
    fireEvent.click(screen.getByRole('button', { name: '发送问题' }))
    await waitFor(() => expect(ask).toHaveBeenCalledWith('demo-solution', expect.objectContaining({ modelProfileId: 'retrieval' })))
  })

  it('does not let a late initial load overwrite a newly saved default', async () => {
    const modelClient = models()
    let resolve!: (value: ModelSettings) => void
    vi.mocked(modelClient.get).mockImplementationOnce(() => new Promise(done => { resolve = done }))
    await mount(modelClient)
    fireEvent.click(screen.getByRole('button', { name: 'AI模型设置' }))
    const dialog = screen.getByRole('dialog', { name: 'AI 模型设置' })
    fireEvent.click(await within(dialog).findByRole('button', { name: '编辑配置：审阅模型' }))
    fireEvent.click(within(dialog).getByRole('checkbox', { name: '设为个人默认模型' }))
    fireEvent.click(within(dialog).getByRole('button', { name: '保存全部配置' }))
    await within(dialog).findByText('全部模型配置已保存。')
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }))
    await act(async () => resolve(configuration()))
    expect(screen.getByRole('combobox', { name: '当前 AI 模型' })).toHaveValue('profile-two')
    expect(screen.getByRole('combobox', { name: '当前 AI 模型' })).toBeEnabled()
  })
})
