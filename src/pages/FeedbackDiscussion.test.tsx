import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { afterEach, expect, it, vi } from 'vitest'
import App from '../App'
import { server } from '../test/setup'
import { usePortal } from '../store/portal'

vi.mock('../api/client', async (original) => ({ ...await original<typeof import('../api/client')>(), USE_API: true }))
const item = { application: null as string | null, id: 'issue', category: 'bug', description: '切换页面后内容没有更新', status: 'open', author_name: '提交人', created_at: '2026-11-01T12:00:00Z', images: [], can_delete: true, is_mine: true, reply_count: 0, last_activity_at: '2026-11-01T12:00:00Z' }
const responseActivity = { id: 'reply-1', kind: 'comment', body: '已定位缓存问题，正在处理。', author_name: '修复同事', created_at: '2026-11-04T12:00:00Z', from_status: null, to_status: null }
function mount(items = [item]) {
  server.use(
    http.get('*/api/v1/portal/me', () => HttpResponse.json({ user: { id: 'person', username: 'reader', display_name: '提交人' }, applications: [{ id: 'feedback', enabled: true }] })),
    http.get('*/api/v1/feedback', () => HttpResponse.json(items)),
  )
  window.history.replaceState({}, '', '/feedback')
  render(<App />)
}
afterEach(() => {
  usePortal.setState({ status: 'loading', user: null, identityNamespace: undefined, applications: [], mustChangePassword: false })
  window.history.replaceState({}, '', '/')
})
async function discussion() {
  await userEvent.click(await screen.findByRole('button', { name: /回复与进展/ }))
  const dialog = await screen.findByRole('dialog', { name: '反馈详情' })
  await waitFor(() => expect(within(dialog).getByLabelText('回复内容')).toBeEnabled())
  return dialog
}

it('sends a plain reply without overwriting a newer status and updates the reply count', async () => {
  let payload: Record<string, unknown> = {}
  server.use(
    http.get('*/api/v1/feedback/issue/activities', () => HttpResponse.json({ items: [], next_cursor: null })),
    http.post('*/api/v1/feedback/issue/replies', async ({ request }) => {
      payload = await request.json() as Record<string, unknown>
      return HttpResponse.json({ feedback: { ...item, status: 'in_progress', reply_count: 1, last_activity_at: responseActivity.created_at }, activity: responseActivity }, { status: 201 })
    }),
  )
  mount()
  const dialog = await discussion()
  await userEvent.type(within(dialog).getByLabelText('回复内容'), responseActivity.body)
  await userEvent.click(within(dialog).getByRole('button', { name: '发送回复' }))
  expect(await within(dialog).findByText(responseActivity.body)).toBeInTheDocument()
  expect(payload.body).toBe(responseActivity.body)
  expect(payload).not.toHaveProperty('status')
  expect(payload.request_id).toEqual(expect.any(String))
  expect(within(dialog).getByLabelText('回复内容')).toHaveValue('')
  expect(within(dialog).getByText('修复同事')).toBeInTheDocument()
})

it('lets the fixer explain a resolution and change status in the same reply', async () => {
  let payload: Record<string, unknown> = {}
  const activity = { ...responseActivity, kind: 'status', body: '已修复缓存失效逻辑，并验证切换页面正常。', from_status: 'open', to_status: 'fixed' }
  server.use(
    http.get('*/api/v1/feedback/issue/activities', () => HttpResponse.json({ items: [], next_cursor: null })),
    http.post('*/api/v1/feedback/issue/replies', async ({ request }) => {
      payload = await request.json() as Record<string, unknown>
      return HttpResponse.json({ feedback: { ...item, status: 'fixed', reply_count: 1 }, activity }, { status: 201 })
    }),
  )
  mount()
  const dialog = await discussion()
  await userEvent.type(within(dialog).getByLabelText('回复内容'), activity.body)
  await userEvent.selectOptions(within(dialog).getByLabelText('处理状态'), 'fixed')
  await userEvent.click(within(dialog).getByRole('button', { name: '发送回复' }))
  expect(await within(dialog).findByText(activity.body)).toBeInTheDocument()
  expect(payload.status).toBe('fixed')
  expect(within(dialog).getByText('修复同事')).toBeInTheDocument()
})

