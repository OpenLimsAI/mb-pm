import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { api } from '../../api/client'
import { AgentRiskReportReview } from './AgentRiskReportReview'

afterEach(() => vi.restoreAllMocks())

it('requires a new review after tasks change and only saves on confirmation', async () => {
  const original = 'a'.repeat(64)
  const current = 'b'.repeat(64)
  vi.spyOn(api, 'get')
    .mockResolvedValueOnce({ data: { reviewKey: original, content: '原逾期任务' } })
    .mockResolvedValueOnce({ data: { reviewKey: current, content: '更新后的逾期任务' } })
  const save = vi.spyOn(api, 'post')
    .mockRejectedValueOnce({ isAxiosError: true, response: { status: 409, data: { detail: '任务数据已变化' } } })
    .mockResolvedValueOnce({ data: { reportId: 'saved-report' } })
  const onSaved = vi.fn()
  render(<AgentRiskReportReview projectId="p1" expectedKey={original} onClose={vi.fn()} onSaved={onSaved} />)
  expect(await screen.findByText('原逾期任务')).toBeInTheDocument()
  expect(save).not.toHaveBeenCalled()
  const button = screen.getByRole('button', { name: '确认保存到分析记录' })
  fireEvent.click(button)
  expect(await screen.findByRole('alert')).toHaveTextContent('任务数据已变化')
  expect(button).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: '重新读取' }))
  expect(await screen.findByText('更新后的逾期任务')).toBeInTheDocument()
  expect(save).toHaveBeenCalledTimes(1)
  fireEvent.click(button)
  expect(await screen.findByText('确认保存到分析记录')).toBeEnabled()
  expect(save).toHaveBeenLastCalledWith('/project-ai/projects/p1/agent-risk-report', { reviewKey: current })
  expect(onSaved).toHaveBeenCalledWith('saved-report')
})
