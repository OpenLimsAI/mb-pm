import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, expect, test, vi } from 'vitest'
import { TaskDrawer } from './TaskDrawer'
import { tasks } from '../../mock'
import { updateTaskProgress } from '../../data/bootstrap'
import { useDataStore } from '../../store/data'
import type { Task } from '../../types'

vi.mock('../../data/bootstrap', () => ({ updateTaskProgress: vi.fn() }))

const baseTask: Task = { ...tasks[0], status: '未开始', progress: 0, actualStart: undefined, actualEnd: undefined, actualEffort: undefined }

beforeEach(() => {
  vi.mocked(updateTaskProgress).mockReset().mockResolvedValue(undefined)
  useDataStore.setState({ mode: 'mock' })
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
  expect(updateTaskProgress).toHaveBeenLastCalledWith(baseTask.id, expect.objectContaining({ status: '进行中', progress: 0 }))
  fireEvent.click(screen.getByRole('button', { name: '标记完成' }))
  expect(screen.getByRole('combobox', { name: '状态' })).toHaveValue('已完成')
  fireEvent.click(screen.getByRole('button', { name: '保存进展' }))
  await screen.findByRole('button', { name: '保存进展' })
  expect(updateTaskProgress).toHaveBeenLastCalledWith(baseTask.id, expect.objectContaining({ status: '已完成', progress: 100 }))
  fireEvent.change(screen.getByRole('combobox', { name: '状态' }), { target: { value: '已验证' } })
  fireEvent.click(screen.getByRole('button', { name: '保存进展' }))
  await screen.findByRole('button', { name: '保存进展' })
  expect(updateTaskProgress).toHaveBeenLastCalledWith(baseTask.id, expect.objectContaining({ status: '已验证', progress: 100 }))
})

test.each(['阻塞', '延迟'] as const)('编辑日期不会清除已有的%s副状态，可显式恢复进行中', async (status) => {
  openTask({ ...baseTask, isMilestone: false, status, progress: 35 })
  expect(screen.getByRole('combobox', { name: '状态' })).toHaveValue('进行中')
  expect(screen.getByText(`副状态：${status}`)).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('计划结束'), { target: { value: '2027-12-31' } })
  fireEvent.click(screen.getByRole('button', { name: '保存进展' }))
  await screen.findByRole('button', { name: '保存进展' })
  expect(updateTaskProgress).toHaveBeenLastCalledWith(baseTask.id, expect.objectContaining({ status, progress: 35, plannedEnd: '2027-12-31' }))
  fireEvent.click(screen.getByRole('button', { name: '清除副状态' }))
  fireEvent.click(screen.getByRole('button', { name: '保存进展' }))
  await screen.findByRole('button', { name: '保存进展' })
  expect(updateTaskProgress).toHaveBeenLastCalledWith(baseTask.id, expect.objectContaining({ status: '进行中', progress: 35 }))
})

test('里程碑从完成状态退回进行中时清除隐藏的完成进度', async () => {
  openTask({ ...baseTask, isMilestone: true, status: '已验证', progress: 100 })
  fireEvent.change(screen.getByRole('combobox', { name: '状态' }), { target: { value: '进行中' } })
  fireEvent.click(screen.getByRole('button', { name: '保存进展' }))
  await screen.findByRole('button', { name: '保存进展' })
  expect(updateTaskProgress).toHaveBeenLastCalledWith(baseTask.id, expect.objectContaining({ status: '进行中', progress: 0 }))
})
