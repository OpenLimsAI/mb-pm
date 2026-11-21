import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { WBSTable } from './WBSTable'
import { projects, tasks } from '../../mock'
import { useAuth } from '../../store/auth'
import { useDataStore } from '../../store/data'
import { updateTaskProgress } from '../../data/bootstrap'
import type { Task } from '../../types'

const state = vi.hoisted(() => ({ task: {} as Partial<Task> }))
vi.mock('../../mock', async original => {
  const data = await original<typeof import('../../mock')>()
  return { ...data, getProjectSubs: () => [{ ...data.subProjects[0], id: 'audit-sub' }],
    getSubTasks: () => [{ ...data.tasks[0], id: 'audit-task', code: 'AUDIT', name: '核对任务', subProjectId: 'audit-sub', ...state.task }] }
})
vi.mock('../../data/bootstrap', () => ({ updateTaskProgress: vi.fn() }))
beforeEach(() => {
  vi.clearAllMocks()
  useDataStore.setState({ mode: 'api' })
  useAuth.setState({ currentUser: { id: 'u', role: 'admin' } as never })
  state.task = { status: '进行中', progress: 10, revision: 1, isMilestone: false, costBudget: 20, actualCost: 5 }
  vi.mocked(updateTaskProgress).mockImplementation(async (_id, patch) => ({ ...tasks[0], ...state.task, ...patch, revision: 2 } as Task))
})
test('未修改输入随后台刷新，失焦不把旧数值写回', () => {
  const view = render(<WBSTable project={projects[0]} />)
  state.task = { ...state.task, progress: 80, revision: 2, costBudget: 40, actualCost: 12 }
  view.rerender(<WBSTable project={{ ...projects[0] }} />)
  expect(screen.getByRole('spinbutton', { name: 'AUDIT 进度' })).toHaveValue(80)
  expect(screen.getByRole('spinbutton', { name: 'AUDIT 预算' })).toHaveValue(40)
  expect(screen.getByRole('spinbutton', { name: 'AUDIT 花费' })).toHaveValue(12)
  fireEvent.blur(screen.getByRole('spinbutton', { name: 'AUDIT 进度' }))
  expect(updateTaskProgress).not.toHaveBeenCalled()
})
test('编辑中同步保留草稿与原始修订号，冲突提示保留数据', async () => {
  const view = render(<WBSTable project={projects[0]} />)
  const input = screen.getByRole('spinbutton', { name: 'AUDIT 进度' })
  fireEvent.change(input, { target: { value: '25' } })
  state.task = { ...state.task, progress: 80, revision: 2 }
  view.rerender(<WBSTable project={{ ...projects[0] }} />)
  vi.mocked(updateTaskProgress).mockRejectedValueOnce({ isAxiosError: true, response: { status: 409, data: { detail: { message: '任务已修改', current: { ...tasks[0], ...state.task } } } } })
  fireEvent.blur(input)
  await waitFor(() => expect(updateTaskProgress).toHaveBeenCalledWith('audit-task', { progress: 25, expectedRevision: 1 }))
  expect(await screen.findByRole('alert')).toHaveTextContent('任务已修改')
  expect(input).toHaveValue(25)
  fireEvent.click(screen.getByRole('button', { name: '使用最新数据' }))
  expect(input).toHaveValue(80)
})
test('保留冲突草稿时更新其他未编辑字段', async () => {
  render(<WBSTable project={projects[0]} />)
  const input = screen.getByRole('spinbutton', { name: 'AUDIT 进度' })
  const budget = screen.getByRole('spinbutton', { name: 'AUDIT 预算' })
  const current = { ...tasks[0], ...state.task, revision: 2, progress: 80, costBudget: 40 }
  vi.mocked(updateTaskProgress).mockRejectedValueOnce({
    isAxiosError: true,
    response: { status: 409, data: { detail: { message: '任务已修改', current } } },
  })

  fireEvent.change(input, { target: { value: '25' } })
  fireEvent.blur(input)
  fireEvent.click(await screen.findByRole('button', { name: '核对后保留我的输入' }))
  expect(input).toHaveValue(25)
  expect(budget).toHaveValue(40)
  fireEvent.blur(budget)
  expect(updateTaskProgress).toHaveBeenCalledTimes(1)
})
test.each(['进行中', '已完成', '已验证'] as const)('里程碑准确展示 %s 并保留四个主状态', status => {
  state.task = { ...state.task, isMilestone: true, status, progress: status === '进行中' ? 0 : 100 }
  const { container } = render(<WBSTable project={projects[0]} />)
  const row = [...container.querySelectorAll('tr')].find(x => x.textContent?.includes('核对任务'))!
  const statusSelect = row.querySelectorAll('select')[1]
  expect(statusSelect).toHaveValue(status)
  expect([...statusSelect.options].map(x => x.value)).toEqual(['未开始', '进行中', '已完成', '已验证'])
})
test('普通成员不能在表格中修改负责人和计划日期', () => {
  state.task = { ...state.task, ownerId: 'u' }
  useAuth.setState({ currentUser: { id: 'u', role: 'rd' } as never })
  const { container } = render(<WBSTable project={projects[0]} />)
  const row = [...container.querySelectorAll('tr')].find(x => x.textContent?.includes('核对任务'))!
  expect(row.querySelectorAll('select')[0]).toBeDisabled()
  expect(row.querySelectorAll('input[type=date]')[0]).toBeDisabled()
  expect(screen.getByRole('spinbutton', { name: 'AUDIT 进度' })).not.toBeDisabled()
})
