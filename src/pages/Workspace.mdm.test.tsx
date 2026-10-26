import { render, screen, cleanup } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import Workspace from './Workspace'

afterEach(cleanup)
function show(enabled: boolean) {
  render(<MemoryRouter><Workspace user={{ id: 'test', username: 'test', displayName: '测试用户' }} applications={[{ id: 'mdm', enabled, reason: 'MDM 尚未配置' }]} onRefresh={vi.fn()} onLogout={vi.fn()} /></MemoryRouter>)
}
test('MDM entry explains independent login and does not launch while disabled', () => {
  show(false)
  expect(screen.getByRole('heading', { name: '主数据管理' })).toBeInTheDocument()
  expect(screen.getByText('MDM 尚未配置')).toBeInTheDocument()
  expect(screen.queryByRole('link', { name: /进入主数据管理/ })).not.toBeInTheDocument()
})
test('enabled MDM card launches only through protected backend route without credentials', () => {
  show(true)
  const link = screen.getByRole('link', { name: /进入主数据管理/ })
  expect(link).toHaveAttribute('href', '/launch/mdm')
  expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  expect(screen.getByText('独立 MDM 登录')).toBeInTheDocument()
})
