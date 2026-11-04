import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import ArtifactNavigator from './ArtifactNavigator'
import type { AssistantArtifact, AssistantMessage } from './client'

function fixture(count = 7) {
  const artifacts: AssistantArtifact[] = Array.from({ length: count }, (_, index) => ({ id: `a${index + 1}`, title: index < 2 ? '同一个问题的不同回答' : `第 ${index + 1} 份研究结果`, content: '回答正文', model: index % 2 ? 'kimi-k3.1-pro' : 'deepseek-v4-pro', createdAt: `2026-11-04T12:0${index}:00Z` }))
  const messages: AssistantMessage[] = artifacts.flatMap(artifact => (['user', 'assistant'] as const).map(role => ({ id: role === 'assistant' ? artifact.id : `u${artifact.id}`, role, requestId: artifact.id, content: '对话', context: '', model: artifact.model, mode: 'ai', createdAt: artifact.createdAt })))
  return { artifacts, messages }
}

describe('ArtifactNavigator', () => {
  it('exposes all seven artifacts as distinct cards and keeps the selected/final result visible', async () => {
    const data = fixture(), onSelect = vi.fn(), user = userEvent.setup()
    const { rerender } = render(<ArtifactNavigator {...data} activeId="a7" finalArtifactId="a2" onSelect={onSelect} />)
    const nav = screen.getByRole('navigation', { name: '产物列表' })
    expect(within(nav).getByRole('heading', { name: '全部产物 7' })).toBeInTheDocument()
    expect(within(nav).queryByRole('combobox')).not.toBeInTheDocument()
    const cards = within(nav).getAllByRole('button', { name: /^查看产物/ })
    expect(cards).toHaveLength(7)
    expect(cards[0]).toHaveAccessibleName('查看产物：第 7 份研究结果（第 7 轮）')
    expect(cards[0]).toHaveAttribute('aria-pressed', 'true')
    const second = within(nav).getByRole('button', { name: '查看产物：同一个问题的不同回答（第 2 轮）' })
    expect(second).toHaveTextContent('最终成果')
    expect(second).toHaveTextContent('kimi-k3.1-pro')
    second.focus()
    await user.keyboard('{Enter}')
    expect(onSelect).toHaveBeenCalledWith('a2')
    rerender(<ArtifactNavigator {...data} activeId="a2" finalArtifactId="a2" onSelect={onSelect} />)
    expect(second).toHaveAttribute('aria-pressed', 'true')
    expect(cards[0]).toHaveAttribute('aria-pressed', 'false')
  })

  it('finds titles or model names without changing the current result and recovers from an empty filter', () => {
    const data = fixture(), onSelect = vi.fn()
    render(<ArtifactNavigator {...data} activeId="a7" onSelect={onSelect} />)
    const input = screen.getByRole('searchbox', { name: '查找产物' })
    fireEvent.change(input, { target: { value: 'KIMI' } })
    expect(screen.getAllByRole('button', { name: /^查看产物/ })).toHaveLength(3)
    expect(screen.getByRole('status')).toHaveTextContent('找到 3 / 7 份产物')
    fireEvent.change(input, { target: { value: '第 7 份' } })
    expect(screen.getAllByRole('button', { name: /^查看产物/ })).toHaveLength(1)
    fireEvent.change(input, { target: { value: '不存在的标题' } })
    expect(screen.queryByRole('button', { name: /^查看产物/ })).not.toBeInTheDocument()
    expect(screen.getByText('没有匹配的产物，请更换关键词。')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '清除产物搜索' }))
    expect(screen.getAllByRole('button', { name: /^查看产物/ })).toHaveLength(7)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('uses actual conversation rounds instead of artifact positions for unmatched historical messages', () => {
    const data = fixture(2)
    data.messages[1].requestId = 'legacy-unmatched'
    render(<ArtifactNavigator {...data} activeId="a2" onSelect={vi.fn()} />)
    expect(screen.getByRole('button', { name: '查看产物：同一个问题的不同回答（第 2 轮）' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '查看产物：同一个问题的不同回答（第 3 轮）' })).toBeInTheDocument()
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
  })

  it('reveals an external selection hidden by a filter but preserves the filter for matching cards', () => {
    const data = fixture(), onSelect = vi.fn()
    const { rerender } = render(<ArtifactNavigator {...data} activeId="a2" onSelect={onSelect} />)
    const input = screen.getByRole('searchbox', { name: '查找产物' })
    fireEvent.change(input, { target: { value: 'kimi' } })
    rerender(<ArtifactNavigator {...data} activeId="a4" onSelect={onSelect} />)
    expect(input).toHaveValue('kimi')
    expect(screen.getAllByRole('button', { name: /^查看产物/ })).toHaveLength(3)
    rerender(<ArtifactNavigator {...data} activeId="a7" onSelect={onSelect} />)
    expect(input).toHaveValue('')
    expect(screen.getByRole('button', { name: '查看产物：第 7 份研究结果（第 7 轮）' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getAllByRole('button', { name: /^查看产物/ })).toHaveLength(7)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('handles missing message links or invalid dates without inventing a round or failing', () => {
    const data = fixture(1)
    data.artifacts[0].createdAt = 'invalid'
    const { container } = render(<ArtifactNavigator artifacts={data.artifacts} messages={[]} activeId="a1" onSelect={vi.fn()} />)
    expect(screen.getByRole('button', { name: '查看产物：同一个问题的不同回答（产物 1）' })).toBeInTheDocument()
    expect(container.querySelector('time')).toBeNull()
  })

  it('lets the parent present the empty-artifact state', () => {
    render(<ArtifactNavigator artifacts={[]} messages={[]} onSelect={vi.fn()} />)
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
  })
})
