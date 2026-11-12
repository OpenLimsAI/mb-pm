import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import AssistantApp from './AssistantApp'
import { createPreviewAssistantClient, type AssistantRequest } from './client'
import { readDraft, writeDraft } from './localDrafts'
import { writeDataSources } from './dataSources'
import type { ModelSettingsClient } from '../solutions/modelSettings'

const question = '最新的生物制药论文'
const context = '本轮参考正文'
const scope = 'composer-flow:preview'
const composer = () => screen.getByRole('textbox', { name: '给 AI 助手的任务' })
const models: ModelSettingsClient = { get: async () => ({ revision: 1, profiles: [], defaultProfileId: null }), save: vi.fn(), test: vi.fn() }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
beforeEach(() => localStorage.clear())

function openEmptyComposer() {
  const namespace = crypto.randomUUID()
  localStorage.setItem(`mberp:assistant:preview:v1:${encodeURIComponent(namespace)}`, '[]')
  const client = createPreviewAssistantClient(namespace)
  render(<AssistantApp client={client} modelClient={models} userName="测试用户" namespace="first-message" preview />)
  return client
}

it('starts a task from the first question and sends only once with the selected application data', async () => {
  writeDataSources(localStorage, 'assistant-data-sources:first-message:preview', ['projects'])
  const client = openEmptyComposer()
  const create = vi.spyOn(client, 'create'), send = vi.spyOn(client, 'send')
  const firstQuestion = '当前有哪些项目？'
  expect(composer()).toBeEnabled()
  fireEvent.change(composer(), { target: { value: firstQuestion } })
  fireEvent.click(screen.getByRole('button', { name: '添加任务资料' }))
  fireEvent.change(screen.getByRole('textbox', { name: '本轮资料正文' }), { target: { value: context } })
  fireEvent.click(screen.getByRole('button', { name: '应用资料' }))
  expect(create).not.toHaveBeenCalled()
  fireEvent.keyDown(composer(), { key: 'Enter' })
  fireEvent.keyDown(composer(), { key: 'Enter' })
  await waitFor(() => expect(composer()).toHaveValue(''))
  expect(create).toHaveBeenCalledOnce()
  expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ title: firstQuestion }), expect.objectContaining({ question: firstQuestion, context, data_sources: ['projects'] }))
  expect(screen.getByRole('heading', { name: firstQuestion, level: 2 })).toBeInTheDocument()
  expect(await client.list()).toMatchObject({ total: 1 })
})

it('keeps the first question when the creation response is lost and reuses the created task on retry', async () => {
  const client = openEmptyComposer(), createTask = client.create
  const create = vi.spyOn(client, 'create').mockImplementationOnce(async input => {
    await createTask(input)
    throw new Error('创建任务响应丢失')
  })
  const send = vi.spyOn(client, 'send')
  fireEvent.change(composer(), { target: { value: question } })
  fireEvent.click(screen.getByRole('button', { name: '发送任务消息' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('创建任务响应丢失')
  expect(composer()).toHaveValue(question)
  expect(send).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '发送任务消息' }))
  await waitFor(() => expect(composer()).toHaveValue(''))
  expect(create.mock.calls[1]).toEqual(create.mock.calls[0])
  expect(send).toHaveBeenCalledOnce()
  expect(await client.list()).toMatchObject({ total: 1 })
})

it('keeps the question and offers a settings shortcut when the first send is blocked before creation', async () => {
  const client = openEmptyComposer()
  client.preflight = vi.fn(async () => ({ ready: false, checks: [{ key: 'scope', status: 'blocked' as const, message: '请检查数据设置' }] }))
  const create = vi.spyOn(client, 'create')
  fireEvent.change(composer(), { target: { value: question } })
  fireEvent.keyDown(composer(), { key: 'Enter' })
  expect(await screen.findByRole('alert')).toHaveTextContent('请检查数据设置')
  expect(screen.getByRole('button', { name: '打开数据设置' })).toBeInTheDocument()
  expect(composer()).toHaveValue(question)
  expect(create).not.toHaveBeenCalled()
})

