import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import App from '../App'
import { server } from '../test/setup'
import { usePortal } from '../store/portal'
import { loadDraft, saveDraft } from '../features/feedback/drafts'
import type { FeedbackActivity, FeedbackItem } from '../features/feedback/shared'

vi.mock('../api/client', async original => ({ ...await original<typeof import('../api/client')>(), USE_API: true }))
vi.mock('../features/feedback/drafts', () => ({ loadDraft: vi.fn(async () => null), saveDraft: vi.fn(async () => true), deleteDraft: vi.fn(async () => {}) }))
const viewer = { id: 'reporter', username: 'reporter', display_name: '报告人' }
const item: FeedbackItem = { id: 'issue-canonical', number: 'FB-0123', issue_number: 123, revision: 4, workflow_version: 2, application: 'kb', category: 'bug', description: '切换知识库后未显示新内容', status: 'in_progress', author_name: '报告人', created_at: '2026-11-04T12:00:00Z', images: [], can_delete: true, can_edit: true, can_manage: true, is_mine: true, assignee_id: 'reporter', assignee_name: '报告人', reply_count: 0, has_voted: false, vote_count: 2, is_following: false, unread_count: 1 }
const NativeURL = URL
beforeEach(() => {
  vi.mocked(loadDraft).mockReset().mockResolvedValue(null)
  vi.mocked(saveDraft).mockClear()
  vi.stubGlobal('URL', class extends NativeURL { static createObjectURL() { return 'blob:reply-image' } static revokeObjectURL() {} })
  server.use(
    http.get('*/api/v1/portal/me', () => HttpResponse.json({ user: viewer, identity_namespace: 'tenant:reporter', applications: [{ id: 'feedback', enabled: true }] })),
    http.get('*/api/v1/feedback/people', () => HttpResponse.json({ items: [] })),
    http.get('*/api/v1/feedback', () => HttpResponse.json([item])),
    http.get('*/api/v1/feedback/:id/activities', () => HttpResponse.json({ items: [], next_cursor: null })),
    http.get('*/api/v1/feedback/:id', () => HttpResponse.json(item)),
    http.post('*/api/v1/feedback/:id/read', () => HttpResponse.json({ ...item, unread_count: 0 })),
  )
})
afterEach(() => {
  usePortal.setState({ status: 'loading', user: null, identityNamespace: undefined, applications: [], mustChangePassword: false })
  window.history.replaceState({}, '', '/')
  vi.unstubAllGlobals()
})
function mount(search = '') { window.history.replaceState({}, '', '/feedback' + search); render(<App />) }
async function openDetails() {
  await userEvent.click(await screen.findByRole('button', { name: /^回复/ }))
  const dialog = await screen.findByRole('dialog', { name: '反馈详情' })
  await waitFor(() => expect(within(dialog).getByLabelText('回复内容')).toBeEnabled())
  return dialog
}

it('opens a numbered deep link whose canonical feedback is absent from the initial list', async () => {
  server.use(http.get('*/api/v1/feedback', () => HttpResponse.json([])))
  // Notifications are independent of whether a deep-linked issue is already listed.
  server.use(http.get('*/api/v1/feedback/notifications', () => HttpResponse.json({ items: [], unread_count: 0 })))
  mount('?feedback=FB-0123&tab=notifications')
  const dialog = await screen.findByRole('dialog', { name: '反馈详情' })
  expect(within(dialog).getByText('FB-0123')).toBeInTheDocument()
  expect(within(dialog).getByRole('link', { name: '反馈链接' })).toHaveAttribute('href', '/feedback?feedback=issue-canonical')
  expect(within(dialog).getByText(item.description)).toBeInTheDocument()
  await userEvent.click(within(dialog).getByRole('button', { name: '关闭详情' }))
  expect(new URLSearchParams(window.location.search).get('feedback')).toBeNull()
  expect(new URLSearchParams(window.location.search).get('tab')).toBe('notifications')
})

