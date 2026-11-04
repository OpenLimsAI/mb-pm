import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../../types'
import { ProgressPolicy } from './ProgressPolicy'
import { progressPolicyApi, type ProgressPolicyResult } from '../../api/progressPolicy'

vi.mock('../../store/data', () => ({ useDataStore: (selector: (state: { mode: string }) => unknown) => selector({ mode: 'api' }) }))
vi.mock('../../data/bootstrap', () => ({ refreshAllData: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../api/progressPolicy', () => ({ progressPolicyApi: { get: vi.fn(), preview: vi.fn(), save: vi.fn() } }))
const project = { id: 'p', name: '研发项目' } as Project
const initial: ProgressPolicyResult = {
  projectId: 'p', method: 'equal', currentMethod: 'equal', beforeProgress: 50, progress: 50, exactProgress: 50, numerator: 100, denominator: 2,
  fingerprint: 'initial', changed: false, editable: true,
  rows: [
    { taskId: 'Task-A', subProjectId: 's', name: '长任务完整名称', code: 'T1', progress: 100, isMilestone: false, estimatedEffort: 9, customWeight: null, effectiveWeight: 1, share: 0.5, contribution: 50 },
    { taskId: 'Task-B', subProjectId: 's', name: '第二任务', code: 'T2', progress: 0, isMilestone: false, estimatedEffort: 1, customWeight: null, effectiveWeight: 1, share: 0.5, contribution: 0 },
  ],
  subprojects: [], rules: { equal: '所有任务等权', effort: '普通任务按预计工时', custom: '普通默认1，里程碑默认0', formula: '加权平均，四舍五入' },
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(progressPolicyApi.get).mockResolvedValue(initial)
  vi.mocked(progressPolicyApi.preview).mockResolvedValue({ ...initial, method: 'custom', changed: true, progress: 0, fingerprint: 'reviewed' })
  vi.mocked(progressPolicyApi.save).mockResolvedValue({ ...initial, method: 'custom' })
})
describe('progress policy review', () => {
  it('keeps explicit zero in the reviewed request and requires a reason to apply', async () => {
    const user = userEvent.setup()
    render(<ProgressPolicy project={project} />)
    await screen.findByText('当前计算：50% · 任务等权')
    await user.selectOptions(screen.getByLabelText('进度计算方式'), 'custom')
    await user.type(screen.getByLabelText('长任务完整名称的进度权重'), '0')
    await user.click(screen.getByRole('button', { name: '预览计算结果' }))
    await screen.findByText('预览：50% → 0% · 自定义权重')
    expect(progressPolicyApi.preview).toHaveBeenCalledWith('p', { method: 'custom', weights: [{ taskId: 'Task-A', value: 0 }] })
    expect(screen.getByRole('button', { name: '确认保存计算规则' })).toBeDisabled()
    await user.type(screen.getByLabelText('计算规则修改原因'), '按投入调整')
    await user.click(screen.getByRole('button', { name: '确认保存计算规则' }))
    await waitFor(() => expect(progressPolicyApi.save).toHaveBeenCalledWith('p', { method: 'custom', weights: [{ taskId: 'Task-A', value: 0 }], fingerprint: 'reviewed', reason: '按投入调整' }))
  })
  it('requires a fresh review after editing and retains edits on conflicts', async () => {
    const user = userEvent.setup()
    vi.mocked(progressPolicyApi.save).mockRejectedValue(new Error('任务已变化，请重新预览'))
    render(<ProgressPolicy project={project} />)
    await screen.findByLabelText('进度计算方式')
    await user.selectOptions(screen.getByLabelText('进度计算方式'), 'custom')
    await user.type(screen.getByLabelText('第二任务的进度权重'), '3')
    await user.click(screen.getByRole('button', { name: '预览计算结果' }))
    await screen.findByLabelText('计算规则修改原因')
    await user.type(screen.getByLabelText('计算规则修改原因'), '工作量差异')
    await user.click(screen.getByRole('button', { name: '确认保存计算规则' }))
    await screen.findByText('任务已变化，请重新预览')
    expect(screen.queryByRole('button', { name: '确认保存计算规则' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('第二任务的进度权重')).toHaveValue(3)
    await user.click(screen.getByRole('button', { name: '预览计算结果' }))
    await screen.findByRole('button', { name: '确认保存计算规则' })
    await user.selectOptions(screen.getByLabelText('进度计算方式'), 'effort')
    expect(screen.queryByRole('button', { name: '确认保存计算规则' })).not.toBeInTheDocument()
  })
  it('lets members read the calculation without offering write controls', async () => {
    vi.mocked(progressPolicyApi.get).mockResolvedValue({ ...initial, editable: false, hiddenTaskCount: 2 })
    render(<ProgressPolicy project={project} />)
    await screen.findByText('计算规则由管理员或本项目负责人维护。')
    expect(screen.getByLabelText('进度计算方式')).toBeDisabled()
    expect(screen.queryByRole('button', { name: '预览计算结果' })).not.toBeInTheDocument()
    expect(screen.getByText(/当前账号不可查看的任务/)).toBeInTheDocument()
  })
})
