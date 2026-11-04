import { fireEvent, render, screen, within, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, expect, test, vi } from 'vitest'
import { TaskDrawer } from './TaskDrawer'
import { tasks, users } from '../../mock'
import { updateTaskProgress } from '../../data/bootstrap'
import { useDataStore } from '../../store/data'
import { useAuth } from '../../store/auth'
import type { Task } from '../../types'

vi.mock('../../data/bootstrap', () => ({ updateTaskProgress: vi.fn(), refreshAllData: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../api/taskCollaboration', async (original) => ({
  ...await original<typeof import('../../api/taskCollaboration')>(),
  getTaskCollaboration: vi.fn().mockResolvedValue({ activities: [], deliverables: [], acceptance: null }),
}))

const baseTask: Task = { ...tasks[0], status: '未开始', progress: 0, actualStart: undefined, actualEnd: undefined, actualEffort: undefined }

beforeEach(() => {
  vi.mocked(updateTaskProgress).mockReset().mockResolvedValue(undefined)
  sessionStorage.clear()
  useDataStore.setState({ mode: 'mock' })
  useAuth.setState({ currentUser: null })
})

function openTask(task: Task) {
  return render(<MemoryRouter><TaskDrawer task={task} onClose={vi.fn()} /></MemoryRouter>)
}

test.each([false, true])('普通任务与里程碑都能选择完整的四个主状态（里程碑：%s）', (isMilestone) => {
  openTask({ ...baseTask, isMilestone })
  expect(within(screen.getByRole('combobox', { name: '状态' })).getAllByRole('option').map((o) => o.textContent))
    .toEqual(['未开始', '进行中', '已完成', '已验证'])
})

test('里程碑可保存进行中、已完成及已验证，完成与验证均提交 100% 进度', async () => {
  openTask({ ...baseTask, isMilestone: true })
  fireEvent.change(screen.getByRole('combobox', { name: '状态' }), { target: { value: '进行中' } })
  fireEvent.click(screen.getByRole('button', { name: '保存进展' }))
  await screen.findByRole('button', { name: '保存进展' })
  expect(updateTaskProgress).toHaveBeenLastCalledWith(baseTask.id, expect.objectContaining({ status: '进行中' }))
  fireEvent.click(screen.getByRole('button', { name: '标记完成' }))
  expect(screen.getByRole('combobox', { name: '状态' })).toHaveValue('已完成')
  fireEvent.click(screen.getByRole('button', { name: '保存进展' }))
  await screen.findByRole('button', { name: '保存进展' })
  expect(updateTaskProgress).toHaveBeenLastCalledWith(baseTask.id, expect.objectContaining({ status: '已完成', progress: 100 }))
  fireEvent.change(screen.getByRole('combobox', { name: '状态' }), { target: { value: '已验证' } })
  fireEvent.click(screen.getByRole('button', { name: '保存进展' }))
  await screen.findByRole('button', { name: '保存进展' })
  expect(updateTaskProgress).toHaveBeenLastCalledWith(baseTask.id, expect.objectContaining({ status: '已验证' }))
})

test.each(['阻塞', '延迟'] as const)('编辑日期不会清除已有的%s副状态，可显式恢复进行中', async (status) => {
  openTask({ ...baseTask, isMilestone: false, status, progress: 35 })
  expect(screen.getByRole('combobox', { name: '状态' })).toHaveValue('进行中')
  expect(screen.getByText(`副状态：${status}`)).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('计划结束'), { target: { value: '2027-12-31' } })
  fireEvent.click(screen.getByRole('button', { name: '保存进展' }))
  await screen.findByRole('button', { name: '保存进展' })
  expect(updateTaskProgress).toHaveBeenLastCalledWith(baseTask.id, expect.objectContaining({ plannedEnd: '2027-12-31' }))
  fireEvent.click(screen.getByRole('button', { name: '清除副状态' }))
  fireEvent.click(screen.getByRole('button', { name: '保存进展' }))
  await screen.findByRole('button', { name: '保存进展' })
  expect(updateTaskProgress).toHaveBeenLastCalledWith(baseTask.id, expect.objectContaining({ status: '进行中' }))
})

