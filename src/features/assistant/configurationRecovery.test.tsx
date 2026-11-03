import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import AssistantApp from './AssistantApp'
import { createPreviewAssistantClient, type AssistantClient, type AssistantPreflight, type AssistantRequest } from './client'
import type { ModelSettingsClient } from '../solutions/modelSettings'

const missingKnowledge = '请先在数据设置中启用知识库，再使用仅知识库回答'
const ready: AssistantPreflight = { ready: true, checks: [{ key: 'scope', status: 'ready', message: '范围有效' }] }
const blocked: AssistantPreflight = { ready: false, checks: [{ key: 'scope', status: 'blocked', message: missingKnowledge }] }
const check: NonNullable<AssistantClient['preflight']> = async input => input.answerMode === 'knowledge' && !input.dataSources.includes('knowledge') ? blocked : ready
const models: ModelSettingsClient = { get: async () => ({ revision: 1, profiles: [], defaultProfileId: null }), save: vi.fn(), test: vi.fn() }

beforeEach(() => localStorage.clear())

async function fixture(asynchronous = true) {
  const client = createPreviewAssistantClient(crypto.randomUUID())
  const task = await client.create({ id: crypto.randomUUID(), title: '数据范围回归', instructions: '' })
  await client.send(task, { requestId: crypto.randomUUID(), question: '解释研究问题', context: '', answerMode: 'general', data_sources: [] })
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
    await screen.findByRole('heading', { name: task.title, level: 2 })
    await waitFor(() => expect(screen.getByRole('textbox', { name: '给 AI 助手的任务' })).toBeEnabled())
    fireEvent.click(screen.getByText('换个范围重新回答'))
  }
  return { client, task, open }
}

function reask() { fireEvent.click(screen.getByRole('button', { name: '改用仅知识库重新回答' })) }
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
  expect(client.submitRequest).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ answerMode: 'knowledge', data_sources: ['knowledge'], question: '解释研究问题' }))
})

it('uses the new answer mode in the same click that changes it and submits', async () => {
  const { client, open } = await fixture(); await open(); saveKnowledge(); reask()
  await waitFor(() => expect(client.submitRequest).toHaveBeenCalledTimes(1))
  expect(client.submitRequest).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ answerMode: 'knowledge', data_sources: ['knowledge'] }))
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
