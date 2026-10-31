import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AssistantApp from './AssistantApp'
import { createPreviewAssistantClient } from './client'
import type { AssistantClient, AssistantTask } from './client'
import type { ModelSettingsClient } from '../solutions/modelSettings'

const input = (title: string) => ({ id: crypto.randomUUID(), title, project: '测试项目', instructions: '区分资料原文与待确认信息。' })
function models(defaultProfileId: string | null = null): ModelSettingsClient {
  return { get: vi.fn(async () => ({ revision: 1, defaultProfileId, profiles: [{ id: 'private-model', name: '我的模型', provider: 'openai' as const, model: 'my-model', baseUrl: 'https://api.openai.com/v1', keySet: false }] })), save: vi.fn(), test: vi.fn() }
}
async function mount(client = createPreviewAssistantClient('owner'), modelClient = models()) {
  const view = render(<AssistantApp client={client} modelClient={modelClient} userName="研究员" preview />)
  await waitFor(() => expect(screen.queryByText('读取任务…')).not.toBeInTheDocument())
  await waitFor(() => expect(screen.getByRole('button', { name: '任务设置' })).toBeEnabled())
  return { ...view, client, modelClient }
}
const composer = () => screen.getByRole('textbox', { name: '给 AI 助手的任务' })
const chat = () => screen.getByLabelText('任务对话')
async function open(title: string) {
  const sidebar = screen.getByRole('complementary', { name: '任务导航' })
  fireEvent.click(await within(sidebar).findByRole('button', { name: new RegExp(title) }))
  await screen.findByRole('heading', { name: title, level: 2 })
}
async function create(client: AssistantClient, title: string) { return client.create(input(title)) }
beforeEach(() => localStorage.clear())

