import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import AssistantApp from './AssistantApp'
import { createPreviewAssistantClient, type AssistantClient, type AssistantPreflight, type AssistantRequest } from './client'
import { writeDataSources } from './dataSources'
import type { ModelSettingsClient } from '../solutions/modelSettings'

const missingKnowledge = '该问题需要知识库资料，请先在数据设置中启用知识库'
const ready: AssistantPreflight = { ready: true, checks: [{ key: 'scope', status: 'ready', message: '范围有效' }] }
const blocked: AssistantPreflight = { ready: false, checks: [{ key: 'scope', status: 'blocked', message: missingKnowledge }] }
const check: NonNullable<AssistantClient['preflight']> = async input => input.question?.includes('知识库') && input.answerMode !== 'general' && !input.dataSources.includes('knowledge') ? blocked : ready
const models: ModelSettingsClient = { get: async () => ({ revision: 1, profiles: [], defaultProfileId: null }), save: vi.fn(), test: vi.fn() }

beforeEach(() => localStorage.clear())

async function fixture(asynchronous = true) {
  const client = createPreviewAssistantClient(crypto.randomUUID())
  const task = await client.create({ id: crypto.randomUUID(), title: '数据范围回归', instructions: '' })
  await client.send(task, { requestId: crypto.randomUUID(), question: '知识库里有哪些论文？', context: '', answerMode: 'general', data_sources: [] })
  client.preflight = vi.fn(check)
  if (asynchronous) {
    let job: AssistantRequest | null = null
    client.activeRequest = vi.fn(async () => ({ request: job }))
    client.getRequest = vi.fn(async () => job!)
    client.submitRequest = vi.fn(async (target, input) => {
      job = { taskId: target.id, requestId: input.requestId, question: input.question, context: input.context, requestedMode: input.answerMode, dataSources: ['knowledge'], status: 'queued', stage: 'queued', partialContent: '', error: '', diagnosticId: 'a'.repeat(32), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
      return job
    })
  }
  const open = async () => {
    render(<AssistantApp client={client} modelClient={models} userName="回归用户" namespace="scope-regression" preview />)
    fireEvent.click(await screen.findByRole('button', { name: `打开任务：${task.title}` }))
    await screen.findByRole('heading', { name: task.title, level: 2 })
    await waitFor(() => expect(screen.getByRole('textbox', { name: '给 AI 助手的任务' })).toBeEnabled())
    fireEvent.click(screen.getByText('换种方式重新回答'))
  }
  return { client, task, open }
}

function reask() { fireEvent.click(screen.getByRole('button', { name: '改用自动判断重新回答' })) }
function saveKnowledge(enabled = true) {
  fireEvent.click(screen.getByRole('button', { name: /数据设置/ }))
  const dialog = within(screen.getByRole('dialog', { name: '数据设置' }))
  const checkbox = dialog.getByRole('checkbox', { name: /知识库/ }) as HTMLInputElement
  if (checkbox.checked !== enabled) fireEvent.click(checkbox)
  fireEvent.click(dialog.getByRole('button', { name: '保存设置' }))
}

it('replaces a stale scope error after saving, and waits for an explicit re-answer with the selected source', async () => {
  const { client, open } = await fixture(); await open(); reask()
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(missingKnowledge))
  expect(screen.getByRole('button', { name: '打开数据设置' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '刷新任务' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '打开数据设置' }))
  const dialog = within(screen.getByRole('dialog', { name: '数据设置' }))
  fireEvent.click(dialog.getByRole('checkbox', { name: /知识库/ }))
  fireEvent.click(dialog.getByRole('button', { name: '保存设置' }))
  await screen.findByText('配置检查通过；实际可用性以本次请求结果为准。')
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(screen.getByText('数据设置已保存，请重新回答。')).toBeInTheDocument()
  expect(screen.getByLabelText('当前应用数据范围')).toHaveTextContent('应用数据：知识库')
  expect(client.submitRequest).not.toHaveBeenCalled()
  reask()
  await waitFor(() => expect(client.submitRequest).toHaveBeenCalledTimes(1))
  expect(client.submitRequest).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ answerMode: 'auto', data_sources: ['knowledge'], question: '知识库里有哪些论文？' }))
})

it('uses the new answer mode in the same click that changes it and submits', async () => {
  const { client, open } = await fixture(); await open(); saveKnowledge(); reask()
  await waitFor(() => expect(client.submitRequest).toHaveBeenCalledTimes(1))
  expect(client.submitRequest).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ answerMode: 'auto', data_sources: ['knowledge'] }))
})

