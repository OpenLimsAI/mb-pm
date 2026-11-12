import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { api } from '../../api/client'
import { AgentProposalReview } from './AgentProposalReview'

afterEach(() => vi.restoreAllMocks())

const preview = {
  id: 'proposal-1', kind: 'schedule', state: 'pending_confirmation', reason: '实验延期',
  reviewKey: 'a'.repeat(64), changes: [{ title: '稳定性试验', before: { '完成日期': '2026-11-10' }, after: { '完成日期': '2026-11-13' } }],
}
const applied = { ...preview, state: 'applied', reviewKey: null, result: { receiptId: 'receipt-1', url: '/projects/p1?tab=wbs&task=t1' } }

it('shows the affected task before confirmation and recovers a committed result after a lost response', async () => {
  vi.spyOn(api, 'get').mockResolvedValueOnce({ data: preview }).mockResolvedValueOnce({ data: applied })
  const post = vi.spyOn(api, 'post').mockRejectedValueOnce(new Error('连接中断'))
  const onApplied = vi.fn()
  render(<AgentProposalReview projectId="p1" proposalId="proposal-1" onClose={vi.fn()} onApplied={onApplied} />)
  expect(await screen.findByText('稳定性试验')).toBeVisible()
  expect(screen.getByText('2026-11-10')).toBeVisible()
  expect(screen.getByText('2026-11-13')).toBeVisible()
  expect(post).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '确认执行提案' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('连接中断')
  expect(post).toHaveBeenCalledWith('/project-ai/projects/p1/agent-proposals/proposal-1', { reviewKey: preview.reviewKey })
  expect(screen.queryByRole('button', { name: '确认执行提案' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '重新查询状态' }))
  expect(await screen.findByText('执行回执：receipt-1')).toBeVisible()
  expect(screen.getByRole('link', { name: '查看更新后的记录' })).toHaveAttribute('href', applied.result.url)
  expect(onApplied).toHaveBeenCalledOnce()
  expect(post).toHaveBeenCalledOnce()
})
