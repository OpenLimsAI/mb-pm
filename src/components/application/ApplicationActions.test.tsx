import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import ApplicationActions from './ApplicationActions'

afterEach(() => { localStorage.clear(); delete document.documentElement.dataset.applicationTheme })
it('shows the workspace and signed-in account, and persists a reversible theme choice', () => {
  const first = render(<ApplicationActions userName="郭清城" preview={false} />)
  expect(screen.getByRole('link', { name: '应用工作台' })).toHaveAttribute('href', '/')
  expect(screen.getByRole('link', { name: '郭清城 · 我的设置' })).toHaveAttribute('href', '/settings')
  expect(screen.queryByRole('button', { name: '退出登录' })).not.toBeInTheDocument()
  const toggle = screen.getByRole('button', { name: '切换主题' })
  fireEvent.click(toggle)
  expect(toggle).toHaveAttribute('aria-pressed', 'true')
  expect(document.documentElement.dataset.applicationTheme).toBe('dark')
  expect(localStorage.getItem('maibo.application.theme')).toBe('dark')
  first.unmount()
  render(<ApplicationActions userName="郭清城" preview />)
  expect(screen.getByRole('button', { name: '切换主题' })).toHaveAttribute('aria-pressed', 'true')
  fireEvent.click(screen.getByRole('button', { name: '切换主题' }))
  expect(document.documentElement.dataset.applicationTheme).toBe('light')
})
