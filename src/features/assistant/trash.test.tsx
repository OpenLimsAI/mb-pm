import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AssistantApp from './AssistantApp'
import { createPreviewAssistantClient } from './client'
import type { AssistantClient, AssistantTask, TaskSummary } from './client'
import type { ModelSettingsClient } from '../solutions/modelSettings'

function models(): ModelSettingsClient {
  return { get: vi.fn(async () => ({ revision: 1, defaultProfileId: null, profiles: [] })), save: vi.fn(), test: vi.fn() }
}
async function mount(client: AssistantClient, namespace = 'trash-regression') {
  const view = render(<AssistantApp client={client} modelClient={models()} userName="研究员" namespace={namespace} preview />)
  await waitFor(() => expect(screen.queryByText('读取任务…')).not.toBeInTheDocument())
  return view
}
async function create(client: AssistantClient, title: string) {
  return client.create({ id: crypto.randomUUID(), title, instructions: '保留任务原有资料。' })
}
async function deleted(client: AssistantClient, title: string) {
  return client.trash(await create(client, title))
}
const navigation = () => screen.getByRole('complementary', { name: '任务导航' })
const bin = () => screen.getByRole('region', { name: '已删除任务列表' })
const composer = () => screen.getByRole('textbox', { name: '给 AI 助手的任务' })
async function enterBin() {
  fireEvent.click(within(navigation()).getByRole('button', { name: '回收站' }))
  return screen.findByRole('region', { name: '已删除任务列表' })
}
async function openTask(title: string) {
  fireEvent.click(await within(navigation()).findByRole('button', { name: `打开任务：${title}` }))
  await screen.findByRole('heading', { name: title, level: 2 })
}
function expectBinWorkspace() {
  expect(screen.getByRole('main')).toContainElement(bin())
  expect(within(navigation()).getByRole('button', { name: '回收站' })).toHaveAttribute('aria-current', 'page')
  expect(within(navigation()).getByRole('button', { name: '任务列表' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '返回任务列表' })).toBeInTheDocument()
  expect(screen.queryByRole('textbox', { name: '给 AI 助手的任务' })).not.toBeInTheDocument()
  expect(screen.queryByRole('complementary', { name: '任务结果区' })).not.toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: /今天想完成什么|把一个想法，变成一份成果|从一个清晰的目标开始|任务概览|你的 AI 工作空间/ })).not.toBeInTheDocument()
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
beforeEach(() => localStorage.clear())