it('keeps a freshly loaded deep link and read state when an older list snapshot arrives later', async () => {
  let completeList: (() => void) | undefined
  server.use(http.get('*/api/v1/feedback', async () => {
    await new Promise<void>(resolve => { completeList = resolve })
    return HttpResponse.json([
      { ...item, revision: 3, status: 'open', description: '迟到列表中的旧版本说明', unread_count: 1 },
      { ...item, id: 'list-sentinel', description: '其他列表反馈', number: 'FB-0124' },
    ])
  }))
  mount('?feedback=FB-0123')
  const dialog = await screen.findByRole('dialog', { name: '反馈详情' })
  expect(within(dialog).getByText(item.description)).toBeInTheDocument()
  await waitFor(() => expect(screen.getByRole('button', { name: '通知' })).toBeInTheDocument())
  completeList?.()
  expect(await screen.findByText('其他列表反馈')).toBeInTheDocument()
  expect(within(dialog).getByText(item.description)).toBeInTheDocument()
  expect(within(dialog).queryByText('迟到列表中的旧版本说明')).not.toBeInTheDocument()
  expect(within(dialog).getByRole('region', { name: '原始反馈' })).toHaveTextContent('待处理')
  const row = screen.getByText(item.description, { selector: 'article > p' }).closest('article')!
  expect(within(row).queryByText('1 条未读')).not.toBeInTheDocument()
})

it('lets a colleague repair and reopen a listed issue without a management role or opening details', async () => {
  const requests: unknown[] = []
  const ordinary = { ...item, can_manage: false, can_edit: false, can_delete: false, is_mine: false }
  server.use(
    http.get('*/api/v1/feedback', () => HttpResponse.json([ordinary])),
    http.patch('*/api/v1/feedback/issue-canonical', async ({ request }) => {
      const payload = await request.json() as { status: string }; requests.push(payload)
      return HttpResponse.json({ ...ordinary, status: payload.status, revision: requests.length + 4 })
    }),
  )
  mount()
  await userEvent.click(await screen.findByRole('button', { name: '标记已修复' }))
  expect(await screen.findByRole('button', { name: '重新打开' })).toBeInTheDocument()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '删除反馈' })).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '重新打开' }))
  expect(await screen.findByRole('button', { name: '标记已修复' })).toBeInTheDocument()
  expect(requests).toEqual([{ status: 'fixed' }, { status: 'open' }])
})

