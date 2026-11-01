import { fireEvent, render, screen, within } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { ModelPricePicker } from './ModelPricePicker'

it('makes price, unit, date and source visible before selecting or calling a model', () => {
  const onSelect = vi.fn()
  render(<ModelPricePicker provider="kimi" baseUrl="https://api.moonshot.cn/v1" model="kimi-k3.1-pro" onSelect={onSelect} />)
  expect(screen.getByRole('combobox', { name: '预置模型与参考价' })).toHaveTextContent('输入 ¥13 / 输出 ¥68')
  const table = screen.getByRole('table')
  expect(within(table).getByRole('columnheader', { name: '缓存写入（1小时）' })).toBeInTheDocument()
  expect(within(table).getByText('¥26')).toBeInTheDocument()
  expect(screen.getByRole('region', { name: '模型参考价格' })).toHaveTextContent('2026-11-01')
  expect(screen.getByRole('link', { name: '官方定价' })).toHaveAttribute('href', 'https://platform.kimi.com/docs/pricing/chat')
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'kimi-k3' } })
  expect(onSelect).toHaveBeenCalledWith('kimi-k3')
})

it('clears old prices when switching to an unknown model or a third-party endpoint', () => {
  const view = render(<ModelPricePicker provider="kimi" baseUrl="https://api.moonshot.cn/v1" model="kimi-k3" onSelect={vi.fn()} />)
  view.rerender(<ModelPricePicker provider="kimi" baseUrl="https://relay.example/v1" model="kimi-k3" onSelect={vi.fn()} />)
  expect(screen.queryByRole('table')).not.toBeInTheDocument()
  expect(screen.getByRole('region')).toHaveTextContent('不代表免费')
  view.rerender(<ModelPricePicker provider="kimi" baseUrl="https://api.moonshot.cn/v1" model="unknown-model" onSelect={vi.fn()} />)
  expect(screen.queryByRole('table')).not.toBeInTheDocument()
})
