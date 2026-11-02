import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import AssistantOperationsPanel from './AssistantOperationsPanel'
import type { AssistantOperations } from './assistantOperations'

const fixture = (): AssistantOperations => ({ limits: { perUserPending: 3, perUserRunning: 1, globalQueued: 100, retentionDays: 0 }, totals: { queued: 1, running: 2, completed: 7, failed: 2, cancelled: 1 }, windowHours: 24, failureCounts: { model_timeout: 1, output_limit: 1 }, recent: [{ requestId: 'request-1', diagnosticId: 'a'.repeat(32), status: 'failed', stage: 'failed', errorCode: 'model_timeout', createdAt: '2026-11-02T15:00:00Z', startedAt: '2026-11-02T15:00:01Z', finishedAt: '2026-11-02T15:02:01Z', elapsedSeconds: 120, firstContentSeconds: 3.6 }], canManage: true })
const client = (data = fixture()) => ({ get: vi.fn().mockResolvedValue(data), save: vi.fn().mockImplementation(async value => value), prune: vi.fn().mockResolvedValue({ pruned: 2 }) })

it('shows distinct failures and searches diagnostic IDs without exposing request content', async () => {
  const api = client()
  render(<AssistantOperationsPanel client={api} />)
  expect(await screen.findByText('模型超时：1')).toBeVisible()
  expect(screen.getByText('回答达到输出上限：1')).toBeVisible()
  expect(screen.getByText('3.6 秒')).toBeVisible()
  fireEvent.change(screen.getByLabelText('按诊断编号查找'), { target: { value: 'invalid' } })
  fireEvent.click(screen.getByRole('button', { name: '查找' }))
  expect(screen.getByRole('alert')).toHaveTextContent('完整的 32 位诊断编号')
  expect(api.get).toHaveBeenCalledTimes(1)
  fireEvent.change(screen.getByLabelText('按诊断编号查找'), { target: { value: 'a'.repeat(32) } })
  fireEvent.click(screen.getByRole('button', { name: '查找' }))
  await waitFor(() => expect(api.get).toHaveBeenLastCalledWith('a'.repeat(32)))
})

it('hides operations from a user without live administrator access', async () => {
  const api = client()
  api.get.mockRejectedValue({ isAxiosError: true, response: { status: 403 } })
  const { container } = render(<AssistantOperationsPanel client={api} />)
  await waitFor(() => expect(container).toBeEmptyDOMElement())
  expect(api.save).not.toHaveBeenCalled()
})

it('requires an explicit prune confirmation and leaves pruning disabled by default', async () => {
  const api = client()
  const { unmount } = render(<AssistantOperationsPanel client={api} />)
  await screen.findByText('模型超时：1')
  expect(screen.getByRole('button', { name: '清理过期请求内容', hidden: true })).toBeDisabled()
  expect(api.prune).not.toHaveBeenCalled()
  unmount()
  const configured = fixture(); configured.limits.retentionDays = 30
  const next = client(configured)
  render(<AssistantOperationsPanel client={next} />)
  await screen.findByText('模型超时：1')
  fireEvent.click(screen.getByText('队列与记录保留设置'))
  fireEvent.click(screen.getByRole('button', { name: '清理过期请求内容' }))
  expect(next.prune).not.toHaveBeenCalled()
  expect(screen.getByText(/已结束超过 30 天/)).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: '确认清理' }))
  await screen.findByText('已清理 2 条过期请求的重复内容，任务与正式回答仍保留。')
  expect(next.prune).toHaveBeenCalledTimes(1)
})

it('saves bounded queue settings independently of model configuration', async () => {
  const api = client()
  render(<AssistantOperationsPanel client={api} />)
  await screen.findByText('模型超时：1')
  fireEvent.click(screen.getByText('队列与记录保留设置'))
  fireEvent.change(screen.getByLabelText('每人等待及生成中的问题上限'), { target: { value: 4 } })
  fireEvent.click(screen.getByRole('button', { name: '保存运行设置' }))
  await waitFor(() => expect(api.save).toHaveBeenCalledWith({ perUserPending: 4, perUserRunning: 1, globalQueued: 100, retentionDays: 0 }))
})