it('keeps failed one-click updates visible and retryable without claiming the issue is repaired', async () => {
  server.use(http.patch('*/api/v1/feedback/issue-canonical', () => HttpResponse.json({ detail: '修复状态暂时无法保存' }, { status: 503 })))
  mount()
  await userEvent.click(await screen.findByRole('button', { name: '标记已修复' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('暂时无法保存')
  expect(screen.getByRole('button', { name: '标记已修复' })).toBeEnabled()
  expect(screen.queryByRole('button', { name: '重新打开' })).not.toBeInTheDocument()
})

it('prevents an independent status change while history or a reply is still being saved', async () => {
  let releaseHistory: (() => void) | undefined
  let releaseReply: (() => void) | undefined
  let replies = 0
  let statusRequests = 0
  server.use(
    http.get('*/api/v1/feedback/:id/activities', async () => {
      await new Promise<void>(resolve => { releaseHistory = resolve })
      return HttpResponse.json({ items: [], next_cursor: null })
    }),
    http.post('*/api/v1/feedback/:id/replies', async () => {
      replies++
      await new Promise<void>(resolve => { releaseReply = resolve })
      return HttpResponse.json({ feedback: { ...item, reply_count: 1, revision: 5 }, activity: { id: 'comment-after-load', kind: 'comment', body: '正在补充问题说明', author_name: '报告人', created_at: item.created_at } }, { status: 201 })
    }),
    http.patch('*/api/v1/feedback/issue-canonical', () => { statusRequests++; return HttpResponse.json({ ...item, status: 'fixed', revision: 6 }) }),
  )
  mount()
  const dialog = await openDetails()
  const repair = within(dialog).getByRole('button', { name: '标记已修复' })
  expect(repair).toBeDisabled()
  await waitFor(() => expect(releaseHistory).toBeTypeOf('function'))
  releaseHistory?.()
  await waitFor(() => expect(repair).toBeEnabled())
  await userEvent.type(within(dialog).getByLabelText('回复内容'), '正在补充问题说明')
  await userEvent.click(within(dialog).getByRole('button', { name: '发送回复' }))
  await waitFor(() => expect(replies).toBe(1))
  expect(repair).toBeDisabled()
  await userEvent.click(repair)
  expect(statusRequests).toBe(0)
  releaseReply?.()
  expect(await within(dialog).findByText('回复已发送。')).toBeInTheDocument()
  expect(repair).toBeEnabled()
})

it('opens notification feedback outside the loaded list and clears only the authenticated notification', async () => {
  let marked: unknown
  server.use(
    http.get('*/api/v1/feedback', () => HttpResponse.json([])),
    http.get('*/api/v1/feedback/notifications', () => HttpResponse.json({ items: [{ id: 'notice-1', feedback_id: item.id, number: item.number, permalink: '/feedback?feedback=' + item.id, body: '修复已经上线，请验证', kind: 'status', created_at: item.created_at, read_at: null }], unread_count: 1 })),
    http.post('*/api/v1/feedback/notifications/read', async ({ request }) => { marked = await request.json(); return HttpResponse.json({ items: [], unread_count: 0 }) }),
  )
  mount('?tab=notifications')
  await userEvent.click(await screen.findByRole('button', { name: /FB-0123.*修复已经上线/ }))
  const dialog = await screen.findByRole('dialog', { name: '反馈详情' })
  expect(within(dialog).getByText(item.description)).toBeInTheDocument()
  expect(marked).toEqual({ ids: ['notice-1'] })
  await userEvent.click(within(dialog).getByRole('button', { name: '关闭详情' }))
  expect(screen.getByText('暂无未读通知。')).toBeInTheDocument()
  expect(screen.getByText('0 条未读')).toBeInTheDocument()
})

it('keeps original and edited text plus archived screenshot links visible in edit history', async () => {
  const event: FeedbackActivity = { id: 'edit-1', kind: 'edit', body: '原反馈内容和图片已编辑', author_name: '报告人', created_at: '2026-11-04T13:00:00Z', details: { before: { description: '修改前的问题说明', images: ['archived-original'] }, after: { description: '修改后的复现说明', images: ['current-image'] } } }
  server.use(http.get('*/api/v1/feedback/:id/activities', () => HttpResponse.json({ items: [event], next_cursor: null })))
  mount()
  const dialog = await openDetails()
  await userEvent.click(within(dialog).getByText('查看编辑前后内容'))
  expect(within(dialog).getByText('修改前的问题说明')).toBeVisible()
  expect(within(dialog).getByText('修改后的复现说明')).toBeVisible()
  expect(within(dialog).getAllByRole('link', { name: '查看历史图片 1' }).map(element => element.getAttribute('href'))).toEqual(['/api/v1/feedback/images/archived-original', '/api/v1/feedback/images/current-image'])
})

it('retries a reply with screenshots using the same key and retains the attachment until success', async () => {
  const requests: string[] = []
  server.use(http.post('*/api/v1/feedback/issue-canonical/replies-with-images', async ({ request }) => {
    requests.push(await request.text())
    return requests.length === 1 ? HttpResponse.json({ detail: '图片回复暂时发送失败' }, { status: 503 }) : HttpResponse.json({ feedback: { ...item, reply_count: 1, revision: 5 }, activity: { id: 'reply-image', kind: 'comment', body: '补充异常画面的截图', author_name: '报告人', created_at: '2026-11-04T14:00:00Z', images: ['reply-image-1'] } }, { status: 201 })
  }))
  mount()
  const dialog = await openDetails()
  await userEvent.type(within(dialog).getByLabelText('回复内容'), '补充异常画面的截图')
  await userEvent.upload(within(dialog).getByLabelText('添加回复图片'), new File(['pixels'], 'reply.png', { type: 'image/png' }))
  await userEvent.click(within(dialog).getByRole('button', { name: '发送回复' }))
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('暂时发送失败')
  expect(within(dialog).getByRole('img', { name: '回复待发送图片 reply.png' })).toBeInTheDocument()
  await userEvent.click(within(dialog).getByRole('button', { name: '发送回复' }))
  expect(await within(dialog).findByRole('img', { name: '回复图片 1' })).toHaveAttribute('src', '/api/v1/feedback/images/reply-image-1')
  expect(within(dialog).getByLabelText('回复内容')).toHaveValue('')
  expect(within(dialog).queryByRole('img', { name: '回复待发送图片 reply.png' })).not.toBeInTheDocument()
  const keys = requests.map(body => body.match(/name="request_id"\r\n\r\n([^\r]+)/)?.[1])
  expect(keys[0]).toBeTruthy()
  expect(keys[0]).toBe(keys[1])
  expect(requests.every(body => body.includes('name="images"') && body.includes('补充异常画面的截图'))).toBe(true)
})

it('does not reuse an ambiguous reply key after the user replaces its screenshot', async () => {
  const keys: string[] = []
  server.use(http.post('*/api/v1/feedback/issue-canonical/replies-with-images', async ({ request }) => {
    const body = await request.text(); keys.push(body.match(/name="request_id"\r\n\r\n([^\r]+)/)?.[1] || '')
    return HttpResponse.json({ detail: '暂时无法发送回复' }, { status: 503 })
  }))
  mount()
  const dialog = await openDetails()
  await userEvent.type(within(dialog).getByLabelText('回复内容'), '更新截图')
  await userEvent.upload(within(dialog).getByLabelText('添加回复图片'), new File(['a'], 'same.png', { type: 'image/png', lastModified: 123 }))
  await userEvent.click(within(dialog).getByRole('button', { name: '发送回复' }))
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('暂时无法发送')
  await userEvent.click(within(dialog).getByRole('button', { name: '移除回复图片 same.png' }))
  await userEvent.upload(within(dialog).getByLabelText('添加回复图片'), new File(['b'], 'same.png', { type: 'image/png', lastModified: 123 }))
  await userEvent.click(within(dialog).getByRole('button', { name: '发送回复' }))
  await waitFor(() => expect(keys).toHaveLength(2))
  expect(keys[0]).toBeTruthy()
  expect(keys[1]).not.toBe(keys[0])
})

it('remounts draft-bearing UI when the verified identity changes and never saves the previous text for the new identity', async () => {
  mount('?compose=1')
  const first = await screen.findByRole('dialog', { name: '提交反馈' })
  await userEvent.selectOptions(within(first).getByLabelText(/所属应用/), 'kb')
  await userEvent.type(within(first).getByLabelText(/问题或建议/), '仅限原账号的草稿内容')
  await waitFor(() => expect(saveDraft).toHaveBeenCalledWith('tenant:reporter', 'compose', expect.objectContaining({ description: '仅限原账号的草稿内容' }), []))
  act(() => usePortal.setState({ identityNamespace: 'tenant:second', user: { id: 'second', username: 'second', displayName: '新账号' } }))
  const second = await screen.findByRole('dialog', { name: '提交反馈' })
  expect(within(second).getByLabelText(/问题或建议/)).toHaveValue('')
  await userEvent.selectOptions(within(second).getByLabelText(/所属应用/), 'pm')
  await userEvent.type(within(second).getByLabelText(/问题或建议/), '新账号的独立草稿')
  await waitFor(() => expect(saveDraft).toHaveBeenCalledWith('tenant:second', 'compose', expect.objectContaining({ description: '新账号的独立草稿' }), []))
  expect(vi.mocked(saveDraft).mock.calls.filter(call => call[0] === 'tenant:second').every(call => !JSON.stringify(call[2]).includes('仅限原账号'))).toBe(true)
})

it('recovers text from the retired management draft without bringing back mandatory verification', async () => {
  vi.mocked(loadDraft).mockResolvedValue({ value: { body: '还未发出的补充回复', statusChoice: '', management: { changes: {}, resolution: '历史草稿里的修复说明', verification: '旧验证步骤', version: '旧版本', note: '原备注' } }, files: [], savedAt: '2026-11-04T14:00:00Z' })
  mount()
  const dialog = await openDetails()
  await userEvent.click(await within(dialog).findByRole('button', { name: '恢复草稿' }))
  expect(within(dialog).getByLabelText('回复内容')).toHaveValue('还未发出的补充回复')
  await userEvent.click(within(dialog).getByText('之前保存的补充说明'))
  expect(within(dialog).getByText('历史草稿里的修复说明', { exact: false })).toBeVisible()
  expect(within(dialog).queryByLabelText('验证步骤')).not.toBeInTheDocument()
  expect(within(dialog).queryByLabelText('发布版本')).not.toBeInTheDocument()
  expect(within(dialog).getByRole('button', { name: '标记已修复' })).toBeEnabled()
})

it('shows old repaired states as fixed and retains the keyboard-accessible reopen action', async () => {
  const ready = { ...item, status: 'ready', resolution: '修复完成', verification_steps: '重复原步骤' }
  server.use(
    http.get('*/api/v1/feedback', () => HttpResponse.json([ready])),
    http.get('*/api/v1/feedback/:id', () => HttpResponse.json(ready)),
    http.post('*/api/v1/feedback/:id/read', () => HttpResponse.json({ ...ready, unread_count: 0 })),
  )
  mount()
  const dialog = await openDetails()
  const status = within(dialog).getByRole('region', { name: '反馈处理状态' })
  expect(status).toHaveTextContent('已修复')
  const reopen = within(status).getByRole('button', { name: '重新打开' })
  reopen.focus()
  expect(reopen).toHaveFocus()
  expect(within(dialog).queryByRole('button', { name: '登记上线' })).not.toBeInTheDocument()
  expect(within(dialog).queryByRole('button', { name: '确认已解决' })).not.toBeInTheDocument()
})

it('keeps an unsent reply and screenshot when the separate repair button is clicked', async () => {
  server.use(http.patch('*/api/v1/feedback/issue-canonical', () => HttpResponse.json({ ...item, status: 'fixed', revision: 5 })))
  mount()
  const dialog = await openDetails()
  await userEvent.type(within(dialog).getByLabelText('回复内容'), '准备补充的处理说明')
  await userEvent.upload(within(dialog).getByLabelText('添加回复图片'), new File(['pixels'], 'retained.png', { type: 'image/png' }))
  await userEvent.click(within(dialog).getByRole('button', { name: '标记已修复' }))
  expect(await within(dialog).findByRole('button', { name: '重新打开' })).toBeInTheDocument()
  expect(within(dialog).getByLabelText('回复内容')).toHaveValue('准备补充的处理说明')
  expect(within(dialog).getByRole('img', { name: '回复待发送图片 retained.png' })).toBeInTheDocument()
})

it('shows and filters legacy pending and repaired states without exposing deployment or validation controls', async () => {
  server.use(http.get('*/api/v1/feedback', () => HttpResponse.json([
    { ...item, id: 'processing', description: '历史处理中问题', status: 'in_progress' },
    { ...item, id: 'ready', description: '历史待发布问题', status: 'ready' },
    { ...item, id: 'released', description: '历史待验证问题', status: 'released' },
  ])))
  mount()
  const row = (await screen.findByText('历史处理中问题')).closest('article')!
  expect(within(row).getByText('待处理')).toBeInTheDocument()
  expect(within(screen.getByText('历史待发布问题').closest('article')!).getByText('已修复')).toBeInTheDocument()
  expect(within(screen.getByText('历史待验证问题').closest('article')!).getByText('已修复')).toBeInTheDocument()
  await userEvent.selectOptions(screen.getByLabelText('状态'), 'fixed')
  expect(screen.queryByText('历史处理中问题')).not.toBeInTheDocument()
  expect(screen.getAllByRole('button', { name: '重新打开' })).toHaveLength(2)
  expect(screen.queryByRole('button', { name: '处理工作台' })).not.toBeInTheDocument()
  expect(screen.queryByRole('option', { name: /待发布|待验证/ })).not.toBeInTheDocument()
})