it('offers a non-web answer without opening model settings or sending the draft automatically', async () => {
  const client = openEmptyComposer()
  client.preflight = vi.fn(async input => input.question && input.answerMode !== 'general'
    ? { ready: false, checks: [{ key: 'web', status: 'blocked' as const, message: '联网搜索未启用，请联系管理员在服务端开启。' }] }
    : { ready: true, checks: [] })
  const create = vi.spyOn(client, 'create'), send = vi.spyOn(client, 'send')
  fireEvent.change(composer(), { target: { value: question } })
  fireEvent.keyDown(composer(), { key: 'Enter' })
  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent('请联系管理员')
  expect(within(alert).queryByRole('link', { name: '打开 AI 模型设置' })).not.toBeInTheDocument()
  fireEvent.click(within(alert).getByRole('button', { name: '改用通用回答' }))
  expect(screen.getByRole('combobox', { name: '回答方式' })).toHaveValue('general')
  expect(composer()).toHaveValue(question)
  expect(create).not.toHaveBeenCalled()
  expect(send).not.toHaveBeenCalled()
  fireEvent.keyDown(composer(), { key: 'Enter' })
  await waitFor(() => expect(send).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ answerMode: 'general', question })))
})

it('does not send or leave the recycle bin when task creation finishes after navigation', async () => {
  const client = openEmptyComposer(), createTask = client.create, creation = deferred<void>()
  const create = vi.spyOn(client, 'create').mockImplementation(async input => {
    await creation.promise
    return createTask(input)
  })
  const send = vi.spyOn(client, 'send')
  fireEvent.change(composer(), { target: { value: question } })
  fireEvent.keyDown(composer(), { key: 'Enter' })
  await waitFor(() => expect(create).toHaveBeenCalledOnce())
  fireEvent.click(screen.getByRole('button', { name: '回收站' }))
  await act(async () => creation.resolve())
  expect(screen.queryByRole('textbox', { name: '给 AI 助手的任务' })).not.toBeInTheDocument()
  expect(send).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '任务列表' }))
  fireEvent.click(await screen.findByRole('button', { name: `打开任务：${question}` }))
  await waitFor(() => expect(composer()).toHaveValue(question))
})

async function fixture() {
  const client = createPreviewAssistantClient(crypto.randomUUID())
  const task = await client.create({ id: crypto.randomUUID(), title: '输入框提交回归', instructions: '' })
  let record: AssistantRequest | null = null
  const makeJob = (patch: Partial<AssistantRequest> = {}): AssistantRequest => ({
    requestId: vi.mocked(client.submitRequest!).mock.lastCall?.[1].requestId || crypto.randomUUID(),
    taskId: task.id, question, context, status: 'queued', stage: 'queued', partialContent: '', error: '',
    diagnosticId: 'b'.repeat(32), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...patch,
  })
  client.activeRequest = vi.fn(async () => ({ request: record }))
  client.getRequest = vi.fn(async () => record!)
  client.submitRequest = vi.fn(async () => { record = makeJob(); return record })
  const props = { client, modelClient: models, userName: '测试用户', namespace: 'composer-flow', preview: true }
  const seed = () => writeDraft(scope, task.id, { question, context, label: '参考资料' })
  const open = async () => {
    const view = render(<AssistantApp {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: `打开任务：${task.title}` }))
    await screen.findByRole('heading', { name: task.title, level: 2 })
    await waitFor(() => expect(composer()).toBeEnabled())
    await waitFor(() => expect(client.activeRequest).toHaveBeenCalled())
    return view
  }
  const send = async () => {
    await waitFor(() => expect(screen.getByRole('button', { name: '发送任务消息' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '发送任务消息' }))
    await waitFor(() => expect(client.submitRequest).toHaveBeenCalledOnce())
  }
  const accept = async (submission: ReturnType<typeof deferred<AssistantRequest>>) => {
    record = makeJob()
    await act(async () => submission.resolve(record!))
    const progress = screen.getByRole('region', { name: '本轮生成进度' })
    expect(within(progress).getByText(question)).toBeInTheDocument()
  }
  const finish = async (patch: Partial<AssistantRequest>) => {
    record = { ...record!, ...patch }
    await act(async () => { window.dispatchEvent(new Event('focus')) })
  }
  return { client, task, makeJob, seed, open, send, accept, finish, setRecord: (value: AssistantRequest) => { record = value } }
}

it('keeps input until acceptance, then displays it only in the request card and clears the saved draft', async () => {
  const f = await fixture(), submission = deferred<AssistantRequest>()
  f.client.submitRequest = vi.fn(() => submission.promise)
  f.seed(); await f.open(); await f.send()
  expect(composer()).toHaveValue(question)
  expect(screen.getByRole('button', { name: '移除本轮资料' })).toBeInTheDocument()
  expect(readDraft(scope, f.task.id)?.question).toBe(question)
  await f.accept(submission)
  expect(composer()).toHaveValue('')
  expect(screen.queryByRole('button', { name: '移除本轮资料' })).not.toBeInTheDocument()
  expect(screen.getByRole('region', { name: '本轮生成进度' })).toHaveTextContent(context)
  expect(readDraft(scope, f.task.id)).toBeUndefined()
  expect(f.client.submitRequest).toHaveBeenCalledOnce()
})