it('ignores an old background check arriving after the current settings passed', async () => {
  const { client, open } = await fixture(), old: ((result: AssistantPreflight) => void)[] = []
  client.preflight = vi.fn(async input => input.dataSources.includes('knowledge') ? ready : new Promise<AssistantPreflight>(resolve => old.push(resolve)))
  await open(); await waitFor(() => expect(old.length).toBeGreaterThan(0)); saveKnowledge()
  await screen.findByText('配置检查通过；实际可用性以本次请求结果为准。')
  await act(async () => old.forEach(resolve => resolve(blocked)))
  expect(screen.queryByText(missingKnowledge)).not.toBeInTheDocument()
  expect(client.submitRequest).not.toHaveBeenCalled()
})

it.each(['blocked', 'ready', 'rejected'] as const)('does not submit or restore errors when a %s send check arrives after settings change', async outcome => {
  const { client, open } = await fixture()
  let resolve!: (result: AssistantPreflight) => void, reject!: (error: Error) => void
  client.preflight = vi.fn(async input => input.question && !input.dataSources.includes('knowledge') ? new Promise<AssistantPreflight>((yes, no) => { resolve = yes; reject = no }) : ready)
  await open(); reask(); await waitFor(() => expect(resolve).toBeDefined()); saveKnowledge()
  await act(async () => { if (outcome === 'rejected') reject(new Error('旧配置检查连接失败')); else resolve(outcome === 'ready' ? ready : blocked) })
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(client.submitRequest).not.toHaveBeenCalled()
  reask(); await waitFor(() => expect(client.submitRequest).toHaveBeenCalledTimes(1))
  expect(client.submitRequest).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ data_sources: ['knowledge'] }))
})

it('does not revive an old check when the user changes settings away and back', async () => {
  const { client, open } = await fixture(); let finish!: (result: AssistantPreflight) => void
  client.preflight = vi.fn(async input => input.question ? new Promise<AssistantPreflight>(resolve => { finish = resolve }) : ready)
  await open(); reask(); await waitFor(() => expect(finish).toBeDefined()); saveKnowledge(); saveKnowledge(false)
  await act(async () => finish(ready))
  expect(client.submitRequest).not.toHaveBeenCalled()
  expect(screen.getByText('设置已更新，刚才的提问尚未发送，请重新回答。')).toBeInTheDocument()
})

it('keeps an actual generation failure visible after data settings change', async () => {
  const { client, open } = await fixture(false)
  client.send = vi.fn(async () => { throw new Error('模型等待超时，问题已保留。') })
  await open(); fireEvent.click(screen.getByRole('button', { name: '改用通用回答重新回答' }))
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('模型等待超时'))
  saveKnowledge()
  expect(screen.getByRole('alert')).toHaveTextContent('模型等待超时')
  expect(client.send).toHaveBeenCalledTimes(1)
})

it('directs model configuration failures to model settings', async () => {
  const { client, open } = await fixture()
  client.preflight = vi.fn(async (): Promise<AssistantPreflight> => ({ ready: false, checks: [{ key: 'model', status: 'blocked', message: '模型密钥未配置' }] }))
  await open(); reask()
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('模型密钥未配置'))
  expect(screen.getByRole('link', { name: '打开 AI 模型设置' })).toHaveAttribute('href', '/model-settings?preview=1')
  expect(client.submitRequest).not.toHaveBeenCalled()
})

it('opens project login for an unlinked account and preserves the question until an explicit retry', async () => {
  const { client, open } = await fixture(false)
  writeDataSources(localStorage, 'assistant-data-sources:scope-regression:preview', ['projects'])
  let linked = false
  client.preflight = vi.fn(async (input): Promise<AssistantPreflight> => input.question && !linked
    ? { ready: false, checks: [{ key: 'projects', status: 'blocked', action: 'project-login', message: '请先打开项目管理完成登录，再回到助手重新发送。' }] }
    : ready)
  const send = vi.spyOn(client, 'send')
  await open()
  const composer = screen.getByRole('textbox', { name: '给 AI 助手的任务' })
  fireEvent.change(composer, { target: { value: '项目有哪些节点要过期？' } })
  fireEvent.click(screen.getByRole('button', { name: '发送任务消息' }))
  const alert = await screen.findByRole('alert')
  const link = within(alert).getByRole('link', { name: '打开项目管理' })
  const destination = new URL(link.getAttribute('href')!)
  expect(destination.pathname).toBe('/api/v1/auth/login')
  expect(destination.searchParams.get('return_to')).toBe('/dashboard')
  expect(link).toHaveAttribute('target', '_blank')
  expect(link).toHaveAttribute('rel', 'noreferrer')
  expect(within(alert).queryByRole('button', { name: '打开数据设置' })).not.toBeInTheDocument()
  await act(async () => { fireEvent.focus(window) })
  expect(composer).toHaveValue('项目有哪些节点要过期？')
  expect(send).not.toHaveBeenCalled()
  linked = true
  fireEvent.click(screen.getByRole('button', { name: '发送任务消息' }))
  await waitFor(() => expect(send).toHaveBeenCalledOnce())
})

