import { render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import ApplicationActions from './ApplicationActions'

afterEach(() => { localStorage.clear() })
it('shows the workspace and signed-in account, even with a saved dark theme', () => {
  localStorage.setItem('maibo.application.theme', 'dark')
  render(<ApplicationActions userName="郭清城" preview={false} />)
  const feedback = screen.getByRole('link', { name: '回音壁（新标签页打开）' })
  const workspace = screen.getByRole('link', { name: '应用工作台' })
  expect(workspace).toHaveAttribute('href', '/')
  expect(workspace).toHaveTextContent('工作台')
  expect(feedback).toHaveTextContent('回音壁')
  expect(feedback).toHaveAttribute('target', '_blank')
  expect(feedback).toHaveAttribute('rel', 'noopener noreferrer')
  expect(feedback.compareDocumentPosition(workspace) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(screen.queryByText('当前登录账号')).not.toBeInTheDocument()
  expect(screen.getByRole('link', { name: '郭清城 · 我的设置' })).toHaveAttribute('href', '/settings')
  expect(screen.queryByRole('button', { name: '退出登录' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '切换主题' })).not.toBeInTheDocument()
  expect(document.documentElement.dataset.applicationTheme).toBeUndefined()
})

it('preserves the application source without copying private URL parameters', () => {
  render(<ApplicationActions userName="测试同事" preview application="notes" page={{ pathname: '/notes', hash: '#access_token=private' }} />)
  const feedback = screen.getByRole('link', { name: '回音壁（新标签页打开）' })
  const url = new URL(feedback.getAttribute('href')!, window.location.origin)
  expect(Object.fromEntries(url.searchParams)).toEqual({ compose: '1', preview: '1', application: 'notes', source_path: '/notes' })
  expect(url.href).not.toContain('private')
  expect(screen.getByRole('link', { name: '应用工作台' })).toHaveAttribute('href', '/?preview=1')
})
