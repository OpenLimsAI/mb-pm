import { beforeEach, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { Notifications } from './Notifications'
const state = vi.hoisted(() => ({ notifications: vi.fn(), notificationState: vi.fn(), notificationMode: vi.fn() }))
vi.mock('../../api/pmManagement', () => ({ pmManagement: state, managementError: (error: Error) => error.message }))
vi.mock('../../store/auth', () => ({ useAuth: (selector: (s: unknown) => unknown) => selector({ currentUser: { id: 'member' } }) }))
vi.mock('../../store/data', () => ({ useDataStore: (selector: (s: unknown) => unknown) => selector({ mode: 'api', version: 0 }) }))
const data = { mode: 'daily', asOf: '2026-11-03T00:00:00Z', unread: 1, badgeCount: 1, digestKeys: ['event-1'], items: [{ key: 'event-1', kind: 'mention', title: '实验任务', detail: '请核对结果', read: false, url: '/projects/p1?tab=wbs&task=t1', createdAt: '2026-11-03T00:00:00Z' }] }
beforeEach(() => { vi.clearAllMocks(); state.notifications.mockResolvedValue(data); state.notificationState.mockResolvedValue({ updated: 1 }); state.notificationMode.mockResolvedValue({}) })
it('每日汇总打开、暂缓并持久化个人通知状态，Escape恢复焦点', async () => {
  const user = userEvent.setup()
  render(<MemoryRouter><Notifications /></MemoryRouter>)
  const trigger = await screen.findByRole('button', { name: '通知中心，1 条未读' })
  await user.click(trigger)
  expect(screen.getByRole('dialog', { name: '通知中心' })).toBeInTheDocument()
  expect(screen.getByText(/每天首次读取时汇总一次/)).toBeInTheDocument()
  expect(screen.getByRole('link', { name: '实验任务' })).toHaveAttribute('href', '/projects/p1?tab=wbs&task=t1')
  await user.click(screen.getByRole('button', { name: '暂缓 24 小时' }))
  await waitFor(() => expect(state.notificationState).toHaveBeenCalledWith(['event-1'], 'snooze'))
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(trigger).toHaveFocus()
})
it('暂停提醒不显示角标但保留通知查看', async () => {
  state.notifications.mockResolvedValue({ ...data, mode: 'paused', badgeCount: 0 })
  const user = userEvent.setup(); render(<MemoryRouter><Notifications /></MemoryRouter>)
  const trigger = await screen.findByRole('button', { name: '通知中心，1 条未读' })
  expect(trigger).not.toHaveTextContent('汇总')
  await user.click(trigger)
  expect(screen.getByText('主动角标已暂停，仍可在这里查看和处理事项。')).toBeInTheDocument()
})