describe('AI assistant task workspace', () => {
  it('creates a named project task and saves changes through the task settings form', async () => {
    const { client } = await mount()
    fireEvent.click(screen.getByRole('button', { name: '新建任务' }))
    const dialog = screen.getByRole('dialog', { name: '新建任务' })
    fireEvent.change(within(dialog).getByLabelText('任务名称'), { target: { value: '  本周研究梳理  ' } })
    fireEvent.change(within(dialog).getByLabelText('项目'), { target: { value: '研究项目一' } })
    fireEvent.change(within(dialog).getByLabelText('任务指引'), { target: { value: '输出清晰的行动项。' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存任务' }))
    await screen.findByRole('heading', { name: '本周研究梳理', level: 2 })
    let saved = (await client.list({ search: '本周研究梳理' })).items[0]
    expect(saved).toMatchObject({ title: '本周研究梳理', project: '研究项目一', instructions: '输出清晰的行动项。' })
    fireEvent.click(screen.getByRole('button', { name: '任务设置' }))
    const settings = screen.getByRole('dialog', { name: '任务设置' })
    fireEvent.change(within(settings).getByLabelText('任务名称'), { target: { value: '本周研究进展与计划' } })
    fireEvent.change(within(settings).getByLabelText('任务指引'), { target: { value: '按进展、风险和下一步整理。' } })
    fireEvent.click(within(settings).getByRole('button', { name: '保存任务' }))
    await screen.findByRole('heading', { name: '本周研究进展与计划', level: 2 })
    saved = (await client.list({ search: '本周研究进展与计划' })).items[0]
    expect(saved).toMatchObject({ revision: 2, instructions: '按进展、风险和下一步整理。' })
  })

  it('confirms deletion and restores a task with its conversation from the recycle bin', async () => {
    const client = createPreviewAssistantClient('trash'), task = await create(client, '待整理任务')
    await mount(client)
    await open(task.title)
    fireEvent.change(composer(), { target: { value: '保留这条对话' } })
    fireEvent.click(screen.getByRole('button', { name: '发送任务消息' }))
    await within(chat()).findByRole('button', { name: '查看产物' })
    fireEvent.click(screen.getByRole('button', { name: '删除任务' }))
    let dialog = screen.getByRole('dialog', { name: '删除任务' })
    expect(within(dialog).getByText(/待整理任务/)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    expect((await client.list({})).items.some(item => item.id === task.id)).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '删除任务' }))
    dialog = screen.getByRole('dialog', { name: '删除任务' })
    fireEvent.click(within(dialog).getByRole('button', { name: '移至回收站' }))
    await waitFor(async () => expect((await client.list({})).items.some(item => item.id === task.id)).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: '回收站' }))
    await open(task.title)
    expect(within(chat()).getAllByText('保留这条对话').length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: '删除任务' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '恢复任务' }))
    await waitFor(async () => expect((await client.list({})).items.some(item => item.id === task.id)).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: '返回任务' }))
    await open(task.title)
    expect(within(chat()).getAllByText('保留这条对话').length).toBeGreaterThan(0)
    expect((await client.get(task.id)).artifacts).toHaveLength(1)
  })

  it('sends the current question and chosen material, then displays its independent answer artifact', async () => {
    const client = createPreviewAssistantClient('materials'), task = await create(client, '资料分析任务'), send = vi.spyOn(client, 'send')
    await mount(client)
    await open(task.title)
    fireEvent.click(screen.getByRole('button', { name: '添加任务资料' }))
    const dialog = screen.getByRole('dialog', { name: '本轮任务资料' })
    fireEvent.change(within(dialog).getByRole('textbox', { name: '本轮资料正文' }), { target: { value: '原始观察：待补充验证条件，未形成确定结论。' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '应用资料' }))
    fireEvent.change(composer(), { target: { value: '请把这些观察整理成下一步计划。' } })
    fireEvent.click(screen.getByRole('button', { name: '发送任务消息' }))
    await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ id: task.id }), expect.objectContaining({ question: '请把这些观察整理成下一步计划。', context: '原始观察：待补充验证条件，未形成确定结论。', modelProfileId: 'enterprise' })))
    await within(chat()).findByRole('button', { name: '查看产物' })
    expect(composer()).toHaveValue('')
    const result = screen.getByRole('complementary', { name: '任务结果区' })
    expect(within(result).getByRole('heading', { name: '请把这些观察整理成下一步计划。' })).toBeInTheDocument()
    expect(within(result).getByRole('button', { name: '导出 Markdown' })).toBeEnabled()
    const stored = await client.get(task.id)
    expect(stored.messages[0].context).toBe('原始观察：待补充验证条件，未形成确定结论。')
    expect(stored.artifacts).toHaveLength(1)
    expect(within(result).getByRole('combobox', { name: '选择任务产物' })).toHaveValue(stored.artifacts[0].id)
  })

  it('sends on Enter while preserving Shift+Enter and IME composition', async () => {
    const client = createPreviewAssistantClient('keyboard'), task = await create(client, '键盘发送'), send = vi.spyOn(client, 'send')
    await mount(client)
    await open(task.title)
    fireEvent.change(composer(), { target: { value: '请整理项目进展' } })
    expect(fireEvent.keyDown(composer(), { key: 'Enter', shiftKey: true })).toBe(true)
    fireEvent.keyDown(composer(), { key: 'Enter', isComposing: true })
    fireEvent.keyDown(composer(), { key: 'Enter', keyCode: 229 })
    expect(send).not.toHaveBeenCalled()
    fireEvent.keyDown(composer(), { key: 'Enter' })
    await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ id: task.id }), expect.objectContaining({ question: '请整理项目进展' })))
    await within(chat()).findByRole('button', { name: '查看产物' })
  })

  it('saves the selected data sources and sends them with subsequent questions', async () => {
    const client = createPreviewAssistantClient('sources'), task = await create(client, '数据问答'), send = vi.spyOn(client, 'send')
    await mount(client)
    await open(task.title)
    fireEvent.click(screen.getByRole('button', { name: /数据设置/ }))
    const dialog = screen.getByRole('dialog', { name: '数据设置' })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /项目管理/ }))
    fireEvent.click(within(dialog).getByRole('button', { name: '保存设置' }))
    fireEvent.change(composer(), { target: { value: '目前有哪些项目？' } })
    fireEvent.click(screen.getByRole('button', { name: '发送任务消息' }))
    await waitFor(() => expect(send).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ data_sources: ['projects'] })))
    fireEvent.click(screen.getByRole('button', { name: /数据设置/ }))
    expect(within(screen.getByRole('dialog', { name: '数据设置' })).getByRole('checkbox', { name: /项目管理/ })).toBeChecked()
    expect(within(screen.getByRole('dialog', { name: '数据设置' })).getByRole('checkbox', { name: /知识库/ })).not.toBeChecked()
  })

  it('retains a failed question and retries with the same request UUID', async () => {
    const client = createPreviewAssistantClient('retry'), task = await create(client, '重试任务'), send = vi.spyOn(client, 'send')
    send.mockRejectedValueOnce(new Error('模型暂时不可用，请稍后重试。'))
    await mount(client)
    await open(task.title)
    fireEvent.change(composer(), { target: { value: '请整理这项工作的下一步。' } })
    fireEvent.click(screen.getByRole('button', { name: '发送任务消息' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('模型暂时不可用')
    expect(composer()).toHaveValue('请整理这项工作的下一步。')
    const firstRequest = send.mock.calls[0][1].requestId
    fireEvent.click(screen.getByRole('button', { name: '发送任务消息' }))
    await within(chat()).findByRole('button', { name: '查看产物' })
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1][1].requestId).toBe(firstRequest)
    expect((await client.get(task.id)).messages).toHaveLength(2)
    expect(composer()).toHaveValue('')
  })

  it('keeps an in-flight answer on its originating task and preserves another task draft', async () => {
    const client = createPreviewAssistantClient('concurrency'), first = await create(client, '原任务 A'), second = await create(client, '另一个任务 B')
    const original = client.send
    let finish!: () => void
    vi.spyOn(client, 'send').mockImplementation(async (task, question) => {
      const answered = await original(task, question)
      return new Promise<AssistantTask>(resolve => { finish = () => resolve(answered) })
    })
    await mount(client)
    await open(first.title)
    fireEvent.change(composer(), { target: { value: '任务 A 的研究问题' } })
    fireEvent.click(screen.getByRole('button', { name: '发送任务消息' }))
    await waitFor(() => expect(finish).toBeDefined())
    await open(second.title)
    fireEvent.change(composer(), { target: { value: '任务 B 未发送的草稿' } })
    await act(async () => finish())
    expect(screen.getByRole('heading', { name: second.title, level: 2 })).toBeInTheDocument()
    expect(composer()).toHaveValue('任务 B 未发送的草稿')
    expect(within(chat()).queryByText('任务 A 的研究问题')).not.toBeInTheDocument()
    await open(first.title)
    expect(within(chat()).getAllByText('任务 A 的研究问题').length).toBeGreaterThan(0)
    expect(composer()).toHaveValue('')
    await open(second.title)
    expect(composer()).toHaveValue('任务 B 未发送的草稿')
    expect((await client.get(second.id)).messageCount).toBe(0)
  })

  it('preserves an explicit enterprise-model selection when model settings reload on focus', async () => {
    const modelClient = models('private-model')
    await mount(createPreviewAssistantClient('models'), modelClient)
    const select = screen.getByRole('combobox', { name: '助手回答模型' })
    await waitFor(() => expect(select).toHaveValue('private-model'))
    fireEvent.change(select, { target: { value: 'enterprise' } })
    await act(async () => { fireEvent.focus(window) })
    expect(modelClient.get).toHaveBeenCalledTimes(2)
    expect(select).toHaveValue('enterprise')
  })
})