test('里程碑从完成状态退回进行中时清除隐藏的完成进度', async () => {
  openTask({ ...baseTask, isMilestone: true, status: '已验证', progress: 100 })
  fireEvent.change(screen.getByRole('combobox', { name: '状态' }), { target: { value: '进行中' } })
  fireEvent.click(screen.getByRole('button', { name: '保存进展' }))
  await screen.findByRole('button', { name: '保存进展' })
  expect(updateTaskProgress).toHaveBeenLastCalledWith(baseTask.id, expect.objectContaining({ status: '进行中' }))
})


test('普通成员一次保存状态与零花费，不提交计划日期或其他未变化字段', async () => {
  useDataStore.setState({ mode: 'api' })
  useAuth.setState({ currentUser: { ...users[0], id: baseTask.ownerId, role: 'rd' } })
  openTask({ ...baseTask, revision: 3, actualCost: undefined })
  expect(screen.getByLabelText('计划开始')).toBeDisabled()
  expect(screen.getByLabelText('计划结束')).toBeDisabled()
  fireEvent.change(screen.getByRole('combobox', { name: '状态' }), { target: { value: '进行中' } })
  fireEvent.change(screen.getByLabelText('实际花费（万元）'), { target: { value: '0' } })
  fireEvent.change(screen.getByLabelText('本次进展说明'), { target: { value: '已完成第一轮' } })
  fireEvent.click(screen.getByRole('button', { name: '保存进展' }))
  await waitFor(() => expect(updateTaskProgress).toHaveBeenCalledWith(baseTask.id, {
    status: '进行中', actualCost: 0, progressNote: '已完成第一轮', expectedRevision: 3,
  }))
})

test('远端刷新保留未保存的草稿，比较后可基于最新版本继续', async () => {
  const initial = { ...baseTask, revision: 3 }
  const { rerender } = openTask(initial)
  fireEvent.change(screen.getByLabelText('本次进展说明'), { target: { value: '我的未保存说明' } })
  rerender(<MemoryRouter><TaskDrawer task={{ ...initial, revision: 4, progress: 60 }} onClose={vi.fn()} /></MemoryRouter>)
  expect(screen.getByLabelText('本次进展说明')).toHaveValue('我的未保存说明')
  expect(screen.getByText('任务已更新，当前草稿已保留。请比较最新数据后选择处理方式。')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '保存进展' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: '保留草稿，基于最新版本继续' }))
  fireEvent.click(screen.getByRole('button', { name: '保存进展' }))
  await waitFor(() => expect(updateTaskProgress).toHaveBeenCalledWith(initial.id, expect.objectContaining({ expectedRevision: 4, progressNote: '我的未保存说明' })))
})

test('409显示最新值并保留输入，不以通用网络错误替代', async () => {
  const initial = { ...baseTask, revision: 3 }
  vi.mocked(updateTaskProgress).mockRejectedValueOnce({ isAxiosError: true, response: { status: 409, data: { detail: { message: '任务已被其他人修改', current: { ...initial, revision: 4, progress: 80 } } } } })
  openTask(initial)
  fireEvent.change(screen.getByLabelText('本次进展说明'), { target: { value: '不能丢的草稿' } })
  fireEvent.click(screen.getByRole('button', { name: '保存进展' }))
  expect(await screen.findByText('任务已被其他人修改')).toBeInTheDocument()
  expect(screen.getByLabelText('本次进展说明')).toHaveValue('不能丢的草稿')
  expect(screen.getByText('80')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '保存进展' })).toBeDisabled()
})


test('取消关闭时保留草稿并阻止抽屉内部项目链接导航', () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  const onClose = vi.fn()
  render(<MemoryRouter><TaskDrawer task={baseTask} onClose={onClose} /></MemoryRouter>)
  fireEvent.change(screen.getByLabelText('本次进展说明'), { target: { value: '未保存内容' } })
  fireEvent.click(screen.getByRole('button', { name: '关闭' }))
  expect(onClose).not.toHaveBeenCalled()
  expect(screen.getByLabelText('本次进展说明')).toHaveValue('未保存内容')
  expect(confirm).toHaveBeenCalled()
  expect(fireEvent.click(screen.getByRole('link', { name: / · / }))).toBe(false)
  expect(onClose).not.toHaveBeenCalled()
  confirm.mockRestore()
})
