import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { getAIStatus, type AIAnalysis } from '../../api/ai'
import { useDataStore } from '../../store/data'
import { useAuth } from '../../store/auth'
import { AIAnalysisPanel } from './AIAnalysisPanel'

vi.mock('../../api/ai', async importOriginal => ({
  ...await importOriginal<typeof import('../../api/ai')>(),
  getAIStatus: vi.fn(),
}))

afterEach(() => { vi.restoreAllMocks(); localStorage.removeItem('mb-pm:analysis-history-width:anonymous') })

test('异步报告加载后可调记录栏宽度，切换报告保留宽度，重新打开恢复偏好并可重置', async () => {
  useDataStore.setState({ mode: 'api' })
  useAuth.setState({ currentUser: null })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000)
  vi.mocked(getAIStatus).mockResolvedValue({ provider: 'deepseek', model: 'model', ready: true, offlineFallback: false, analysisPrompt: '', financeAnalysisPrompt: '' })
  const records: AIAnalysis[] = [1, 2].map(index => ({
    id: `report-${index}`, createdAt: `2026-11-0${index}T00:00:00Z`, provider: 'deepseek',
    model: '完整的模型名称', focus: `第${index}份报告的完整关注事项`, prompt: '',
    content: `报告正文 ${index}`, stale: false, source: { asOf: '2026-11-03', budgetUnit: '万元' },
    usage: { fallback: false },
  }))
  const load = vi.fn().mockResolvedValue(records)
  const panel = <AIAnalysisPanel kind="project" title="项目分析" description="说明" subject="项目" focusPlaceholder="输入关注事项" dataNotice="数据快照" emptyHint="开始分析" staleNotice="数据已更新" tags={() => []} load={load} generate={vi.fn()} />
  const view = render(panel)
  const handle = await screen.findByRole('separator', { name: '调整分析记录栏宽度' })
  fireEvent.keyDown(handle, { key: 'ArrowRight' })
  expect(handle).toHaveAttribute('aria-valuenow', '236')
  const older = screen.getByRole('button', { name: /第2份报告的完整关注事项/ })
  fireEvent.click(older)
  expect(screen.getByText('报告正文 2')).toBeInTheDocument()
  expect(handle).toHaveAttribute('aria-valuenow', '236')
  expect(localStorage.getItem('mb-pm:analysis-history-width:anonymous')).toBe('236')
  view.unmount()
  render(panel)
  const restored = await screen.findByRole('separator', { name: '调整分析记录栏宽度' })
  expect(restored).toHaveAttribute('aria-valuenow', '236')
  fireEvent.doubleClick(restored)
  expect(restored).toHaveAttribute('aria-valuenow', '220')
  expect(localStorage.getItem('mb-pm:analysis-history-width:anonymous')).toBeNull()
})