it('keeps a new question typed while acceptance is pending, including after the first request fails', async () => {
  const f = await fixture(), submission = deferred<AssistantRequest>()
  f.client.submitRequest = vi.fn(() => submission.promise)
  f.seed(); await f.open(); await f.send()
  fireEvent.change(composer(), { target: { value: '下一轮要问的新问题' } })
  await f.accept(submission)
  expect(composer()).toHaveValue('下一轮要问的新问题')
  await f.finish({ status: 'failed', error: '模型等待超时' })
  expect(composer()).toHaveValue('下一轮要问的新问题')
  expect(readDraft(scope, f.task.id)?.question).toBe('下一轮要问的新问题')
})

it('keeps an identical question and material typed after acceptance when the first answer completes', async () => {
  const f = await fixture()
  f.seed(); await f.open(); await f.send()
  await waitFor(() => expect(composer()).toHaveValue(''))
  fireEvent.change(composer(), { target: { value: question } })
  fireEvent.click(screen.getByRole('button', { name: '添加任务资料' }))
  fireEvent.change(screen.getByRole('textbox', { name: '本轮资料正文' }), { target: { value: context } })
  fireEvent.click(screen.getByRole('button', { name: '应用资料' }))
  await f.client.send(f.task, { requestId: f.makeJob().requestId, question, context })
  await f.finish({ status: 'completed' })
  await waitFor(() => expect(screen.queryByRole('region', { name: '本轮生成进度' })).not.toBeInTheDocument())
  expect(composer()).toHaveValue(question)
  expect(readDraft(scope, f.task.id)?.context).toBe(context)
  expect(f.client.submitRequest).toHaveBeenCalledOnce()
})

it('preserves the same question with different material instead of clearing or restoring over it', async () => {
  const f = await fixture(), submission = deferred<AssistantRequest>()
  f.client.submitRequest = vi.fn(() => submission.promise)
  f.seed(); await f.open(); await f.send()
  fireEvent.click(screen.getByRole('button', { name: '添加任务资料' }))
  fireEvent.change(screen.getByRole('textbox', { name: '本轮资料正文' }), { target: { value: '下一轮的新资料' } })
  fireEvent.click(screen.getByRole('button', { name: '应用资料' }))
  await f.accept(submission)
  expect(composer()).toHaveValue(question)
  expect(readDraft(scope, f.task.id)?.context).toBe('下一轮的新资料')
  await f.finish({ status: 'failed', error: '模型等待超时' })
  expect(readDraft(scope, f.task.id)?.context).toBe('下一轮的新资料')
})

it.each([false, true])('resumes a running request without repeating its question in the composer (saved old draft: %s)', async saved => {
  const f = await fixture()
  if (saved) f.seed()
  f.setRecord(f.makeJob({ status: 'running', stage: 'waiting_model' }))
  await f.open()
  await screen.findByText('本轮提问')
  expect(screen.getByRole('region', { name: '本轮生成进度' })).toHaveTextContent(question)
  expect(composer()).toHaveValue('')
  expect(readDraft(scope, f.task.id)).toBeUndefined()
  expect(f.client.submitRequest).not.toHaveBeenCalled()
})

it.each(['failed', 'cancelled'] as const)('restores accepted input after %s when there is no new draft', async status => {
  const f = await fixture()
  f.seed(); await f.open(); await f.send()
  await waitFor(() => expect(composer()).toHaveValue(''))
  await f.finish({ status, error: status === 'failed' ? '模型等待超时' : '' })
  expect(composer()).toHaveValue(question)
  expect(readDraft(scope, f.task.id)?.context).toBe(context)
  expect(screen.getByRole('button', { name: '重新生成' })).toBeInTheDocument()
  expect(f.client.submitRequest).toHaveBeenCalledOnce()
})

it('does not restore a retired failed payload', async () => {
  const f = await fixture()
  f.seed(); await f.open(); await f.send()
  await waitFor(() => expect(composer()).toHaveValue(''))
  await f.finish({ status: 'failed', payloadExpired: true, question: '', context: '', error: '临时输入已清理' })
  expect(composer()).toHaveValue('')
  expect(readDraft(scope, f.task.id)).toBeUndefined()
  expect(screen.queryByRole('button', { name: '重新生成' })).not.toBeInTheDocument()
})

it('preserves input when the server rejects the submission', async () => {
  const f = await fixture()
  f.client.submitRequest = vi.fn(async () => { throw Object.assign(new Error('请求未被接收'), { status: 422 }) })
  f.seed(); await f.open(); await f.send()
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('请求未被接收'))
  expect(composer()).toHaveValue(question)
  expect(readDraft(scope, f.task.id)?.context).toBe(context)
  expect(screen.queryByText('本轮提问')).not.toBeInTheDocument()
})

