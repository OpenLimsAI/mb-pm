import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyReportAction, getReportActions, previewReportAction, type ActionDraft } from '../../api/projectAIWork'
import { refreshAllData } from '../../data/bootstrap'
import { useAuth } from '../../store/auth'
import { users } from '../../mock'
import { AIReportActions } from './AIReportActions'

vi.mock('../../api/projectAIWork', () => ({ getReportActions: vi.fn(), previewReportAction: vi.fn(), applyReportAction: vi.fn() }))
vi.mock('../../data/bootstrap', () => ({ refreshAllData: vi.fn() }))
const proposal: ActionDraft = { actionKey: 'suggestion-0', kind: 'risk', title: '关键试验资源风险', reason: '先核对供应商窗口', ownerId: 'u3', dueDate: '2026-11-20', severity: 'high' }
const preview = { fingerprint: 'preview-1', reportStale: false, changes: [{ type: '新增风险', name: proposal.title, ownerId: proposal.ownerId, dueDate: proposal.dueDate }] }
const result = { kind: 'risk', targetId: 'new-risk', replayed: false, changes: preview.changes }
const renderActions = () => render(<MemoryRouter><AIReportActions projectId="p1" reportId="r1" /></MemoryRouter>)

beforeEach(() => {
  useAuth.setState({ currentUser: users[0], status: 'ready' })
  vi.mocked(getReportActions).mockResolvedValue({ proposals: [proposal], applied: [] })
  vi.mocked(previewReportAction).mockResolvedValue(preview)
  vi.mocked(applyReportAction).mockResolvedValue(result)
  vi.mocked(refreshAllData).mockResolvedValue(undefined)
})
afterEach(() => { vi.resetAllMocks(); useAuth.setState({ currentUser: null, status: 'loading' }) })

async function chooseAndReview() {
  fireEvent.click(await screen.findByRole('button', { name: '核对并预览' }))
  fireEvent.click(screen.getByRole('button', { name: '预览影响' }))
  return screen.findByRole('button', { name: '确认执行此建议' })
}

describe('AI 建议确认与执行记录', () => {
  it('建议编辑后旧预览失效，必须再次预览才可确认执行', async () => {
    renderActions()
    await chooseAndReview()
    fireEvent.change(screen.getByLabelText('行动名称'), { target: { value: '核对后更新的风险名称' } })
    expect(screen.queryByRole('button', { name: '确认执行此建议' })).not.toBeInTheDocument()
    expect(applyReportAction).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '预览影响' }))
    await screen.findByRole('button', { name: '确认执行此建议' })
    expect(vi.mocked(previewReportAction).mock.lastCall?.[2].title).toBe('核对后更新的风险名称')
    fireEvent.change(screen.getByLabelText('行动采纳原因'), { target: { value: '补充人工核对依据' } })
    expect(screen.queryByRole('button', { name: '确认执行此建议' })).not.toBeInTheDocument()
  })

  it('并发409清除旧预览且保留人工草稿，可重新核对', async () => {
    vi.mocked(applyReportAction).mockRejectedValue({ isAxiosError: true, response: { status: 409, data: { detail: '项目数据已变化，请重新预览' } }, message: 'Conflict' })
    renderActions()
    fireEvent.click(await chooseAndReview())
    expect(await screen.findByRole('alert')).toHaveTextContent('项目数据已变化')
    expect(screen.getByLabelText('行动名称')).toHaveValue(proposal.title)
    expect(screen.getByLabelText('行动采纳原因')).toHaveValue(proposal.reason)
    expect(screen.getByLabelText('行动处理期限')).toHaveValue(proposal.dueDate)
    expect(screen.queryByRole('button', { name: '确认执行此建议' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '预览影响' }))
    expect(await screen.findByRole('button', { name: '确认执行此建议' })).toBeEnabled()
    expect(previewReportAction).toHaveBeenCalledTimes(2)
  })

  it('成功后显示已执行记录与结果入口，已执行建议不能再次确认', async () => {
    vi.mocked(getReportActions).mockResolvedValueOnce({ proposals: [proposal], applied: [] }).mockResolvedValue({ proposals: [proposal], applied: [{ actionKey: proposal.actionKey, createdAt: '2026-11-04T12:00:00Z', draft: proposal, result }] })
    renderActions()
    fireEvent.click(await chooseAndReview())
    expect(await screen.findByRole('status')).toHaveTextContent('建议已执行')
    expect(await screen.findByText('已执行')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '核对并预览' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('行动名称')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('已执行记录（1）'))
    expect(screen.getByRole('link', { name: '查看结果' })).toHaveAttribute('href', '/projects/p1?tab=management')
    expect(refreshAllData).toHaveBeenCalledOnce()
    expect(applyReportAction).toHaveBeenCalledWith('p1', 'r1', expect.objectContaining({ actionKey: proposal.actionKey, title: proposal.title }), 'preview-1')
  })

  it('服务端幂等重放明确提示未重复创建，重新读取执行记录', async () => {
    vi.mocked(applyReportAction).mockResolvedValue({ ...result, replayed: true })
    renderActions()
    fireEvent.click(await chooseAndReview())
    expect(await screen.findByRole('status')).toHaveTextContent('未重复创建')
    await waitFor(() => expect(getReportActions).toHaveBeenCalledTimes(2))
    expect(screen.queryByLabelText('行动名称')).not.toBeInTheDocument()
  })

  it('非本项目负责人的项目角色只读查看，不提供执行入口', async () => {
    useAuth.setState({ currentUser: users.find(u => u.id === 'u4')! })
    renderActions()
    await screen.findByText(proposal.title)
    expect(screen.getByText('项目负责人可核对并执行建议。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '核对并预览' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '从报告添加行动' })).not.toBeInTheDocument()
  })
})
