import { fireEvent, render, screen, within, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, expect, test, vi } from 'vitest'
import { TaskDrawer } from './TaskDrawer'
import { tasks, users } from '../../mock'
import { refreshAllData, updateTaskProgress } from '../../data/bootstrap'
import { applyScheduleAssist, previewScheduleAssist, type ScheduleAssistPreview } from '../../api/projectAIWork'
import { listTasks } from '../../api/tasks'
import { useDataStore } from '../../store/data'
import { useAuth } from '../../store/auth'
import type { Task } from '../../types'

vi.mock('../../data/bootstrap', () => ({ updateTaskProgress: vi.fn(), refreshAllData: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../api/projectAIWork', () => ({ applyScheduleAssist: vi.fn(), previewScheduleAssist: vi.fn() }))
vi.mock('../../api/tasks', async (original) => ({ ...await original<typeof import('../../api/tasks')>(), listTasks: vi.fn() }))
vi.mock('../../api/taskCollaboration', async (original) => ({
  ...await original<typeof import('../../api/taskCollaboration')>(),
  getTaskCollaboration: vi.fn().mockResolvedValue({ activities: [], deliverables: [], acceptance: null }),
}))

const baseTask: Task = { ...tasks[0], status: '未开始', progress: 0, actualStart: undefined, actualEnd: undefined, actualEffort: undefined }

beforeEach(() => {
  vi.mocked(updateTaskProgress).mockReset().mockResolvedValue(undefined)
  vi.mocked(refreshAllData).mockReset().mockResolvedValue(undefined)
  vi.mocked(previewScheduleAssist).mockReset()
  vi.mocked(applyScheduleAssist).mockReset()
  vi.mocked(listTasks).mockReset()
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

const assistantPreview = (): ScheduleAssistPreview => ({
  delayWorkdays: 5,
  lockedMilestones: [{ taskId: 'submit', name: '申报', code: 'M01', startDate: '2026-12-24', date: '2026-12-25' }],
  schedule: {
    fingerprint: 'preview-version',
    changes: [{ taskId: baseTask.id, name: baseTask.name, code: baseTask.code,
      oldStart: baseTask.plannedStart, oldEnd: baseTask.plannedEnd,
      newStart: '2026-12-01', newEnd: '2026-12-04', isMilestone: false }],
    conflicts: [],
    previousFinish: '2026-12-25',
    newFinish: '2026-12-25',
  },
  confirmationToken: 'reviewed-proposal',
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
})

function openScheduleAssist() {
  useAuth.setState({ currentUser: users.find(user => user.role === 'admin')! })
  useDataStore.setState({ mode: 'api' })
  const view = openTask(baseTask)
  fireEvent.click(screen.getByText('AI 排期推演'))
  fireEvent.change(screen.getByLabelText('延期要求'), { target: { value: '延迟 5 个工作日，申报不动' } })
  return view
}

test('AI 排期只在确认后写入，关闭抽屉仍能读取回执并重试核验', async () => {
  const preview = assistantPreview()
  vi.mocked(previewScheduleAssist).mockResolvedValueOnce(preview)
  vi.mocked(applyScheduleAssist).mockResolvedValueOnce({ receiptId: 'applied-1', replayed: false, schedule: preview.schedule })
  vi.mocked(listTasks).mockRejectedValueOnce(new Error('read unavailable'))
  const view = openScheduleAssist()
  fireEvent.click(screen.getByRole('button', { name: '预览排期影响' }))
  expect(await screen.findByRole('table', { name: '排期调整前后对比' })).toHaveTextContent('2026-12-04')
  expect(screen.getByRole('link', { name: 'M01 · 申报' })).toHaveAttribute('href', expect.stringContaining('task=submit'))
  const confirm = screen.getByRole('button', { name: '确认应用 1 项调整' })
  expect(confirm).toBeDisabled()
  expect(applyScheduleAssist).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('调整原因'), { target: { value: '供应商延期' } })
  fireEvent.click(confirm)
  view.unmount()
  await waitFor(() => expect(listTasks).toHaveBeenCalledTimes(1))
  openTask(baseTask)
  fireEvent.click(screen.getByText('AI 排期推演'))
  expect(await screen.findByText('调整已应用 · 回执 applied-1')).toBeInTheDocument()
  expect(applyScheduleAssist).toHaveBeenCalledWith(expect.any(String), 'reviewed-proposal', '供应商延期')

  const dates = { collaboratorIds: null, actualStart: null, actualEnd: null, actualEffort: null, notes: null, tags: null }
  vi.mocked(listTasks).mockResolvedValueOnce({
    items: [
      { ...baseTask, ...dates, plannedStart: '2026-12-01', plannedEnd: '2026-12-04' },
      { ...baseTask, ...dates, id: 'submit', plannedStart: '2026-12-24', plannedEnd: '2026-12-25' },
    ],
    meta: { page: 1, pageSize: 5000, total: 2 },
  })
  fireEvent.click(await screen.findByRole('button', { name: '重新核验并同步' }))
  expect(await screen.findByText('已核验受影响任务和锁定里程碑的日期。')).toBeInTheDocument()
  expect(applyScheduleAssist).toHaveBeenCalledTimes(1)
  expect(refreshAllData).toHaveBeenCalledTimes(2)
  fireEvent.click(screen.getByRole('button', { name: '开始新的推演' }))
  expect(screen.getByLabelText('延期要求')).toHaveValue('')
  expect(screen.queryByText('调整已应用 · 回执 applied-1')).not.toBeInTheDocument()
})

test('AI 排期显示锁定冲突，保留未保存的进展并禁用推演', async () => {
  const preview = assistantPreview()
  preview.schedule.conflicts = [{ taskId: 'submit', name: '申报', reason: '锁定节点无法满足依赖' }]
  vi.mocked(previewScheduleAssist).mockResolvedValueOnce({ ...preview, confirmationToken: null, expiresAt: null })
  openScheduleAssist()
  fireEvent.click(screen.getByRole('button', { name: '预览排期影响' }))
  expect(await screen.findByText('申报：锁定节点无法满足依赖')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /确认应用/ })).not.toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('本次进展说明'), { target: { value: '待保存的进展' } })
  expect(screen.getByRole('button', { name: '预览排期影响' })).toBeDisabled()
  expect(screen.getByLabelText('本次进展说明')).toHaveValue('待保存的进展')
  expect(applyScheduleAssist).not.toHaveBeenCalled()
})

test('确认请求未收到回执时，重新打开抽屉仍使用原确认记录重试', async () => {
  const preview = assistantPreview()
  vi.mocked(previewScheduleAssist).mockResolvedValueOnce(preview)
  vi.mocked(applyScheduleAssist)
    .mockRejectedValueOnce(new Error('request timed out'))
    .mockResolvedValueOnce({ receiptId: 'applied-2', replayed: true, schedule: preview.schedule })
  vi.mocked(listTasks).mockRejectedValue(new Error('read unavailable'))
  const view = openScheduleAssist()
  fireEvent.click(screen.getByRole('button', { name: '预览排期影响' }))
  fireEvent.change(await screen.findByLabelText('调整原因'), { target: { value: '供应商延期' } })
  fireEvent.click(screen.getByRole('button', { name: '确认应用 1 项调整' }))
  await screen.findByRole('button', { name: '重试本次确认' })
  view.unmount()
  openTask(baseTask)
  fireEvent.click(screen.getByText('AI 排期推演'))
  const retry = screen.getByRole('button', { name: '重试本次确认' })
  expect(screen.getByLabelText('延期要求')).toBeDisabled()
  expect(screen.getByLabelText('调整原因')).toBeDisabled()
  fireEvent.click(retry)
  expect(await screen.findByText('调整已应用 · 回执 applied-2')).toBeInTheDocument()
  expect(vi.mocked(applyScheduleAssist).mock.calls[1]).toEqual(vi.mocked(applyScheduleAssist).mock.calls[0])
  expect(screen.queryByRole('button', { name: /确认应用|重试本次确认/ })).not.toBeInTheDocument()
  expect(previewScheduleAssist).toHaveBeenCalledTimes(1)
})
