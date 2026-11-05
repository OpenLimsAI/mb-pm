import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAIStatus, type AIAnalysis } from '../../api/ai'
import { cancelProjectAnalysis, getProjectAnalysis, getReportActions, listAnalysisJobs, searchProjectAnalyses, startProjectAnalysis, type AnalysisJob } from '../../api/projectAIWork'
import { useAuth } from '../../store/auth'
import { useDataStore } from '../../store/data'
import { users } from '../../mock'
import { ProjectAIAnalysis } from './ProjectAIAnalysis'

vi.mock('../../api/ai', async () => ({ ...await vi.importActual('../../api/ai'), getAIStatus: vi.fn() }))
vi.mock('../../api/projectAIWork', () => ({
  getReportActions: vi.fn(), getProjectAnalysis: vi.fn(), listAnalysisJobs: vi.fn(), searchProjectAnalyses: vi.fn(),
  startProjectAnalysis: vi.fn(), cancelProjectAnalysis: vi.fn(),
}))

const status = { provider: 'deepseek' as const, model: 'test-model', ready: true, offlineFallback: false, analysisPrompt: '分析项目', financeAnalysisPrompt: '' }
const report = (id: string, focus: string, content: string): AIAnalysis => ({
  id, projectId: 'p1', createdAt: '2026-11-04T12:00:00Z', provider: 'deepseek', model: 'test-model', focus,
  prompt: '分析项目', content, stale: false, source: { asOf: '2026-11-04', budgetUnit: '万元' }, usage: { fallback: false },
})
const first = report('r1', '第一轮关注', '第一轮正文：关注上游风险。')
const second = report('r2', '第二轮关注', '第二轮正文：进展已改善。')
const job: AnalysisJob = { id: 'j1', state: 'running', createdAt: '2026-11-04T12:00:00Z', focus: '后台关注事项', error: '' }
const renderWorkbench = () => render(<MemoryRouter><ProjectAIAnalysis projectId="p1" projectName="测试项目" /></MemoryRouter>)

beforeEach(() => {
  vi.mocked(getAIStatus).mockResolvedValue(status)
  vi.mocked(getReportActions).mockResolvedValue({ proposals: [], applied: [] })
  vi.mocked(listAnalysisJobs).mockResolvedValue([])
  vi.mocked(searchProjectAnalyses).mockResolvedValue({ items: [], total: 0, page: 1 })
  useAuth.setState({ currentUser: users[0], status: 'ready' })
  useDataStore.setState({ mode: 'api', ready: true })
})
afterEach(() => {
  // Unmount before resetting mocks or stores so pending effects cannot call a reset mock.
  cleanup()
  vi.resetAllMocks()
  vi.unstubAllGlobals()
  useAuth.setState({ currentUser: null, status: 'loading' })
  useDataStore.setState({ mode: 'loading', ready: false })
})

