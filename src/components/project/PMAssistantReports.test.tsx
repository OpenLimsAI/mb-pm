import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { PMAssistant } from './PMAssistant'
import { PMAssistantReportResult } from './PMAssistantReportResult'
import { getAIStatus, generateFinanceAIAnalysis, getFinanceAIAnalyses, type AIAnalysis } from '../../api/ai'
import { startProjectAnalysis, listAnalysisJobs, getProjectAnalysis, getReportActions, cancelProjectAnalysis, type AnalysisJob } from '../../api/projectAIWork'
import { pmAI, type PMAgentPlan } from '../../api/pmAI'
import { useAuth } from '../../store/auth'
import { useDataStore } from '../../store/data'
import { users } from '../../mock'

vi.mock('../../api/ai', async original => ({ ...await original<typeof import('../../api/ai')>(), getAIStatus: vi.fn(), generateFinanceAIAnalysis: vi.fn(), getFinanceAIAnalyses: vi.fn() }))
vi.mock('../../api/projectAIWork', () => ({ startProjectAnalysis: vi.fn(), listAnalysisJobs: vi.fn(), getProjectAnalysis: vi.fn(), getReportActions: vi.fn(), cancelProjectAnalysis: vi.fn() }))
vi.mock('../../api/pmAI', () => ({ pmAI: { context: vi.fn(), list: vi.fn(), plan: vi.fn(), create: vi.fn() } }))

const status = { provider: 'deepseek' as const, model: 'test-model', ready: true, offlineFallback: false, analysisPrompt: '项目默认提示词', financeAnalysisPrompt: '财务默认提示词' }
const currentJob: AnalysisJob = { id: 'current-job', state: 'queued', focus: '本次请求', error: '', createdAt: '2026-11-15T10:00:00Z' }
const report: AIAnalysis = { id: 'current-report', projectId: 'P1', createdAt: '2026-11-15T10:00:00Z', provider: 'deepseek', model: 'test-model', focus: '本次请求', prompt: '项目默认提示词', content: '本次报告正文', stale: false, source: { asOf: '2026-11-15', budgetUnit: '万元' }, usage: { fallback: false } }
function plan(scenario: PMAgentPlan['scenario']): PMAgentPlan { return { scenario, status: 'ready', projectIds: scenario === 'finance' ? [] : ['P1'], taskIds: [], targets: [], choices: [], message: '', limit: 5 } }
function send(question: string) {
  fireEvent.change(screen.getByRole('textbox', { name: '告诉我你想做什么' }), { target: { value: question } })
  fireEvent.click(screen.getByRole('button', { name: '发送' }))
}

beforeEach(() => {
  vi.clearAllMocks()
  useAuth.setState({ currentUser: users.find(user => user.role === 'admin')! })
  useDataStore.setState({ mode: 'api', businessDate: '2026-11-15' })
  vi.mocked(pmAI.context).mockResolvedValue({ schemaVersion: 1, scope: { projectIds: ['P1'], taskIds: [] }, asOf: '2026-11-15', timezone: 'UTC', projects: [{ id: 'P1', code: 'P1', name: '本项目', ownerId: 'owner' }], tasks: [], members: [], subProjects: [], registerEntries: [], source: { schemaVersion: 1, complete: true, asOf: '2026-11-15', refs: [] } })
  vi.mocked(pmAI.list).mockResolvedValue({ items: [], total: 0 })
  vi.mocked(getAIStatus).mockResolvedValue(status)
  vi.mocked(startProjectAnalysis).mockResolvedValue(currentJob)
  vi.mocked(listAnalysisJobs).mockResolvedValue([{ ...currentJob, state: 'succeeded', analysisId: report.id }])
  vi.mocked(getProjectAnalysis).mockResolvedValue(report)
  vi.mocked(getReportActions).mockResolvedValue({ proposals: [], applied: [] })
})
afterEach(() => { vi.useRealTimers() })

