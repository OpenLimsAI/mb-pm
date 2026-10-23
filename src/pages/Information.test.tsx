import { render, screen } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { server } from '../test/setup'
import { usePortal } from '../store/portal'

// This suite exercises authenticated portal routing, independently of a developer's
// ignored .env.local or CI's default API-off preview configuration.
vi.mock('../api/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('../api/client')>(),
  USE_API: true,
}))

afterEach(() => {
  usePortal.setState({ status: 'loading', user: null, identityNamespace: undefined, applications: [], mustChangePassword: false })
  window.history.replaceState({}, '', '/')
})

describe('information portal integration', () => {
  it('uses portal identity without loading PM, knowledge or collector APIs', async () => {
    const calls: string[] = []
    server.use(http.get('*/api/v1/portal/me', () => {
      calls.push('portal/me')
      return HttpResponse.json({
        user: { id: 'verified-person', username: 'reader', display_name: '李同事' },
        identity_namespace: 'b'.repeat(64), applications: [{ id: 'information', enabled: true }],
        must_change_password: false, can_configure_ai: false,
      })
    }))
    window.history.replaceState({}, '', '/information')
    render(<App />)
    expect(await screen.findByRole('heading', { name: '信息源', level: 1 })).toBeInTheDocument()
    expect(screen.getByText('李同事')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '应用工作台' })).toHaveAttribute('href', '/')
    expect(screen.getByText(/真实采集、知识库同步和 AI 尚未接入/)).toBeInTheDocument()
    expect(calls).toEqual(['portal/me'])
  })

  it('rejects an unauthorized catalogue without mounting the demo', async () => {
    server.use(http.get('*/api/v1/portal/me', () => HttpResponse.json({
      user: { id: 'blocked-person', username: 'blocked', display_name: '同事' },
      identity_namespace: 'c'.repeat(64), applications: [{ id: 'information', enabled: false }],
    })))
    window.history.replaceState({}, '', '/information')
    render(<App />)
    expect(await screen.findByRole('heading', { name: '信息获取暂时不可用' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'ICH 官方指导原则' })).not.toBeInTheDocument()
  })
})