describe('项目 AI 后台与历史工作流', () => {
  it('正文、对比与导出隐藏行动JSON和截断块，建议卡仍然可见', async () => {
    const closed = report('closed', '完整建议报告', '可读分析结论。\n\n```pm-actions\n[{"title":"machine-only-closed"}]\n```')
    const truncated = report('truncated', '截断建议报告', '另一份可读结论。\n\n```pm-actions\n[{"title":"machine-only-truncated')
    vi.mocked(searchProjectAnalyses).mockResolvedValue({ items: [closed, truncated], total: 2, page: 1 })
    vi.mocked(getReportActions).mockResolvedValue({ proposals: [{ actionKey: 'suggestion-0', kind: 'risk', title: '核对试验资源' }], applied: [] })
    renderWorkbench()
    expect(await screen.findByText('可读分析结论。')).toBeInTheDocument()
    expect(await screen.findByText('核对试验资源')).toBeInTheDocument()
    expect(screen.queryByText(/machine-only/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '加入对比' }))
    fireEvent.click(screen.getByRole('button', { name: /截断建议报告/ }))
    const comparison = screen.getByRole('region', { name: '分析报告对比' })
    expect(within(comparison).getByText('可读分析结论。')).toBeInTheDocument()
    expect(within(comparison).getByText('另一份可读结论。')).toBeInTheDocument()
    expect(screen.queryByText(/machine-only/)).not.toBeInTheDocument()
    let exported: Blob | null = null
    const revoke = vi.fn()
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL(value: Blob | MediaSource) { if (value instanceof Blob) exported = value; return 'blob:project-analysis' }
      static revokeObjectURL = revoke
    })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    fireEvent.click(screen.getByRole('button', { name: '导出' }))
    expect(exported).not.toBeNull()
    const markdown = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = reject
      reader.readAsText(exported!)
    })
    expect(markdown).toContain('另一份可读结论。')
    expect(markdown).not.toMatch(/pm-actions|machine-only/)
    await waitFor(() => expect(revoke).toHaveBeenCalledWith('blob:project-analysis'), { timeout: 2000 })
  })

  it('离开页面不取消后台任务，返回后从服务端恢复状态与结果', async () => {
    vi.mocked(listAnalysisJobs).mockResolvedValue([job])
    const view = renderWorkbench()
    expect(await screen.findByText('生成中')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '后台分析进行中' })).toBeDisabled()
    view.unmount()
    expect(cancelProjectAnalysis).not.toHaveBeenCalled()
    vi.mocked(listAnalysisJobs).mockResolvedValue([{ ...job, state: 'succeeded', analysisId: 'r1' }])
    vi.mocked(searchProjectAnalyses).mockResolvedValue({ items: [first], total: 1, page: 1 })
    renderWorkbench()
    expect(await screen.findByText('已完成')).toBeInTheDocument()
    expect(await screen.findByText(first.content)).toBeInTheDocument()
    expect(startProjectAnalysis).not.toHaveBeenCalled()
  })

  it('发起后显示持久化排队任务，取消明确提交到后台', async () => {
    vi.mocked(startProjectAnalysis).mockResolvedValue({ ...job, state: 'queued' })
    vi.mocked(listAnalysisJobs).mockImplementation(async () => vi.mocked(startProjectAnalysis).mock.calls.length ? [{ ...job, state: 'queued' }] : [])
    vi.mocked(cancelProjectAnalysis).mockResolvedValue({ ...job, state: 'cancelled' })
    renderWorkbench()
    const start = await screen.findByRole('button', { name: '生成后台分析' })
    await waitFor(() => expect(start).toBeEnabled())
    fireEvent.change(screen.getByLabelText('本次重点关注'), { target: { value: '核对里程碑' } })
    fireEvent.click(start)
    expect(await screen.findByText('排队中')).toBeInTheDocument()
    expect(startProjectAnalysis).toHaveBeenCalledWith('p1', '核对里程碑', '分析项目')
    vi.mocked(listAnalysisJobs).mockResolvedValue([{ ...job, state: 'cancelled' }])
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(await screen.findByText('已取消')).toBeInTheDocument()
    expect(cancelProjectAnalysis).toHaveBeenCalledWith('p1', 'j1')
  })

  it('历史可跨报告对比；搜索后显示匹配报告，刷新不会意外提交尚未提交的搜索词', async () => {
    vi.mocked(searchProjectAnalyses).mockImplementation(async (_id, keyword) => ({ items: keyword ? [second] : [first, second], total: keyword ? 1 : 2, page: 1 }))
    renderWorkbench()
    await screen.findByText(first.content)
    fireEvent.click(screen.getByRole('button', { name: '加入对比' }))
    fireEvent.click(screen.getByRole('button', { name: /第二轮关注/ }))
    const comparison = screen.getByRole('region', { name: '分析报告对比' })
    expect(within(comparison).getByText(first.content)).toBeInTheDocument()
    expect(within(comparison).getByText(second.content)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('搜索项目分析记录'), { target: { value: '尚未提交' } })
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await waitFor(() => expect(vi.mocked(searchProjectAnalyses).mock.lastCall).toEqual(['p1', '', 1]))
    fireEvent.click(screen.getByRole('button', { name: '搜索历史' }))
    await waitFor(() => expect(vi.mocked(searchProjectAnalyses).mock.lastCall).toEqual(['p1', '尚未提交', 1]))
    expect(await screen.findByText('共 1 份报告')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /第一轮关注/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '关闭对比' }))
    expect(screen.queryByText(first.content)).not.toBeInTheDocument()
    expect(screen.getByText(second.content)).toBeInTheDocument()
  })

  it('查看后台任务精确打开其报告，即使该报告不在第一页', async () => {
    const older = report('older', '较早任务', '这才是所选后台任务的结果。')
    vi.mocked(listAnalysisJobs).mockResolvedValue([{ ...job, state: 'succeeded', analysisId: 'older' }])
    vi.mocked(searchProjectAnalyses).mockResolvedValue({ items: [first], total: 30, page: 1 })
    vi.mocked(getProjectAnalysis).mockResolvedValue(older)
    renderWorkbench()
    fireEvent.click(await screen.findByRole('button', { name: '查看记录' }))
    expect(await screen.findByText(older.content)).toBeInTheDocument()
    expect(getProjectAnalysis).toHaveBeenCalledWith('p1', 'older')
    expect(screen.queryByText(first.content)).not.toBeInTheDocument()
  })

  it('AI 状态加载失败保持错误提示，重试会重新加载状态并恢复入口', async () => {
    vi.mocked(getAIStatus).mockRejectedValueOnce(new Error('配置暂不可用')).mockResolvedValue(status)
    renderWorkbench()
    expect(await screen.findByRole('alert')).toHaveTextContent('配置暂不可用')
    fireEvent.click(screen.getByRole('button', { name: '重试加载' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '生成后台分析' })).toBeEnabled())
    expect(getAIStatus).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('切换项目卸下旧报告及对比，迟到响应不能显示到新项目', async () => {
    vi.mocked(searchProjectAnalyses).mockResolvedValue({ items: [first], total: 1, page: 1 })
    const view = renderWorkbench()
    await screen.findByText(first.content)
    fireEvent.click(screen.getByRole('button', { name: '加入对比' }))
    const next = { ...second, projectId: 'p2' }
    vi.mocked(searchProjectAnalyses).mockResolvedValue({ items: [next], total: 1, page: 1 })
    view.rerender(<MemoryRouter><ProjectAIAnalysis projectId="p2" projectName="第二项目" /></MemoryRouter>)
    expect(await screen.findByText(second.content)).toBeInTheDocument()
    expect(screen.queryByText(first.content)).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '分析报告对比' })).not.toBeInTheDocument()
  })
})