it('keeps account and project permission errors away from data-source settings', async () => {
  const { client, open } = await fixture(false)
  writeDataSources(localStorage, 'assistant-data-sources:scope-regression:preview', ['projects'])
  client.preflight = vi.fn(async (input): Promise<AssistantPreflight> => input.question
    ? { ready: false, checks: [{ key: 'projects', status: 'blocked', message: '项目管理账号已停用，请联系管理员。' }] }
    : ready)
  const send = vi.spyOn(client, 'send')
  await open()
  const composer = screen.getByRole('textbox', { name: '给 AI 助手的任务' })
  fireEvent.change(composer, { target: { value: '项目有哪些节点要过期？' } })
  fireEvent.click(screen.getByRole('button', { name: '发送任务消息' }))
  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent('项目管理账号已停用')
  expect(within(alert).queryByRole('link', { name: '打开项目管理' })).not.toBeInTheDocument()
  expect(within(alert).queryByRole('button', { name: '打开数据设置' })).not.toBeInTheDocument()
  expect(composer).toHaveValue('项目有哪些节点要过期？')
  expect(send).not.toHaveBeenCalled()
})

it('still opens data settings when the project source has not been selected', async () => {
  const { client, open } = await fixture(false)
  client.preflight = vi.fn(async (input): Promise<AssistantPreflight> => input.question
    ? { ready: false, checks: [{ key: 'scope', status: 'blocked', message: '该问题需要项目管理数据，请先在数据设置中勾选项目管理' }] }
    : ready)
  await open()
  const composer = screen.getByRole('textbox', { name: '给 AI 助手的任务' })
  fireEvent.change(composer, { target: { value: '项目有哪些节点要过期？' } })
  fireEvent.click(screen.getByRole('button', { name: '发送任务消息' }))
  const alert = await screen.findByRole('alert')
  expect(within(alert).getByRole('button', { name: '打开数据设置' })).toBeInTheDocument()
  expect(within(alert).queryByRole('link', { name: '打开项目管理' })).not.toBeInTheDocument()
})

it('refreshes model checks and clears the old configuration error after editing the same model profile', async () => {
  const client = createPreviewAssistantClient('model-config-refresh')
  const task = await client.create({ id: crypto.randomUUID(), title: '更新模型配置', instructions: '' })
  let revision = 1
  const modelClient: ModelSettingsClient = { get: vi.fn(async () => ({ revision, profiles: [], defaultProfileId: null })), save: vi.fn(), test: vi.fn() }
  client.preflight = vi.fn(async (): Promise<AssistantPreflight> => revision === 1 ? { ready: false, checks: [{ key: 'web', status: 'blocked', message: '当前模型联网尚未配置' }] } : ready)
  client.send = vi.fn(client.send)
  render(<AssistantApp client={client} modelClient={modelClient} userName="模型检查用户" preview />)
  fireEvent.click(await screen.findByRole('button', { name: `打开任务：${task.title}` }))
  await screen.findByRole('heading', { name: task.title, level: 2 })
  const composer = screen.getByRole('textbox', { name: '给 AI 助手的任务' })
  fireEvent.change(composer, { target: { value: '检索近期研究进展' } })
  fireEvent.click(screen.getByRole('button', { name: '发送任务消息' }))
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('当前模型联网尚未配置'))
  expect(screen.getAllByText('当前模型联网尚未配置')).toHaveLength(1)
  expect(client.send).not.toHaveBeenCalled()
  revision = 2
  fireEvent.focus(window)
  await screen.findByText('配置检查通过；实际可用性以本次请求结果为准。')
  expect(screen.queryByText('当前模型联网尚未配置')).not.toBeInTheDocument()
  expect(composer).toHaveValue('检索近期研究进展')
  expect(client.send).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '发送任务消息' }))
  await waitFor(() => expect(client.send).toHaveBeenCalledTimes(1))
})