it('keeps a failed reply and reuses its request key when retrying unchanged content', async () => {
  const requests: Record<string, unknown>[] = []
  server.use(
    http.get('*/api/v1/feedback/issue/activities', () => HttpResponse.json({ items: [], next_cursor: null })),
    http.post('*/api/v1/feedback/issue/replies', async ({ request }) => {
      requests.push(await request.json() as Record<string, unknown>)
      return requests.length === 1 ? HttpResponse.json({ detail: '网络异常，请重试' }, { status: 503 }) : HttpResponse.json({ feedback: { ...item, reply_count: 1 }, activity: responseActivity }, { status: 201 })
    }),
  )
  mount()
  const dialog = await discussion()
  await userEvent.type(within(dialog).getByLabelText('回复内容'), responseActivity.body)
  await userEvent.click(within(dialog).getByRole('button', { name: '发送回复' }))
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('网络异常')
  expect(within(dialog).getByLabelText('回复内容')).toHaveValue(responseActivity.body)
  await userEvent.click(within(dialog).getByRole('button', { name: '发送回复' }))
  expect(await within(dialog).findByText(responseActivity.body)).toBeInTheDocument()
  expect(requests).toHaveLength(2)
  expect(requests[0].request_id).toBeTruthy()
  expect(requests[0].request_id).toBe(requests[1].request_id)
})

it('shows a failed history load, prevents blind submission and allows retry', async () => {
  let loads = 0
  server.use(http.get('*/api/v1/feedback/issue/activities', () => ++loads === 1 ? HttpResponse.json({ detail: '记录读取失败' }, { status: 503 }) : HttpResponse.json({ items: [responseActivity], next_cursor: null })))
  mount()
  await userEvent.click(await screen.findByRole('button', { name: /回复与进展/ }))
  const dialog = await screen.findByRole('dialog', { name: '反馈详情' })
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('记录读取失败')
  expect(within(dialog).getByRole('button', { name: '发送回复' })).toBeDisabled()
  await userEvent.click(within(dialog).getByRole('button', { name: /重试|重新加载/ }))
  expect(await within(dialog).findByText(responseActivity.body)).toBeInTheDocument()
})