it('keeps input through an unknown POST result and clears it only when the same request is found', async () => {
  const f = await fixture(), lookup = deferred<AssistantRequest>()
  f.client.submitRequest = vi.fn(async () => { throw new Error('提交响应丢失') })
  f.client.getRequest = vi.fn(() => lookup.promise)
  f.seed(); await f.open(); await f.send()
  await waitFor(() => expect(f.client.getRequest).toHaveBeenCalledOnce())
  expect(composer()).toHaveValue(question)
  const input = vi.mocked(f.client.submitRequest!).mock.lastCall![1]
  expect(f.client.getRequest).toHaveBeenCalledWith(f.task.id, input.requestId)
  await act(async () => lookup.resolve(f.makeJob({ status: 'running', stage: 'waiting_model' })))
  expect(screen.getByRole('region', { name: '本轮生成进度' })).toHaveTextContent(question)
  expect(composer()).toHaveValue('')
  expect(f.client.submitRequest).toHaveBeenCalledOnce()
})

it('shows a failed request only once in its card while preserving the partial draft and original question', async () => {
  const f = await fixture()
  f.seed(); await f.open(); await f.send()
  await f.finish({ status: 'failed', error: '回答达到模型输出上限，问题已保留。', errorCode: 'output_limit', partialContent: '已经完成的正文', canContinue: true })
  const progress = screen.getByRole('region', { name: '本轮生成进度' })
  expect(screen.getAllByRole('alert')).toHaveLength(1)
  expect(within(progress).getByRole('alert')).toHaveTextContent('回答达到模型输出上限')
  expect(screen.getAllByText('回答达到模型输出上限，问题已保留。')).toHaveLength(1)
  expect(within(progress).getByText('已经完成的正文')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '复制未完成草稿' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '编辑问题' }))
  expect(composer()).toHaveFocus()
  expect(composer()).toHaveValue(question)
  expect(f.client.submitRequest).toHaveBeenCalledOnce()
})

it.each([403, 404])('keeps a single actual error after a %s poll response removes the saved job', async status => {
  const f = await fixture()
  f.seed(); await f.open(); await f.send()
  f.client.getRequest = vi.fn(async () => { throw Object.assign(new Error('当前请求已不可读取'), { status }) })
  await act(async () => { window.dispatchEvent(new Event('focus')) })
  const progress = screen.getByRole('region', { name: '本轮生成进度' })
  expect(screen.getAllByRole('alert')).toHaveLength(1)
  expect(within(progress).getByRole('alert')).toHaveTextContent('当前请求已不可读取')
  expect(screen.getAllByText('当前请求已不可读取')).toHaveLength(1)
  expect(within(progress).queryByText('本轮提问')).not.toBeInTheDocument()
  expect(f.client.submitRequest).toHaveBeenCalledOnce()
})

it('displays an active-request access failure once even without a known request ID', async () => {
  const f = await fixture()
  f.client.activeRequest = vi.fn(async () => { throw Object.assign(new Error('当前账号无法读取请求状态'), { status: 403 }) })
  f.seed(); await f.open()
  expect(await screen.findByRole('alert')).toHaveTextContent('当前账号无法读取请求状态')
  expect(screen.getAllByText('当前账号无法读取请求状态')).toHaveLength(1)
  expect(composer()).toHaveValue(question)
  expect(f.client.submitRequest).not.toHaveBeenCalled()
})

it('keeps a new unsent preflight error separate from an earlier failed request', async () => {
  const f = await fixture()
  f.seed(); await f.open(); await f.send()
  await f.finish({ status: 'failed', error: '上一轮回答超限' })
  f.client.preflight = vi.fn(async () => ({ ready: false, checks: [{ key: 'model', status: 'blocked' as const, message: '新问题需要先配置模型' }] }))
  fireEvent.change(composer(), { target: { value: '用户正在准备的另一条问题' } })
  fireEvent.click(screen.getByRole('button', { name: '发送任务消息' }))
  await screen.findByText('新问题需要先配置模型')
  expect(screen.getAllByRole('alert')).toHaveLength(2)
  expect(screen.getAllByText('上一轮回答超限')).toHaveLength(1)
  expect(screen.getByRole('link', { name: '打开 AI 模型设置' })).toBeInTheDocument()
  expect(composer()).toHaveValue('用户正在准备的另一条问题')
  expect(f.client.submitRequest).toHaveBeenCalledOnce()
})
