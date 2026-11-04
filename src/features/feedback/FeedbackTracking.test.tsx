import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { expect, it, vi } from 'vitest'
import { server } from '../../test/setup'
import FeedbackNotifications from './FeedbackNotifications'
import FeedbackWorkbench from './FeedbackWorkbench'
import type { FeedbackItem, FeedbackWorkbench as WorkbenchData } from './shared'

const reportError = () => '记录读取或保存失败，请重试。'
const notice = { id: 'notice-1', feedback_id: 'issue-1', number: 'FB-0123', permalink: '/feedback?feedback=issue-1', kind: 'reply', body: '修复同事回复了你的反馈', created_at: '2026-11-04T12:00:00Z', read_at: null }
const item: FeedbackItem = { id: 'issue-1', number: 'FB-0123', category: 'bug', description: '知识库显示异常', status: 'in_progress', author_name: '报告人', created_at: '2026-11-04T12:00:00Z', images: [], can_delete: false, assignee_id: 'me', assignee_name: '本人', reply_count: 1 }
const items: FeedbackItem[] = [item, { ...item, id: 'issue-2', number: 'FB-0124', description: '无人处理的逾期事项', assignee_id: null, assignee_name: null, is_overdue: true, reply_count: 0 }, { ...item, id: 'issue-3', number: 'FB-0125', description: '等待提交人验证', status: 'released', assignee_id: 'other' }, { ...item, id: 'closed-mine', number: 'FB-0126', status: 'fixed', description: '已经解决的本人事项' }, { ...item, id: 'closed-unassigned', number: 'FB-0127', status: 'fixed', assignee_id: null, description: '已解决且无负责人旧反馈', reply_count: 0 }]
const workbench: WorkbenchData = { items, metrics: { open: 0, in_progress: 2, ready: 0, released: 1, fixed: 2, overdue: 1, unassigned: 1, mine: 1, unanswered: 1, average_resolution_hours: 6.25 }, by_application: [
  { application: 'kb', total: 2, open: 0, pending: 1, overdue: 1, average_first_response_hours: 1.25, first_response_count: 2, average_resolution_hours: 6.25, resolution_count: 1 },
  { application: null, total: 1, open: 0, pending: 1, overdue: 0, average_first_response_hours: null, first_response_count: 0, average_resolution_hours: null, resolution_count: 0 },
] }

it('marks only the clicked notification as read, updates the badge and opens its feedback', async () => {
  const onOpen = vi.fn(), onCount = vi.fn()
  let requestBody: unknown
  server.use(
    http.get('*/api/v1/feedback/notifications', () => HttpResponse.json({ items: [notice], unread_count: 1 })),
    http.post('*/api/v1/feedback/notifications/read', async ({ request }) => { requestBody = await request.json(); return HttpResponse.json({ items: [{ ...notice, read_at: '2026-11-04T13:00:00Z' }], unread_count: 0 }) }),
  )
  render(<FeedbackNotifications preview={false} onOpen={onOpen} onCount={onCount} onError={reportError} />)
  await userEvent.click(await screen.findByRole('button', { name: /FB-0123.*修复同事回复/ }))
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith('issue-1'))
  expect(requestBody).toEqual({ ids: ['notice-1'] })
  expect(onCount).toHaveBeenLastCalledWith(0)
  expect(screen.getByText('暂无未读通知。')).toBeInTheDocument()
})

it('does not pretend a failed read succeeded while still allowing the feedback to be opened', async () => {
  const onOpen = vi.fn(), onCount = vi.fn()
  server.use(
    http.get('*/api/v1/feedback/notifications', () => HttpResponse.json({ items: [notice], unread_count: 1 })),
    http.post('*/api/v1/feedback/notifications/read', () => HttpResponse.json({ detail: '暂时不可用' }, { status: 503 })),
  )
  render(<FeedbackNotifications preview={false} onOpen={onOpen} onCount={onCount} onError={reportError} />)
  await userEvent.click(await screen.findByRole('button', { name: /FB-0123.*修复同事回复/ }))
  expect(await screen.findByRole('alert')).toHaveTextContent('失败')
  expect(onOpen).toHaveBeenCalledWith('issue-1')
  expect(onCount).toHaveBeenLastCalledWith(1)
  expect(screen.getByText('1 条未读')).toBeInTheDocument()
})

it('uses the authoritative unread count when new notices arrive during a read request', async () => {
  const onCount = vi.fn()
  server.use(
    http.get('*/api/v1/feedback/notifications', () => HttpResponse.json({ items: [notice], unread_count: 1 })),
    http.post('*/api/v1/feedback/notifications/read', () => HttpResponse.json({ items: [
      { ...notice, read_at: '2026-11-04T13:00:00Z' },
      { ...notice, id: 'notice-2', body: '刚收到的认领通知' },
      { ...notice, id: 'notice-3', body: '刚收到的状态通知' },
    ], unread_count: 2 })),
  )
  render(<FeedbackNotifications preview={false} onOpen={vi.fn()} onCount={onCount} onError={reportError} />)
  await userEvent.click(await screen.findByRole('button', { name: /FB-0123.*修复同事回复/ }))
  expect(await screen.findByText('2 条未读')).toBeInTheDocument()
  expect(onCount).toHaveBeenLastCalledWith(2)
  expect(screen.getByText('刚收到的认领通知')).toBeInTheDocument()
  expect(screen.getByText('刚收到的状态通知')).toBeInTheDocument()
  expect(screen.queryByText(notice.body)).not.toBeInTheDocument()
})

