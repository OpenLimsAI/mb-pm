import { useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { beforeEach, expect, it, vi } from 'vitest'
import { server } from '../../test/setup'
import FeedbackManagement from './FeedbackManagement'
import type { FeedbackItem } from './shared'

const original: FeedbackItem = { id: 'issue', category: 'bug', application: 'kb', description: '切换后页面异常', status: 'open', author_name: '报告人', created_at: '2026-11-04T12:00:00Z', images: [], can_delete: false, is_mine: false, workflow_version: 2, can_manage: false, can_assign: false, can_verify: false, assignee_id: 'someone-else', assignee_name: '另一位同事', priority: 'p2', revision: 3 }
const onActivity = vi.fn()
const reportError = () => '保存失败，请重试。'
function mount(initial = original) {
  function Subject() {
    const [item, setItem] = useState(initial)
    return <FeedbackManagement item={item} preview={false} userName="普通成员" onUpdated={setItem} onActivity={onActivity} onError={reportError} />
  }
  render(<Subject />)
}
beforeEach(() => {
  onActivity.mockClear()
  server.use(http.get('*/api/v1/feedback/issue/activities', () => HttpResponse.json({ items: [], next_cursor: null })))
})

it('lets an ordinary member mark another person’s issue fixed in one click without claiming or verification', async () => {
  let sent: Record<string, unknown> | undefined
  server.use(http.patch('*/api/v1/feedback/issue', async ({ request }) => {
    sent = await request.json() as Record<string, unknown>
    return HttpResponse.json({ ...original, status: 'fixed', revision: 4 })
  }))
  mount()
  await userEvent.click(screen.getByRole('button', { name: '标记已修复' }))
  expect(await screen.findByRole('button', { name: '重新打开' })).toBeInTheDocument()
  expect(sent).toMatchObject({ status: 'fixed' })
  for (const key of ['verification_steps', 'release_version', 'resolution']) expect(sent).not.toHaveProperty(key)
  expect(screen.queryByRole('button', { name: '确认已解决' })).not.toBeInTheDocument()
})

it('does not expose the retired assignment, release or reporter verification workflow', () => {
  mount()
  for (const name of ['我来处理', '开始处理', '保存分派', '提交修复', '登记上线', '确认已解决', '取消我的认领', '催办']) {
    expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
  }
  for (const name of ['负责人', '优先级', '计划完成日期', '修复说明', '验证步骤', '发布版本', '验证说明']) {
    expect(screen.queryByLabelText(name)).not.toBeInTheDocument()
  }
  expect(screen.getByRole('button', { name: '标记已修复' })).toBeEnabled()
})

it.each(['ready', 'released'] as const)('shows historical %s as repaired and lets any member reopen it without a reason', async status => {
  let sent: Record<string, unknown> | undefined
  server.use(http.patch('*/api/v1/feedback/issue', async ({ request }) => {
    sent = await request.json() as Record<string, unknown>
    return HttpResponse.json({ ...original, status: 'open', revision: 4 })
  }))
  mount({ ...original, status, resolution: '之前保存的处理说明', verification_steps: '历史验证步骤', release_version: '旧版本' })
  expect(screen.getByRole('button', { name: '重新打开' })).toBeEnabled()
  expect(screen.queryByRole('button', { name: '登记上线' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '确认已解决' })).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '重新打开' }))
  expect(await screen.findByRole('button', { name: '标记已修复' })).toBeInTheDocument()
  expect(sent).toMatchObject({ status: 'open' })
  expect(sent?.note || '').toBe('')
})

it('keeps historical processing feedback pending and permits direct completion', async () => {
  server.use(http.patch('*/api/v1/feedback/issue', () => HttpResponse.json({ ...original, status: 'fixed' })))
  mount({ ...original, status: 'in_progress' })
  await userEvent.click(screen.getByRole('button', { name: '标记已修复' }))
  expect(await screen.findByRole('button', { name: '重新打开' })).toBeInTheDocument()
})

it('keeps the original state after a failed update and allows an unchanged retry', async () => {
  const requests: unknown[] = []
  server.use(http.patch('*/api/v1/feedback/issue', async ({ request }) => {
    requests.push(await request.json())
    return requests.length === 1 ? HttpResponse.json({ detail: '保存失败' }, { status: 503 }) : HttpResponse.json({ ...original, status: 'fixed' })
  }))
  mount()
  await userEvent.click(screen.getByRole('button', { name: '标记已修复' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('保存失败')
  expect(screen.getByRole('button', { name: '标记已修复' })).toBeEnabled()
  expect(screen.queryByRole('button', { name: '重新打开' })).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '标记已修复' }))
  expect(await screen.findByRole('button', { name: '重新打开' })).toBeInTheDocument()
  expect(requests).toEqual([{ status: 'fixed' }, { status: 'fixed' }])
})

it('locks a pending status update against repeated clicks', async () => {
  let release: (() => void) | undefined
  let saves = 0
  server.use(http.patch('*/api/v1/feedback/issue', async () => {
    saves++
    await new Promise<void>(resolve => { release = resolve })
    return HttpResponse.json({ ...original, status: 'fixed' })
  }))
  mount()
  const button = screen.getByRole('button', { name: '标记已修复' })
  fireEvent.click(button); fireEvent.click(button)
  await waitFor(() => expect(saves).toBe(1))
  expect(button).toBeDisabled()
  release?.()
  expect(await screen.findByRole('button', { name: '重新打开' })).toBeInTheDocument()
})