test('综合评估只在明确发送时提交一次，并只打开本次后台任务关联报告', async () => {
  vi.mocked(pmAI.plan).mockResolvedValue(plan('assessment'))
  vi.mocked(listAnalysisJobs).mockResolvedValue([{ ...currentJob, id: 'old-job', state: 'succeeded', analysisId: 'old-report' }, { ...currentJob, state: 'succeeded', analysisId: report.id }])
  const view = render(<MemoryRouter><PMAssistant projectId="P1" standalone /></MemoryRouter>)
  expect(startProjectAnalysis).not.toHaveBeenCalled()
  expect(listAnalysisJobs).not.toHaveBeenCalled()
  send('请生成当前项目综合评估')
  expect(await screen.findByText('本次报告正文')).toBeInTheDocument()
  expect(startProjectAnalysis).toHaveBeenCalledExactlyOnceWith('P1', '请生成当前项目综合评估', '项目默认提示词')
  expect(getProjectAnalysis).toHaveBeenCalledWith('P1', 'current-report')
  expect(getProjectAnalysis).not.toHaveBeenCalledWith('P1', 'old-report')
  view.rerender(<MemoryRouter><PMAssistant projectId="P1" standalone /></MemoryRouter>)
  expect(startProjectAnalysis).toHaveBeenCalledOnce()
  expect(pmAI.create).not.toHaveBeenCalled()
})

test('组合财务一次发送直接生成；新问题不接受上一次迟到结果，也不读取旧财务历史', async () => {
  let finish: (value: AIAnalysis) => void = () => {}
  vi.mocked(pmAI.plan).mockResolvedValue(plan('finance'))
  vi.mocked(generateFinanceAIAnalysis).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  render(<MemoryRouter><PMAssistant standalone /></MemoryRouter>)
  expect(generateFinanceAIAnalysis).not.toHaveBeenCalled()
  send('分析全部可见项目的组合财务')
  await waitFor(() => expect(generateFinanceAIAnalysis).toHaveBeenCalledExactlyOnceWith('分析全部可见项目的组合财务', '财务默认提示词'))
  fireEvent.click(screen.getByRole('button', { name: '新问题' }))
  await act(async () => finish({ ...report, projectId: undefined, content: '旧财务回答' }))
  expect(screen.queryByText('旧财务回答')).not.toBeInTheDocument()
  expect(getFinanceAIAnalyses).not.toHaveBeenCalled()
})

test('本地编辑综合报告可以清空草稿，原报告与服务端记录不改变', () => {
  render(<MemoryRouter><PMAssistantReportResult value={{ kind: 'finance', question: '本次财务问题', report }} disabled={false} /></MemoryRouter>)
  fireEvent.click(screen.getByRole('button', { name: '编辑草稿' }))
  const editor = screen.getByRole('textbox', { name: '编辑报告草稿' })
  fireEvent.change(editor, { target: { value: '' } })
  expect(editor).toHaveValue('')
  fireEvent.click(screen.getByRole('button', { name: '完成编辑' }))
  expect(screen.queryByText('本次报告正文')).not.toBeInTheDocument()
  expect(report.content).toBe('本次报告正文')
  expect(startProjectAnalysis).not.toHaveBeenCalled()
  expect(generateFinanceAIAnalysis).not.toHaveBeenCalled()
})

test('取消请求失败后仍继续读取本次后台任务，不丢失完成结果', async () => {
  vi.useFakeTimers()
  vi.mocked(listAnalysisJobs).mockResolvedValueOnce([{ ...currentJob, state: 'running' }]).mockResolvedValue([{ ...currentJob, state: 'succeeded', analysisId: report.id }])
  vi.mocked(cancelProjectAnalysis).mockRejectedValueOnce(new Error('取消请求未送达'))
  render(<MemoryRouter><PMAssistantReportResult value={{ kind: 'project', question: '本次项目评估', projectId: 'P1', job: currentJob }} disabled={false} /></MemoryRouter>)
  await act(async () => { await Promise.resolve() })
  fireEvent.click(screen.getByRole('button', { name: '停止整理' }))
  await act(async () => { await Promise.resolve() })
  await act(async () => { await vi.advanceTimersByTimeAsync(4500) })
  expect(listAnalysisJobs).toHaveBeenCalledTimes(2)
  expect(screen.getByText('本次报告正文')).toBeInTheDocument()
})

test('报告读取被拒绝时停止等待提示，不显示其他报告或继续提交生成', async () => {
  vi.mocked(getProjectAnalysis).mockRejectedValueOnce({ isAxiosError: true, response: { status: 403, data: { detail: '当前账号不能读取该报告' } }, message: 'Forbidden' })
  render(<MemoryRouter><PMAssistantReportResult value={{ kind: 'project', question: '本次项目评估', projectId: 'P1', job: currentJob }} disabled={false} /></MemoryRouter>)
  expect(await screen.findByRole('alert')).toHaveTextContent('当前账号不能读取该报告')
  expect(screen.queryByText(/正在整理本次报告/)).not.toBeInTheDocument()
  expect(screen.queryByText('本次报告正文')).not.toBeInTheDocument()
  expect(startProjectAnalysis).not.toHaveBeenCalled()
})
