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
  await userEvent.click(await screen.findByRole('button', { name: /回复与进展/ }))
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
  await waitFor(() => expect(screen.getByRole('button', { name: '通知中心' })).toBeInTheDocument())
  completeList?.()
  expect(await screen.findByText('其他列表反馈')).toBeInTheDocument()
  expect(within(dialog).getByText(item.description)).toBeInTheDocument()
  expect(within(dialog).queryByText('迟到列表中的旧版本说明')).not.toBeInTheDocument()
  expect(within(dialog).getByRole('region', { name: '原始反馈' })).toHaveTextContent('处理中')
  const row = screen.getByText(item.description, { selector: 'article > p' }).closest('article')!
  expect(within(row).queryByText('1 条未读')).not.toBeInTheDocument()
})

it('updates same-problem votes and follows only after successful idempotent enabled requests', async () => {
  const requests: unknown[] = []
  server.use(
    http.put('*/api/v1/feedback/issue-canonical/vote', async ({ request }) => { requests.push(await request.json()); return HttpResponse.json({ ...item, vote_count: 3, has_voted: true }) }),
    http.put('*/api/v1/feedback/issue-canonical/follow', async ({ request }) => { requests.push(await request.json()); return HttpResponse.json({ ...item, vote_count: 3, has_voted: true, is_following: true }) }),
  )
  mount()
  await userEvent.click(await screen.findByRole('button', { name: '有同样问题 2' }))
  expect(await screen.findByRole('button', { name: '有同样问题 3', pressed: true })).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '关注反馈' }))
  expect(await screen.findByRole('button', { name: '已关注', pressed: true })).toBeInTheDocument()
  expect(requests).toEqual([{ enabled: true }, { enabled: true }])
  await userEvent.click(screen.getByRole('button', { name: '我关注的' }))
  expect(screen.getByText(item.description)).toBeInTheDocument()
})

it('preserves the impact count when a vote fails', async () => {
  server.use(http.put('*/api/v1/feedback/issue-canonical/vote', () => HttpResponse.json({ detail: '投票暂时无法保存' }, { status: 503 })))
  mount()
  await userEvent.click(await screen.findByRole('button', { name: '有同样问题 2' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('投票暂时无法保存')
  expect(screen.getByRole('button', { name: '有同样问题 2', pressed: false })).toBeEnabled()
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

it('protects unsaved repair notes on close and restores them from the per-feedback draft', async () => {
  mount()
  const dialog = await openDetails()
  await userEvent.type(within(dialog).getByLabelText('修复说明'), '尚未提交的修复解释')
  await userEvent.type(within(dialog).getByLabelText('验证步骤'), '重新选择知识库后检查资料')
  await userEvent.keyboard('{Escape}')
  const confirmation = screen.getByRole('dialog', { name: '放弃未发送的回复？' })
  expect(confirmation).toHaveTextContent('处理说明还未保存')
  await userEvent.click(within(confirmation).getByRole('button', { name: '继续编辑' }))
  expect(screen.getByLabelText('修复说明')).toHaveValue('尚未提交的修复解释')
  await userEvent.keyboard('{Escape}')
  await userEvent.click(screen.getByRole('button', { name: '保留草稿并关闭' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  const saved = vi.mocked(saveDraft).mock.calls.findLast(call => call[0] === 'tenant:reporter' && call[1] === 'reply:' + item.id)
  expect(saved).toBeDefined()
  vi.mocked(loadDraft).mockResolvedValueOnce({ value: saved![2], files: [], savedAt: '2026-11-04T14:00:00Z' })
  const reopened = await openDetails()
  await userEvent.click(await within(reopened).findByRole('button', { name: '恢复草稿' }))
  expect(within(reopened).getByLabelText('修复说明')).toHaveValue('尚未提交的修复解释')
  expect(within(reopened).getByLabelText('验证步骤')).toHaveValue('重新选择知识库后检查资料')
})

it('lets keyboard users tab from the release-version field to its submit action inside the dialog', async () => {
  const ready = { ...item, status: 'ready', resolution: '修复完成', verification_steps: '重复原步骤' }
  server.use(
    http.get('*/api/v1/feedback', () => HttpResponse.json([ready])),
    http.get('*/api/v1/feedback/:id', () => HttpResponse.json(ready)),
    http.post('*/api/v1/feedback/:id/read', () => HttpResponse.json({ ...ready, unread_count: 0 })),
  )
  mount()
  const dialog = await openDetails()
  const version = within(dialog).getByLabelText('发布版本')
  await userEvent.click(version)
  await userEvent.type(version, '2026.11.04')
  await userEvent.tab()
  expect(within(dialog).getByRole('button', { name: '登记上线' })).toHaveFocus()
})
