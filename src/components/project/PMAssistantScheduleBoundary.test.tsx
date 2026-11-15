import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, expect, test, vi } from 'vitest'
import { PMAIScheduleCompare } from './PMAIScheduleCompare'
import { ScheduleAssist } from '../task/ScheduleAssist'
import { pmAI, type PMAIContext } from '../../api/pmAI'
import { applyScheduleAssist, previewScheduleAssist, type ScheduleAssistPreview } from '../../api/projectAIWork'
import { listTasks } from '../../api/tasks'
import { tasks, users } from '../../mock'
import { useAuth } from '../../store/auth'
import { useDataStore } from '../../store/data'

vi.mock('../../api/pmAI', () => ({ pmAI: { compare: vi.fn() } }))
vi.mock('../../api/projectAIWork', () => ({ applyScheduleAssist: vi.fn(), previewScheduleAssist: vi.fn() }))
vi.mock('../../api/tasks', () => ({ listTasks: vi.fn() }))
vi.mock('../../data/bootstrap', () => ({ refreshAllData: vi.fn().mockResolvedValue(undefined) }))

const task = { ...tasks[0], id: 'T1', revision: 3, status: '进行中' as const, progress: 30 }
const context: PMAIContext = {
  schemaVersion: 1, scope: { projectIds: ['P1'], taskIds: ['T1'] }, asOf: '2026-11-15', timezone: 'Asia/Shanghai',
  projects: [{ id: 'P1', code: 'P1', name: '测试项目', ownerId: 'owner' }],
  tasks: [{ id: 'T1', code: task.code, name: task.name, projectId: 'P1', subProjectId: task.subProjectId, ownerId: task.ownerId, revision: 3 }],
  members: [], subProjects: [], registerEntries: [], source: { schemaVersion: 1, asOf: '2026-11-15', complete: true, refs: [] },
}
function preview(delayWorkdays = 5): ScheduleAssistPreview {
  return {
    delayWorkdays, lockedMilestones: [], confirmationToken: `old-${delayWorkdays}-day-token`,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    schedule: { fingerprint: 'original-plan', changes: [{ taskId: 'T1', code: task.code, name: task.name,
      oldStart: '2026-12-01', oldEnd: '2026-12-04', newStart: '2026-12-08', newEnd: '2026-12-11', isMilestone: false }],
    conflicts: [], previousFinish: '2026-12-04', newFinish: '2026-12-11' },
  }
}
beforeEach(() => {
  vi.clearAllMocks()
  sessionStorage.clear()
  useAuth.setState({ currentUser: users.find(user => user.role === 'admin')! })
  useDataStore.setState({ mode: 'api' })
  vi.mocked(listTasks).mockRejectedValue(new Error('read unavailable'))
})

test('新排期要求10天遇上次5天确认未取回执，明确区分且仅显式重试原确认', async () => {
  const old = preview()
  sessionStorage.setItem(`pm-schedule-confirmation:${JSON.stringify(['owner', 'P1', 'T1'])}`, JSON.stringify({
    preview: { ...old, taskVersion: [task.revision, task.status, task.plannedStart, task.plannedEnd].join(':') }, reason: '上次供应商延期',
  }))
  vi.mocked(applyScheduleAssist).mockResolvedValue({ receiptId: 'old-receipt', replayed: true, schedule: old.schedule })
  vi.mocked(previewScheduleAssist).mockResolvedValue(preview(10))
  render(<MemoryRouter><ScheduleAssist userId="owner" projectId="P1" task={task} editorDirty={false} embedded initialInstruction="延迟10个工作日" autoPreview /></MemoryRouter>)
  expect(screen.getByRole('alert')).toHaveTextContent('上次确认尚未取得回执，本次新要求尚未预览')
  expect(screen.getByText('顺延 5 个工作日 · 涉及 1 项调整')).toBeInTheDocument()
  expect(screen.queryByText(/顺延 10 个工作日/)).not.toBeInTheDocument()
  expect(screen.getByLabelText('延期要求')).toHaveValue('延迟10个工作日')
  expect(screen.getByLabelText('延期要求')).toBeDisabled()
  await act(async () => { await Promise.resolve() })
  expect(previewScheduleAssist).not.toHaveBeenCalled()
  expect(applyScheduleAssist).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '重试上次确认' }))
  expect(await screen.findByText('上次调整已应用 · 回执 old-receipt')).toBeInTheDocument()
  expect(applyScheduleAssist).toHaveBeenCalledExactlyOnceWith('P1', 'old-5-day-token', '上次供应商延期')
  await waitFor(() => expect(screen.getByRole('button', { name: '开始新的推演' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: '开始新的推演' }))
  expect(screen.getByLabelText('延期要求')).toHaveValue('延迟10个工作日')
  expect(previewScheduleAssist).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '预览排期影响' }))
  await waitFor(() => expect(previewScheduleAssist).toHaveBeenCalledExactlyOnceWith('P1', 'T1', '延迟10个工作日', expect.any(AbortSignal)))
  expect(applyScheduleAssist).toHaveBeenCalledTimes(1)
})

test('新比较10天遇上次5天确认未取回执，不把旧方案当成本次预览且不自动写入', async () => {
  const old = preview()
  sessionStorage.setItem('pm-ai-comparison:owner:P1:T1', JSON.stringify({ plan: old, reason: '原5天方案' }))
  vi.mocked(applyScheduleAssist).mockResolvedValue({ receiptId: 'original-comparison', replayed: true, schedule: old.schedule })
  render(<MemoryRouter><PMAIScheduleCompare projectId="P1" taskId="T1" userId="owner" context={context} disabled={false} initialDelays={[10]} autoCompare /></MemoryRouter>)
  expect(screen.getByRole('alert')).toHaveTextContent('上次确认尚未取得回执，本次新要求尚未预览')
  expect(screen.getByText('顺延 5 个工作日')).toBeInTheDocument()
  expect(screen.queryByText('顺延 10 个工作日')).not.toBeInTheDocument()
  expect(screen.getByLabelText('顺延工作日方案')).toHaveValue('10')
  await act(async () => { await Promise.resolve() })
  expect(pmAI.compare).not.toHaveBeenCalled()
  expect(applyScheduleAssist).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '重试上次确认' }))
  expect(await screen.findByText('上次排期已更新 · 回执 original-comparison')).toBeInTheDocument()
  expect(applyScheduleAssist).toHaveBeenCalledExactlyOnceWith('P1', 'old-5-day-token', '原5天方案')
  expect(pmAI.compare).not.toHaveBeenCalled()
})
