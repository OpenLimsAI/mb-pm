import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import type { Project } from '../../types'
import { PMManagement } from './PMManagement'

const state = vi.hoisted(() => ({ role: 'admin', register: vi.fn(), costs: vi.fn(), quality: vi.fn(), changes: vi.fn(), saveRegister: vi.fn(), saveCost: vi.fn() }))
vi.mock('../../api/pmManagement', () => ({ pmManagement: state, managementError: (error: Error) => error.message }))
vi.mock('../../store/auth', () => ({ useAuth: (selector: (s: unknown) => unknown) => selector({ currentUser: { role: state.role } }) }))
vi.mock('../../store/data', () => ({ useDataStore: (selector: (s: unknown) => unknown) => selector({ mode: 'api', version: 0 }) }))
vi.mock('../../mock', () => ({ TODAY: new Date(2026, 10, 4), users: [{ id: 'owner', displayName: '负责人', isActive: true }], getProjectTasks: () => [{ id: 'task-1', name: '实验任务' }] }))
const project = { id: 'project-1', code: 'P1', name: '试验项目', ownerId: 'owner', memberIds: [] } as unknown as Project
function mount() { return render(<MemoryRouter><PMManagement project={project} /></MemoryRouter>) }
beforeEach(() => {
  vi.clearAllMocks(); state.role = 'admin'
  state.register.mockResolvedValue([])
  state.costs.mockResolvedValue({ items: [], spent: 7, recordedActual: 7, unreconciled: 0, payments: 5, remaining: 3, forecast: 15, budget: 10 })
  state.quality.mockResolvedValue({ items: [{ id: 'missing-1', taskId: 'task-1', title: '实验任务', reason: '已完成但未填实际结束日期', ownerId: 'owner', url: '/projects/project-1?tab=wbs&task=task-1' }] })
  state.changes.mockResolvedValue({ from: '2026-10-27T00:00:00Z', to: '2026-11-03T00:00:00Z', items: [{ id: 'change-1', createdAt: '2026-11-03T00:00:00Z', actorId: 'owner', action: 'change', title: '实验任务', taskId: 'task-1', detail: '进展已更新', changes: { progress: { before: 0, after: 10 } } }], truncated: false })
})
describe('项目管理跟进', () => {
  it('保存失败保留事项草稿，并传递完整责任与关闭结果', async () => {
    const user = userEvent.setup(); mount()
    await user.click(await screen.findByRole('button', { name: '新增事项' }))
    await user.type(screen.getByLabelText('事项名称'), '关键试验档期')
    await user.selectOptions(screen.getByLabelText('事项状态'), 'closed')
    await user.type(screen.getByLabelText('关闭结果'), 'CRO合同已确认')
    state.saveRegister.mockRejectedValueOnce(new Error('事项已被其他人修改'))
    await user.click(screen.getByRole('button', { name: '保存事项' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('事项已被其他人修改')
    expect(screen.getByLabelText('事项名称')).toHaveValue('关键试验档期')
    expect(state.saveRegister).toHaveBeenCalledWith('project-1', expect.objectContaining({ title: '关键试验档期', ownerId: 'owner', status: 'closed', closure: 'CRO合同已确认' }), undefined)
    state.saveRegister.mockResolvedValueOnce({ id: 'new' })
    await user.click(screen.getByRole('button', { name: '保存事项' }))
    await waitFor(() => expect(screen.queryByLabelText('事项名称')).not.toBeInTheDocument())
  })
  it('成员可读数据待办并直达任务，不能看到管理写入入口', async () => {
    state.role = 'rd'; const user = userEvent.setup(); mount()
    await screen.findByText('暂无跟进事项。')
    expect(screen.queryByRole('button', { name: '新增事项' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /数据待办/ }))
    expect(await screen.findByRole('link', { name: /实验任务/ })).toHaveAttribute('href', '/projects/project-1?tab=wbs&task=task-1')
    await user.click(screen.getByRole('button', { name: '费用与预测' }))
    expect(screen.queryByRole('button', { name: '新增费用' })).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('预测成本超出项目预算 5 万')
  })
  it('展示真实变化前后值及任务定位链接', async () => {
    const user = userEvent.setup(); mount()
    await screen.findByText('暂无跟进事项。')
    await user.click(screen.getByRole('button', { name: '变更与周报' }))
    expect(screen.getByText('进展已更新')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '实验任务' })).toHaveAttribute('href', '/projects/project-1?tab=wbs&task=task-1')
    expect(screen.getByText('进度：0 → 10')).toBeInTheDocument()
  })
})
