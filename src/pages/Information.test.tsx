import { render, screen } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { server } from '../test/setup'
import { usePortal } from '../store/portal'

vi.mock('../api/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('../api/client')>(),
  USE_API: true,
}))

afterEach(() => {
  usePortal.setState({ status: 'loading', user: null, identityNamespace: undefined, applications: [], mustChangePassword: false })
  window.history.replaceState({}, '', '/')
})

describe('retired information application', () => {
  it.each([true, false])('keeps saved direct links retired with catalogue grant %s', async (enabled) => {
    let informationCalls = 0
    server.use(http.get('*/api/v1/portal/me', () => HttpResponse.json({
      user: { id: 'verified-person', username: 'reader', display_name: '李同事' },
      identity_namespace: 'b'.repeat(64), applications: [{ id: 'information', enabled }],
      must_change_password: false, can_configure_ai: false,
    })))
    server.use(http.get('*/api/v1/information/snapshot', () => {
      informationCalls += 1
      return HttpResponse.json({})
    }))
    window.history.replaceState({}, '', '/information/library')
    render(<App />)
    expect(await screen.findByRole('heading', { name: '行业信息已下线' })).toBeInTheDocument()
    expect(screen.getByText('知识源正在重新设计，已有论文、文件夹与原文资料保留。')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '应用工作台' })).toHaveAttribute('href', '/')
    expect(informationCalls).toBe(0)
  })

  it('keeps the legacy launch URL retired without redirecting', async () => {
    server.use(http.get('*/api/v1/portal/me', () => HttpResponse.json({
      user: { id: 'verified-person', username: 'reader', display_name: '李同事' },
      identity_namespace: 'b'.repeat(64), applications: [{ id: 'information', enabled: true }],
      must_change_password: false, can_configure_ai: false,
    })))
    window.history.replaceState({}, '', '/launch/information')
    render(<App />)
    expect(await screen.findByText('行业信息已下线，知识源正在重新设计。已有资料保留。')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /返回工作台/ })).toHaveAttribute('href', '/')
  })
})