describe('assistant recycle bin workspace', () => {
  it('keeps explicit navigation and shows deleted tasks in the main workspace without opening one', async () => {
    const client = createPreviewAssistantClient('bin-main'), removed = await deleted(client, '已删除的调查任务'), active = await create(client, '进行中的调查任务')
    const list = vi.spyOn(client, 'list'), get = vi.spyOn(client, 'get')
    await mount(client)
    get.mockClear()
    await enterBin()
    await within(bin()).findByRole('button', { name: `查看已删除任务：${removed.title}` })
    expectBinWorkspace()
    expect(within(bin()).queryByText(active.title)).not.toBeInTheDocument()
    expect(within(bin()).getByText(/删除于/)).toBeInTheDocument()
    expect(within(navigation()).queryByRole('button', { name: `查看已删除任务：${removed.title}` })).not.toBeInTheDocument()
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ trashed: true, offset: 0 }))
    expect(get).not.toHaveBeenCalled()
  })

  it('renders an empty recycle bin without the new-task welcome or composer', async () => {
    const client = createPreviewAssistantClient('bin-empty')
    await mount(client)
    await enterBin()
    await within(bin()).findByText('回收站为空')
    expectBinWorkspace()
    expect(screen.queryByRole('button', { name: '创建第一项任务' })).not.toBeInTheDocument()
  })

  it('searches only deleted tasks and distinguishes no matches from an empty bin', async () => {
    const client = createPreviewAssistantClient('bin-search'), removed = await deleted(client, '归档实验设计')
    await create(client, '当前实验设计')
    const list = vi.spyOn(client, 'list')
    await mount(client)
    await enterBin()
    await within(bin()).findByRole('button', { name: `查看已删除任务：${removed.title}` })
    const search = within(bin()).getByRole('textbox', { name: '搜索回收站' })
    fireEvent.change(search, { target: { value: '实验设计' } })
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ trashed: true, search: '实验设计', offset: 0 })))
    await within(bin()).findByRole('button', { name: `查看已删除任务：${removed.title}` })
    expect(within(bin()).queryByText('当前实验设计')).not.toBeInTheDocument()
    fireEvent.change(search, { target: { value: '没有这个任务' } })
    await within(bin()).findByText('没有匹配的已删除任务')
    expect(within(bin()).queryByText('回收站为空')).not.toBeInTheDocument()
    expectBinWorkspace()
    fireEvent.change(search, { target: { value: '' } })
    await within(bin()).findByRole('button', { name: `查看已删除任务：${removed.title}` })
  })

  it('loads subsequent deleted-task pages in the central list with the same trash filter', async () => {
    const client = createPreviewAssistantClient('bin-pages'), first = await deleted(client, '第一页旧任务'), next = await deleted(client, '第二页旧任务')
    const originalList = client.list
    const list = vi.spyOn(client, 'list').mockImplementation(query => query?.trashed
      ? Promise.resolve({ items: query.offset ? [next] : [first], total: 2 })
      : originalList(query))
    await mount(client)
    await enterBin()
    await within(bin()).findByRole('button', { name: `查看已删除任务：${first.title}` })
    fireEvent.click(within(bin()).getByRole('button', { name: '加载更多已删除任务' }))
    await within(bin()).findByRole('button', { name: `查看已删除任务：${next.title}` })
    expect(within(bin()).getByRole('button', { name: `查看已删除任务：${first.title}` })).toBeInTheDocument()
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ trashed: true, offset: 1 }))
    expect(within(bin()).queryByRole('button', { name: '加载更多已删除任务' })).not.toBeInTheDocument()
    expectBinWorkspace()
  })

  it('keeps the recycle-bin workspace visible while its list is loading', async () => {
    const client = createPreviewAssistantClient('bin-loading'), removed = await deleted(client, '加载后的旧任务')
    const originalList = client.list, pending = deferred<{ items: TaskSummary[]; total: number }>()
    vi.spyOn(client, 'list').mockImplementation(query => query?.trashed ? pending.promise : originalList(query))
    await mount(client)
    await enterBin()
    await within(bin()).findByText('正在读取回收站…')
    expect(within(bin()).queryByText('回收站为空')).not.toBeInTheDocument()
    expectBinWorkspace()
    await act(async () => pending.resolve({ items: [removed], total: 1 }))
    await within(bin()).findByRole('button', { name: `查看已删除任务：${removed.title}` })
    expect(within(bin()).queryByText('正在读取回收站…')).not.toBeInTheDocument()
  })

  it('shows a recoverable list error instead of a task welcome or empty state', async () => {
    const client = createPreviewAssistantClient('bin-error'), removed = await deleted(client, '重试后出现的旧任务')
    const originalList = client.list
    let fail = true
    vi.spyOn(client, 'list').mockImplementation(query => query?.trashed && fail
      ? Promise.reject(new Error('回收站连接暂时中断。')) : originalList(query))
    await mount(client)
    await enterBin()
    await within(bin()).findByText('回收站暂时无法读取')
    expect(within(bin()).getByRole('alert')).toHaveTextContent('回收站连接暂时中断。')
    expect(within(bin()).queryByText('回收站为空')).not.toBeInTheDocument()
    expectBinWorkspace()
    fail = false
    fireEvent.click(within(bin()).getByRole('button', { name: '重试' }))
    await within(bin()).findByRole('button', { name: `查看已删除任务：${removed.title}` })
    expect(within(bin()).queryByRole('alert')).not.toBeInTheDocument()
  })

  it('opens deleted history read-only, returns to the bin, and confirms restoring its last task', async () => {
    const client = createPreviewAssistantClient('bin-detail'), created = await create(client, '保留对话和产物的旧任务')
    const answered = await client.send(created, { requestId: crypto.randomUUID(), question: '保存这段研究计划', context: '实验材料和原始数据', answerMode: 'general' })
    const removed = await client.trash(answered), send = vi.spyOn(client, 'send'), save = vi.spyOn(client, 'save'), restore = vi.spyOn(client, 'restore')
    await mount(client)
    await enterBin()
    fireEvent.click(await within(bin()).findByRole('button', { name: `查看已删除任务：${removed.title}` }))
    await screen.findByRole('heading', { name: removed.title, level: 2 })
    expect(screen.getByLabelText('任务对话')).toHaveTextContent('保存这段研究计划')
    expect(screen.getByText(/仅供查看/)).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: '给 AI 助手的任务' })).not.toBeInTheDocument()
    expect(screen.queryByText('换种方式重新回答')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /重新回答|记入任务记忆|发送任务消息|添加任务资料/ })).not.toBeInTheDocument()
    const settings = screen.queryByRole('button', { name: '任务设置' })
    if (settings) expect(settings).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '查看产物' }))
    expect(screen.getByRole('button', { name: '基于此稿修改' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '设为最终成果' })).toBeDisabled()
    expect(send).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: `恢复任务：${removed.title}` }))
    let dialog = screen.getByRole('dialog', { name: '恢复任务' })
    expect(within(dialog).getByText(new RegExp(removed.title))).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(restore).not.toHaveBeenCalled()
    expect((await client.list({ trashed: true })).items).toHaveLength(1)
    expect(screen.getByRole('heading', { name: removed.title, level: 2 })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '返回回收站列表' }))
    await within(bin()).findByRole('button', { name: `查看已删除任务：${removed.title}` })
    expectBinWorkspace()
    fireEvent.click(within(bin()).getByRole('button', { name: `恢复任务：${removed.title}` }))
    dialog = screen.getByRole('dialog', { name: '恢复任务' })
    fireEvent.click(within(dialog).getByRole('button', { name: '确认恢复' }))
    await within(bin()).findByText('回收站为空')
    expect(restore).toHaveBeenCalledWith(expect.objectContaining({ id: removed.id, revision: removed.revision }))
    expectBinWorkspace()
    fireEvent.click(screen.getByRole('button', { name: '返回任务列表' }))
    await openTask(removed.title)
    expect(composer()).toBeEnabled()
    expect(screen.getByLabelText('任务对话')).toHaveTextContent('保存这段研究计划')
    expect((await client.get(removed.id)).artifacts).toHaveLength(1)
  })

  it('ignores a normal-list response that arrives after navigating into the bin', async () => {
    const client = createPreviewAssistantClient('normal-list-late'), current = await create(client, '正常列表里的任务'), removed = await deleted(client, '回收站里的任务')
    const originalList = client.list, pending = deferred<{ items: TaskSummary[]; total: number }>()
    const list = vi.spyOn(client, 'list').mockImplementation(query => query?.search === '延迟请求' && !query.trashed ? pending.promise : originalList(query))
    await mount(client)
    fireEvent.change(within(navigation()).getByRole('textbox', { name: '搜索任务' }), { target: { value: '延迟请求' } })
    await waitFor(() => expect(list).toHaveBeenCalledWith(expect.objectContaining({ search: '延迟请求', trashed: false })))
    await enterBin()
    await within(bin()).findByRole('button', { name: `查看已删除任务：${removed.title}` })
    await act(async () => pending.resolve({ items: [current], total: 1 }))
    expectBinWorkspace()
    expect(within(bin()).getByRole('button', { name: `查看已删除任务：${removed.title}` })).toBeInTheDocument()
    expect(within(bin()).queryByText(current.title)).not.toBeInTheDocument()
  })

  it('ignores a bin-list response that arrives after returning to a normal task', async () => {
    const client = createPreviewAssistantClient('bin-list-late'), current = await create(client, '切换回来的正常任务'), removed = await deleted(client, '迟到的回收站任务')
    const originalList = client.list, pending = deferred<{ items: TaskSummary[]; total: number }>()
    const list = vi.spyOn(client, 'list').mockImplementation(query => query?.trashed ? pending.promise : originalList(query))
    await mount(client)
    await enterBin()
    await waitFor(() => expect(list).toHaveBeenCalledWith(expect.objectContaining({ trashed: true })))
    fireEvent.click(screen.getByRole('button', { name: '返回任务列表' }))
    await openTask(current.title)
    fireEvent.change(composer(), { target: { value: '正常任务中刚写的草稿' } })
    await act(async () => pending.resolve({ items: [removed], total: 1 }))
    expect(screen.queryByRole('region', { name: '已删除任务列表' })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: current.title, level: 2 })).toBeInTheDocument()
    expect(composer()).toHaveValue('正常任务中刚写的草稿')
    expect(within(navigation()).queryByText(removed.title)).not.toBeInTheDocument()
  })

  it('ignores a normal-task detail response that arrives after entering the bin', async () => {
    const client = createPreviewAssistantClient('normal-detail-late'), current = await create(client, '正常详情请求'), removed = await deleted(client, '独立回收站任务')
    await mount(client)
    const originalGet = client.get, pending = deferred<AssistantTask>(), row = await originalGet(current.id)
    vi.spyOn(client, 'get').mockImplementation(id => id === current.id ? pending.promise : originalGet(id))
    fireEvent.click(within(navigation()).getByRole('button', { name: `打开任务：${current.title}` }))
    await screen.findByRole('heading', { name: '正在打开任务…', level: 2 })
    await enterBin()
    await within(bin()).findByRole('button', { name: `查看已删除任务：${removed.title}` })
    await act(async () => pending.resolve(row))
    expectBinWorkspace()
    expect(screen.queryByRole('heading', { name: current.title, level: 2 })).not.toBeInTheDocument()
  })

  it('ignores a deleted-task detail response that arrives after returning to a normal task', async () => {
    const client = createPreviewAssistantClient('bin-detail-late'), current = await create(client, '正常工作任务'), removed = await deleted(client, '读取中的删除任务')
    const originalGet = client.get, pending = deferred<AssistantTask>(), row = await originalGet(removed.id)
    vi.spyOn(client, 'get').mockImplementation(id => id === removed.id ? pending.promise : originalGet(id))
    await mount(client)
    await enterBin()
    fireEvent.click(await within(bin()).findByRole('button', { name: `查看已删除任务：${removed.title}` }))
    await screen.findByRole('heading', { name: '正在打开任务…', level: 2 })
    fireEvent.click(screen.getByRole('button', { name: '返回任务列表' }))
    await openTask(current.title)
    fireEvent.change(composer(), { target: { value: '迟到详情不能替换的草稿' } })
    await act(async () => pending.resolve(row))
    expect(screen.getByRole('heading', { name: current.title, level: 2 })).toBeInTheDocument()
    expect(composer()).toHaveValue('迟到详情不能替换的草稿')
    expect(screen.queryByRole('button', { name: '返回回收站列表' })).not.toBeInTheDocument()
  })

  it('does not let a delayed restore clear a normal task opened during restoration', async () => {
    const client = createPreviewAssistantClient('restore-late'), current = await create(client, '恢复时切到的任务'), removed = await deleted(client, '后台恢复的任务')
    const originalRestore = client.restore, pending = deferred<TaskSummary>()
    const restore = vi.spyOn(client, 'restore').mockImplementation(() => pending.promise)
    await mount(client)
    await enterBin()
    fireEvent.click(await within(bin()).findByRole('button', { name: `恢复任务：${removed.title}` }))
    fireEvent.click(within(screen.getByRole('dialog', { name: '恢复任务' })).getByRole('button', { name: '确认恢复' }))
    await waitFor(() => expect(restore).toHaveBeenCalledTimes(1))
    fireEvent.click(within(navigation()).getByRole('button', { name: '任务列表' }))
    await openTask(current.title)
    fireEvent.change(composer(), { target: { value: '恢复完成也要保留这段草稿' } })
    const restored = await originalRestore(removed)
    await act(async () => pending.resolve(restored))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.queryByRole('region', { name: '已删除任务列表' })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: current.title, level: 2 })).toBeInTheDocument()
    expect(composer()).toHaveValue('恢复完成也要保留这段草稿')
    expect(await within(navigation()).findByRole('button', { name: `打开任务：${removed.title}` })).toBeInTheDocument()
    await enterBin()
    await within(bin()).findByText('回收站为空')
  })

  it('retains independent normal-task drafts across a bin visit and remount', async () => {
    const client = createPreviewAssistantClient('draft-roundtrip'), first = await create(client, '独立草稿 A'), next = await create(client, '独立草稿 B')
    await deleted(client, '只读历史任务')
    const view = await mount(client, 'persistent-bin-drafts')
    await openTask(first.title)
    fireEvent.change(composer(), { target: { value: '任务 A 的未发送内容' } })
    await enterBin()
    await within(bin()).findByRole('button', { name: '查看已删除任务：只读历史任务' })
    fireEvent.click(screen.getByRole('button', { name: '返回任务列表' }))
    await openTask(next.title)
    expect(composer()).toHaveValue('')
    fireEvent.change(composer(), { target: { value: '任务 B 的未发送内容' } })
    await openTask(first.title)
    expect(composer()).toHaveValue('任务 A 的未发送内容')
    view.unmount()
    await mount(client, 'persistent-bin-drafts')
    await openTask(next.title)
    expect(composer()).toHaveValue('任务 B 的未发送内容')
    await openTask(first.title)
    expect(composer()).toHaveValue('任务 A 的未发送内容')
  })

  it('returns to a functional normal workspace when creating a task from the bin', async () => {
    const client = createPreviewAssistantClient('create-from-bin'), removed = await deleted(client, '新建前的删除任务')
    const send = vi.spyOn(client, 'send'), createTask = vi.spyOn(client, 'create')
    await mount(client)
    await enterBin()
    await within(bin()).findByRole('button', { name: `查看已删除任务：${removed.title}` })
    fireEvent.click(within(navigation()).getByRole('button', { name: '新对话' }))
    expect(screen.queryByRole('region', { name: '已删除任务列表' })).not.toBeInTheDocument()
    expect(composer()).toHaveFocus()
    expect(createTask).not.toHaveBeenCalled()
    fireEvent.change(composer(), { target: { value: '从回收站开始的新对话' } })
    fireEvent.click(screen.getByRole('button', { name: '发送任务消息' }))
    await screen.findByRole('heading', { name: '从回收站开始的新对话', level: 2 })
    expect(createTask).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ title: '从回收站开始的新对话' }), expect.objectContaining({ question: '从回收站开始的新对话' }))
    await within(screen.getByLabelText('任务对话')).findByRole('button', { name: '查看产物' })
    await enterBin()
    await within(bin()).findByRole('button', { name: `查看已删除任务：${removed.title}` })
    expectBinWorkspace()
  })
})
