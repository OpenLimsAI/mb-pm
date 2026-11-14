import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, expect, test, vi } from 'vitest'
import { PMAssistant } from './PMAssistant'
import { api } from '../../api/client'
import { getAIStatus } from '../../api/ai'
import { getProjectAnalysis, getReportActions, listAnalysisJobs, searchProjectAnalyses } from '../../api/projectAIWork'
import { useAuth } from '../../store/auth'
import { useDataStore } from '../../store/data'
import { users } from '../../mock'

vi.mock('../../api/client', async original => ({ ...await original<typeof import('../../api/client')>(), api: { get: vi.fn(), post: vi.fn() } }))
vi.mock('../../api/ai', async original => ({ ...await original<typeof import('../../api/ai')>(), getAIStatus: vi.fn() }))
vi.mock('../../api/projectAIWork', () => ({ getProjectAnalysis: vi.fn(), getReportActions: vi.fn(), listAnalysisJobs: vi.fn(), searchProjectAnalyses: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
  useAuth.setState({ currentUser: users.find(user => user.role === 'admin')! })
  useDataStore.setState({ mode: 'api' })
  vi.mocked(getAIStatus).mockResolvedValue({ provider: 'deepseek', model: 'test', ready: true, offlineFallback: false, analysisPrompt: '分析项目', financeAnalysisPrompt: '' })
  vi.mocked(listAnalysisJobs).mockResolvedValue([])
  vi.mocked(searchProjectAnalyses).mockResolvedValue({ items: [], total: 0, page: 1 })
  vi.mocked(getReportActions).mockResolvedValue({ proposals: [], applied: [] })
})

test('核对报告保存后留在综合评估并直接打开已保存报告，即使当前历史页未列出该报告', async () => {
  const key = 'a'.repeat(64)
  vi.mocked(api.get).mockResolvedValue({ data: { content: '待核对的逾期报告', reviewKey: key } })
  vi.mocked(api.post).mockResolvedValue({ data: { reportId: 'saved-report' } })
  vi.mocked(getProjectAnalysis).mockResolvedValue({ id: 'saved-report', projectId: 'P1', provider: 'deepseek', model: 'test', createdAt: '2026-11-14', focus: '', prompt: '', content: '刚刚保存的完整报告', stale: false, source: { asOf: '2026-11-14', budgetUnit: '万元' }, usage: { fallback: false } })
  render(<MemoryRouter initialEntries={[`/projects/P1?assistant=assessment&agent_report=${key}`]}><PMAssistant projectId="P1" /></MemoryRouter>)
  const save = await screen.findByRole('button', { name: '确认保存到分析记录' })
  await waitFor(() => expect(save).toBeEnabled())
  fireEvent.click(save)
  expect(await screen.findByText('刚刚保存的完整报告')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '综合评估' })).toHaveAttribute('aria-pressed', 'true')
  await waitFor(() => expect(screen.queryByRole('region', { name: '核对逾期任务报告' })).not.toBeInTheDocument())
  await waitFor(() => expect(getProjectAnalysis).toHaveBeenCalledWith('P1', 'saved-report'))
  expect(api.post).toHaveBeenCalledTimes(1)
})