it('protects the unsent reply and returns focus after explicit discard', async () => {
  server.use(http.get('*/api/v1/feedback/issue/activities', () => HttpResponse.json({ items: [], next_cursor: null })))
  mount()
  const dialog = await discussion()
  await userEvent.type(within(dialog).getByLabelText('回复内容'), '还需要补充的操作步骤')
  await userEvent.keyboard('{Escape}')
  expect(within(dialog).getByRole('heading', { name: '放弃未发送的回复？' })).toBeInTheDocument()
  await userEvent.click(within(dialog).getByRole('button', { name: '继续编辑' }))
  expect(within(dialog).getByLabelText('回复内容')).toHaveValue('还需要补充的操作步骤')
  await userEvent.keyboard('{Escape}')
  await userEvent.click(within(dialog).getByRole('button', { name: /放弃并关闭/ }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(screen.getByRole('button', { name: /回复与进展/ })).toHaveFocus()
})

it('loads earlier activity without losing the recent replies', async () => {
  const older = { ...responseActivity, id: 'older', body: '请补充复现步骤', created_at: '2026-11-02T12:00:00Z' }
  server.use(http.get('*/api/v1/feedback/issue/activities', ({ request }) => HttpResponse.json(new URL(request.url).searchParams.has('before') ? { items: [older], next_cursor: null } : { items: [responseActivity], next_cursor: 'reply-1' })))
  mount()
  const dialog = await discussion()
  expect(await within(dialog).findByText(responseActivity.body)).toBeInTheDocument()
  await userEvent.click(within(dialog).getByRole('button', { name: /加载更早/ }))
  expect(await within(dialog).findByText(older.body)).toBeInTheDocument()
  expect(within(dialog).getByText(responseActivity.body)).toBeInTheDocument()
})

it('replays the original reply and state payload after refreshing ambiguous network results', async () => {
  const requests: Record<string, unknown>[] = []
  let reads = 0
  const activity = { ...responseActivity, kind: 'status', from_status: 'open', to_status: 'fixed' }
  const fixed = { ...item, status: 'fixed', reply_count: 1 }
  server.use(
    http.get('*/api/v1/feedback/issue/activities', () => HttpResponse.json(++reads === 1 ? { items: [], next_cursor: null, feedback: item } : { items: [activity], next_cursor: null, feedback: fixed })),
    http.post('*/api/v1/feedback/issue/replies', async ({ request }) => {
      requests.push(await request.json() as Record<string, unknown>)
      return requests.length === 1 ? HttpResponse.json({ detail: '响应中断，请确认结果后重试' }, { status: 503 }) : HttpResponse.json({ feedback: fixed, activity }, { status: 201 })
    }),
  )
  mount()
  const dialog = await discussion()
  await userEvent.type(within(dialog).getByLabelText('回复内容'), activity.body)
  await userEvent.selectOptions(within(dialog).getByLabelText('处理状态'), 'fixed')
  await userEvent.click(within(dialog).getByRole('button', { name: '发送回复' }))
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('响应中断')
  await userEvent.click(within(dialog).getByRole('button', { name: '刷新处理记录' }))
  expect(await within(within(dialog).getByRole('region', { name: '处理记录' })).findByText(activity.body)).toBeInTheDocument()
  expect(within(dialog).getByLabelText('回复内容')).toHaveValue(activity.body)
  await waitFor(() => expect(within(dialog).getByRole('button', { name: '发送回复' })).toBeEnabled())
  await userEvent.click(within(dialog).getByRole('button', { name: '发送回复' }))
  await waitFor(() => expect(within(dialog).getByLabelText('回复内容')).toHaveValue(''))
  expect(requests).toHaveLength(2)
  expect(requests[0]).toEqual(requests[1])
  expect(requests[1].status).toBe('fixed')
  expect(within(dialog).getAllByText(activity.body)).toHaveLength(1)
})

it('filters by server ownership and reply count, sorts activity, and counts processing separately', async () => {
  const own = { ...item, id: 'own', description: '我提交的反馈', status: 'in_progress', reply_count: 2, last_activity_at: '2026-11-04T12:00:00Z' }
  const other = { ...item, id: 'other', description: '其他人的未回复反馈', is_mine: false, can_delete: true, created_at: '2026-11-02T12:00:00Z' }
  mount([own, other])
  expect(await screen.findByText(own.description)).toBeInTheDocument()
  expect(screen.getAllByRole('article')[0]).toHaveTextContent(other.description)
  const summary = screen.getByRole('region', { name: '反馈概况' })
  const processing = within(summary).getByText('处理中').parentElement!
  const resolved = within(summary).getByText('已修复').parentElement!
  expect(processing).toHaveTextContent('1')
  expect(resolved).toHaveTextContent('0')
  await userEvent.selectOptions(screen.getByLabelText('反馈排序'), 'active')
  expect(screen.getAllByRole('article')[0]).toHaveTextContent(own.description)
  await userEvent.click(screen.getByRole('button', { name: '我的反馈' }))
  expect(screen.queryByText(other.description)).not.toBeInTheDocument()
  expect(screen.getByText(own.description)).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '未回复' }))
  expect(screen.queryByText(own.description)).not.toBeInTheDocument()
  expect(screen.getByText(other.description)).toBeInTheDocument()
})


it('filters feedback by application and keeps historical unclassified entries distinct', async () => {
  const kb = { ...item, id: 'kb', application: 'kb', description: '知识库问答异常' }
  const legacy = { ...item, id: 'legacy', description: '历史未填写应用的反馈' }
  mount([kb, legacy])
  expect(await screen.findByText(kb.description)).toBeInTheDocument()
  await userEvent.selectOptions(screen.getByLabelText('应用筛选'), 'kb')
  expect(screen.getByText(kb.description)).toBeInTheDocument()
  expect(screen.queryByText(legacy.description)).not.toBeInTheDocument()
  await userEvent.selectOptions(screen.getByLabelText('应用筛选'), 'unclassified')
  expect(screen.queryByText(kb.description)).not.toBeInTheDocument()
  const row = screen.getByText(legacy.description).closest('article')!
  expect(within(row).getByText('未分类')).toBeInTheDocument()
})
