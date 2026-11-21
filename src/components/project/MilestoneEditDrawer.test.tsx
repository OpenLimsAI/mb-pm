import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MilestoneEditDrawer } from './MilestoneEditDrawer'
import { createMilestoneWithDeps, updateMilestoneWithDeps } from '../../data/bootstrap'
import { projects, tasks, taskDependencies } from '../../mock'
import { useDataStore } from '../../store/data'

vi.mock('../../data/bootstrap', () => ({ createMilestoneWithDeps: vi.fn(), updateMilestoneWithDeps: vi.fn(), deleteMilestoneWithDeps: vi.fn() }))
const previousMode = useDataStore.getState().mode
const previousDependencies = [...taskDependencies]
beforeEach(() => {
  vi.resetAllMocks()
  useDataStore.setState({ mode: 'api' })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks(); useDataStore.setState({ mode: previousMode }); taskDependencies.splice(0, taskDependencies.length, ...previousDependencies) })

it('reuses the creation request after a lost response and starts a new request after editing', async () => {
  vi.mocked(createMilestoneWithDeps).mockRejectedValue(new Error('回复丢失'))
  render(<MilestoneEditDrawer target={{ mode: 'create' }} project={projects[0]} onClose={vi.fn()} />)
  fireEvent.change(screen.getByLabelText(/里程碑名称/), { target: { value: '验收节点' } })
  fireEvent.change(screen.getByLabelText(/计划达成日/), { target: { value: '2026-12-01' } })
  fireEvent.click(screen.getByRole('button', { name: /保存|创建里程碑/ }))
  await waitFor(() => expect(createMilestoneWithDeps).toHaveBeenCalledTimes(1))
  await waitFor(() => expect(screen.getByRole('button', { name: /保存|创建里程碑/ })).not.toBeDisabled())
  fireEvent.click(screen.getByRole('button', { name: /保存|创建里程碑/ }))
  await waitFor(() => expect(createMilestoneWithDeps).toHaveBeenCalledTimes(2))
  const calls = vi.mocked(createMilestoneWithDeps).mock.calls
  expect(calls[0][0].saveContext?.requestId).toBe(calls[1][0].saveContext?.requestId)
  await waitFor(() => expect(screen.getByRole('button', { name: /保存|创建里程碑/ })).not.toBeDisabled())
  fireEvent.change(screen.getByLabelText(/里程碑名称/), { target: { value: '改过的节点' } })
  fireEvent.click(screen.getByRole('button', { name: /保存|创建里程碑/ }))
  await waitFor(() => expect(createMilestoneWithDeps).toHaveBeenCalledTimes(3))
  expect(calls[2][0].saveContext?.requestId).not.toBe(calls[0][0].saveContext?.requestId)
})

it('keeps the opening revision when a background refresh replaces the task', async () => {
  vi.mocked(updateMilestoneWithDeps).mockResolvedValue(undefined)
  const task = { ...tasks[0], isMilestone: true, revision: 7 }
  const close = vi.fn()
  const view = render(<MilestoneEditDrawer target={{ mode: 'edit', milestone: task }} project={projects[0]} onClose={close} />)
  fireEvent.change(screen.getByLabelText(/里程碑名称/), { target: { value: '我正在编辑' } })
  view.rerender(<MilestoneEditDrawer target={{ mode: 'edit', milestone: { ...task, revision: 8 } }} project={projects[0]} onClose={close} />)
  fireEvent.click(screen.getByRole('button', { name: /保存|创建里程碑/ }))
  await waitFor(() => expect(updateMilestoneWithDeps).toHaveBeenCalledWith(task.id, expect.objectContaining({ name: '我正在编辑' }), expect.any(Array), expect.objectContaining({ expectedRevision: 7 })))
})

it('lets the server validate an independent online save when an unrelated legacy cycle is visible', async () => {
  taskDependencies.push(
    { id: 'bad-ab', predecessorId: 'bad-a', successorId: 'bad-b', type: 'FS', lagDays: 0 },
    { id: 'bad-ba', predecessorId: 'bad-b', successorId: 'bad-a', type: 'FS', lagDays: 0 },
  )
  vi.mocked(createMilestoneWithDeps).mockResolvedValue('new-milestone')
  render(<MilestoneEditDrawer target={{ mode: 'create' }} project={projects[0]} onClose={vi.fn()} />)
  fireEvent.change(screen.getByLabelText(/里程碑名称/), { target: { value: '独立节点' } })
  fireEvent.change(screen.getByLabelText(/计划达成日/), { target: { value: '2026-12-01' } })
  fireEvent.click(screen.getByRole('button', { name: '创建里程碑' }))
  await waitFor(() => expect(createMilestoneWithDeps).toHaveBeenCalledTimes(1))
})
