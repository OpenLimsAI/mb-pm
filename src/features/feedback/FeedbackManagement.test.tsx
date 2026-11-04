import { useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { beforeEach, expect, it, vi } from 'vitest'
import { server } from '../../test/setup'
import FeedbackManagement from './FeedbackManagement'
import type { FeedbackItem } from './shared'

const original: FeedbackItem = { id: 'issue', category: 'bug', application: 'kb', description: '切换后页面异常', status: 'in_progress', author_name: '报告人', created_at: '2026-11-04T12:00:00Z', images: [], can_delete: false, workflow_version: 2, can_manage: true, can_assign: true, can_verify: false, assignee_id: 'fixer', assignee_name: '修复同事', priority: 'p2', revision: 3 }
const onActivity = vi.fn()
const reportError = () => '保存失败，请重试。'
function mount(initial: FeedbackItem) {
  function Subject() {
    const [item, setItem] = useState(initial)
    return <FeedbackManagement item={item} preview={false} userName="修复同事" onUpdated={setItem} onActivity={onActivity} onError={reportError} />
  }
  render(<Subject />)
}
beforeEach(() => {
  onActivity.mockClear()
  server.use(
    http.get('*/api/v1/feedback/people', () => HttpResponse.json({ items: [{ id: 'fixer', name: '修复同事' }, { id: 'other', name: '另一同事' }] })),
    http.get('*/api/v1/feedback/issue/activities', () => HttpResponse.json({ items: [], next_cursor: null })),
  )
})

it('requires a repair explanation and verification steps, then moves to ready without claiming deployment', async () => {
  const payloads: Record<string, unknown>[] = []
  server.use(http.post('*/api/v1/feedback/issue/transition', async ({ request }) => {
    const body = await request.json() as Record<string, unknown>; payloads.push(body)
    return HttpResponse.json({ feedback: { ...original, status: 'ready', resolution: body.resolution, verification_steps: body.verification_steps }, activity: { id: 'ready-event', kind: 'status', author_name: '修复同事', body: '', from_status: 'in_progress', to_status: 'ready', created_at: '2026-11-04T13:00:00Z' } }, { status: 201 })
  }))
  mount(original)
  await userEvent.click(screen.getByRole('button', { name: '提交修复' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('修复说明和验证步骤')
  expect(payloads).toHaveLength(0)
  await userEvent.type(screen.getByLabelText('修复说明'), '已修复缓存失效。')
  await userEvent.type(screen.getByLabelText('验证步骤'), '切换应用后刷新并核对内容。')
  await userEvent.click(screen.getByRole('button', { name: '提交修复' }))
  expect(await screen.findByRole('button', { name: '登记上线' })).toBeInTheDocument()
  expect(payloads).toHaveLength(1)
  expect(payloads[0]).toMatchObject({ status: 'ready', resolution: '已修复缓存失效。', verification_steps: '切换应用后刷新并核对内容。', request_id: expect.any(String) })
  expect(payloads[0].expected_revision).toBe(3)
  expect(screen.queryByRole('button', { name: '确认已解决' })).not.toBeInTheDocument()
})

it('requires a release version before marking a ready fix as deployed', async () => {
  let sent: Record<string, unknown> | undefined
  const ready = { ...original, status: 'ready' as const, resolution: '修复完成', verification_steps: '按步骤复测' }
  server.use(http.post('*/api/v1/feedback/issue/transition', async ({ request }) => {
    sent = await request.json() as Record<string, unknown>
    return HttpResponse.json({ feedback: { ...ready, status: 'released', release_version: sent.release_version }, activity: { id: 'release-event', kind: 'release', author_name: '修复同事', body: '', from_status: 'ready', to_status: 'released', created_at: '2026-11-04T14:00:00Z' } }, { status: 201 })
  }))
  mount(ready)
  await userEvent.click(screen.getByRole('button', { name: '登记上线' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('发布版本')
  expect(sent).toBeUndefined()
  await userEvent.type(screen.getByLabelText('发布版本'), '2026.11.04-r2')
  await userEvent.click(screen.getByRole('button', { name: '登记上线' }))
  expect(await screen.findByText('已登记上线，等待反馈提交人复测确认。')).toBeInTheDocument()
  expect(sent).toMatchObject({ status: 'released', release_version: '2026.11.04-r2' })
  expect(screen.queryByRole('button', { name: '确认已解决' })).not.toBeInTheDocument()
})

it('allows the reporter to reject a deployed fix only with a reason', async () => {
  let sent: Record<string, unknown> | undefined
  server.use(http.post('*/api/v1/feedback/issue/transition', async ({ request }) => {
    sent = await request.json() as Record<string, unknown>
    return HttpResponse.json({ feedback: { ...original, can_verify: true, can_manage: false }, activity: { id: 'rejected', kind: 'verification', body: sent.note, author_name: '报告人', from_status: 'released', to_status: 'in_progress', created_at: '2026-11-04T15:00:00Z' } }, { status: 201 })
  }))
  mount({ ...original, status: 'released', can_manage: false, can_verify: true })
  await userEvent.click(screen.getByRole('button', { name: '仍有问题' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('验证未通过的原因')
  expect(sent).toBeUndefined()
  await userEvent.type(screen.getByLabelText('验证说明'), '按原步骤切换后仍然为空。')
  await userEvent.click(screen.getByRole('button', { name: '仍有问题' }))
  await waitFor(() => expect(sent).toMatchObject({ status: 'in_progress', note: '按原步骤切换后仍然为空。' }))
  expect(onActivity).toHaveBeenCalledWith(expect.objectContaining({ kind: 'verification', body: '按原步骤切换后仍然为空。' }))
})

it('lets the reporter confirm a deployed fix while keeping the verification note', async () => {
  let sent: Record<string, unknown> | undefined
  server.use(http.post('*/api/v1/feedback/issue/transition', async ({ request }) => {
    sent = await request.json() as Record<string, unknown>
    return HttpResponse.json({ feedback: { ...original, status: 'fixed', can_manage: false, can_verify: true }, activity: { id: 'verified', kind: 'verification', body: sent.note, author_name: '报告人', from_status: 'released', to_status: 'fixed', created_at: '2026-11-04T15:00:00Z' } }, { status: 201 })
  }))
  mount({ ...original, status: 'released', can_manage: false, can_verify: true })
  await userEvent.type(screen.getByLabelText('验证说明'), '已按步骤确认恢复正常。')
  await userEvent.click(screen.getByRole('button', { name: '确认已解决' }))
  await waitFor(() => expect(sent).toMatchObject({ status: 'fixed', note: '已按步骤确认恢复正常。' }))
  expect(onActivity).toHaveBeenCalledWith(expect.objectContaining({ kind: 'verification', to_status: 'fixed' }))
})

it('claims an unassigned issue and saves only explicit management changes', async () => {
  let changes: Record<string, unknown> | undefined
  server.use(
    http.post('*/api/v1/feedback/issue/claim', () => HttpResponse.json(original)),
    http.patch('*/api/v1/feedback/issue/management', async ({ request }) => {
      changes = await request.json() as Record<string, unknown>
      return HttpResponse.json({ ...original, ...changes, assignee_name: changes.assignee_id === 'other' ? '另一同事' : original.assignee_name })
    }),
  )
  mount({ ...original, assignee_id: null, assignee_name: null, can_manage: false })
  await userEvent.click(screen.getByRole('button', { name: '我来处理' }))
  expect(await screen.findByLabelText('优先级')).toBeInTheDocument()
  await userEvent.selectOptions(screen.getByLabelText('优先级'), 'p1')
  await userEvent.selectOptions(screen.getByLabelText('负责人'), 'other')
  fireEvent.change(screen.getByLabelText('计划完成日期'), { target: { value: '2026-11-08' } })
  await userEvent.click(screen.getByRole('button', { name: '保存分派' }))
  await waitFor(() => expect(changes).toMatchObject({ assignee_id: 'other', priority: 'p1' }))
  expect(changes?.expected_revision).toBe(3)
  expect(new Date(String(changes?.due_at)).getDate()).toBe(8)
  expect(changes).not.toHaveProperty('status')
})

it('preserves edited management fields when the server rejects the save', async () => {
  server.use(http.patch('*/api/v1/feedback/issue/management', () => HttpResponse.json({ detail: '冲突' }, { status: 409 })))
  mount(original)
  await userEvent.selectOptions(screen.getByLabelText('优先级'), 'p0')
  await userEvent.click(screen.getByRole('button', { name: '保存分派' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('保存失败')
  expect(screen.getByLabelText('优先级')).toHaveValue('p0')
  expect(screen.getByRole('button', { name: '保存分派' })).toBeEnabled()
})

it('keeps the original transition payload and revision for a retry after metadata refresh', async () => {
  const payloads: Record<string, unknown>[] = []
  server.use(http.post('*/api/v1/feedback/issue/transition', async ({ request }) => {
    payloads.push(await request.json() as Record<string, unknown>)
    return payloads.length === 1 ? HttpResponse.json({ detail: 'lost response' }, { status: 503 }) : HttpResponse.json({ feedback: { ...original, status: 'ready', revision: 5 }, activity: { id: 'once', kind: 'status', body: '', author_name: '修复同事', created_at: '2026-11-04T13:00:00Z' } }, { status: 201 })
  }))
  const props = { preview: false, userName: '修复同事', onUpdated: vi.fn(), onActivity, onError: reportError }
  const subject = render(<FeedbackManagement item={original} {...props} />)
  await userEvent.type(screen.getByLabelText('修复说明'), '修正缓存')
  await userEvent.type(screen.getByLabelText('验证步骤'), '切换页面并验证')
  await userEvent.click(screen.getByRole('button', { name: '提交修复' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('保存失败')
  subject.rerender(<FeedbackManagement item={{ ...original, revision: 4 }} {...props} />)
  await userEvent.click(screen.getByRole('button', { name: '提交修复' }))
  await waitFor(() => expect(payloads).toHaveLength(2))
  expect(payloads[0]).toEqual(payloads[1])
  expect(payloads[1]).toMatchObject({ expected_revision: 3, request_id: expect.any(String) })
})

it('lets a handler cancel their own claim while keeping administrator-only reassignment unavailable', async () => {
  let sent: unknown
  server.use(http.patch('*/api/v1/feedback/issue/management', async ({ request }) => { sent = await request.json(); return HttpResponse.json({ ...original, assignee_id: null, assignee_name: null, can_unclaim: false }) }))
  mount({ ...original, can_assign: false, can_unclaim: true })
  expect(screen.getByLabelText('负责人')).toBeDisabled()
  expect(screen.queryByRole('option', { name: '另一同事' })).not.toBeInTheDocument()
  expect(screen.getByLabelText('优先级')).toBeEnabled()
  await userEvent.click(screen.getByRole('button', { name: '取消我的认领' }))
  await waitFor(() => expect(sent).toEqual({ assignee_id: null, expected_revision: 3 }))
  expect(await screen.findByRole('button', { name: '我来处理' })).toBeInTheDocument()
})

it('does not offer a new claim or reopen to an unrelated viewer of a resolved issue', () => {
  mount({ ...original, status: 'fixed', assignee_id: null, assignee_name: null, can_claim: false, can_assign: false, can_manage: false, can_reopen: false })
  expect(screen.queryByRole('button', { name: '我来处理' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '重新打开' })).not.toBeInTheDocument()
  expect(screen.queryByLabelText('优先级')).not.toBeInTheDocument()
})