it('explicitly marks all personal notices read and distinguishes load errors from an empty inbox', async () => {
  let reads = 0
  let body: unknown
  server.use(
    http.get('*/api/v1/feedback/notifications', () => ++reads === 1 ? HttpResponse.json({ detail: 'unavailable' }, { status: 503 }) : HttpResponse.json({ items: reads > 2 ? [] : [notice], unread_count: reads > 2 ? 0 : 1 })),
    http.post('*/api/v1/feedback/notifications/read', async ({ request }) => { body = await request.json(); return HttpResponse.json({ items: [], unread_count: 0 }) }),
  )
  render(<FeedbackNotifications preview={false} onOpen={vi.fn()} onCount={vi.fn()} onError={reportError} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('失败')
  expect(screen.queryByText('暂无未读通知。')).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '刷新通知' }))
  expect(await screen.findByRole('button', { name: /FB-0123/ })).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '全部标为已读' }))
  expect(await screen.findByText('暂无未读通知。')).toBeInTheDocument()
  expect(body).toEqual({ all: true })
})

it('filters assigned, unassigned, overdue and verification items using server metadata', async () => {
  const onOpen = vi.fn()
  server.use(http.get('*/api/v1/feedback/workbench', () => HttpResponse.json(workbench)))
  render(<FeedbackWorkbench preview={false} previewItems={[]} userId="me" onOpen={onOpen} onError={reportError} />)
  const region = await screen.findByRole('region', { name: '处理工作台' })
  await waitFor(() => expect(within(region).getByText('6.3 小时')).toBeInTheDocument())
  await userEvent.click(within(region).getByRole('button', { name: /我的负责/ }))
  expect(screen.getByText(item.description)).toBeInTheDocument()
  expect(screen.queryByText(items[1].description)).not.toBeInTheDocument()
  expect(screen.queryByText('已经解决的本人事项')).not.toBeInTheDocument()
  await userEvent.click(within(region).getByRole('button', { name: /待分配/ }))
  expect(screen.getByText(items[1].description)).toBeInTheDocument()
  expect(screen.queryByText(item.description)).not.toBeInTheDocument()
  expect(screen.queryByText('已解决且无负责人旧反馈')).not.toBeInTheDocument()
  await userEvent.click(within(region).getByRole('button', { name: '未回复' }))
  expect(screen.getByText(items[1].description)).toBeInTheDocument()
  expect(screen.queryByText(item.description)).not.toBeInTheDocument()
  expect(screen.queryByText('已解决且无负责人旧反馈')).not.toBeInTheDocument()
  await userEvent.click(within(region).getByRole('button', { name: '已逾期' }))
  expect(screen.getByText(items[1].description)).toBeInTheDocument()
  await userEvent.click(within(region).getByRole('button', { name: '待验证' }))
  const target = screen.getByRole('button', { name: /FB-0125.*等待提交人验证/ })
  await userEvent.click(target)
  expect(onOpen).toHaveBeenCalledWith(items[2])
})

it('shows real per-application response and resolution sample sizes and leaves missing history unknown', async () => {
  server.use(http.get('*/api/v1/feedback/workbench', () => HttpResponse.json(workbench)))
  render(<FeedbackWorkbench preview={false} previewItems={[]} userId="me" onOpen={vi.fn()} onError={reportError} />)
  const table = await screen.findByRole('table')
  const kb = within(table).getByRole('row', { name: /知识库/ })
  expect(kb).toHaveTextContent('1.3 小时（2 条）')
  expect(kb).toHaveTextContent('6.3 小时（1 条）')
  const historical = within(table).getByRole('row', { name: /未分类/ })
  expect(within(historical).getAllByText('—')).toHaveLength(2)
  expect(screen.getByText(/历史记录缺少时间时不推算/)).toBeInTheDocument()
})

it('retries a failed workbench request without displaying fabricated zero metrics', async () => {
  let loads = 0
  server.use(http.get('*/api/v1/feedback/workbench', () => ++loads === 1 ? HttpResponse.json({ detail: 'unavailable' }, { status: 503 }) : HttpResponse.json(workbench)))
  render(<FeedbackWorkbench preview={false} previewItems={[]} userId="me" onOpen={vi.fn()} onError={reportError} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('失败')
  expect(screen.queryByText('平均解决用时')).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '重新加载工作台' }))
  expect(await screen.findByText(item.description)).toBeInTheDocument()
})
