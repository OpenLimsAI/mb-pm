import { render, screen, waitFor } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { afterEach, expect, it, vi } from 'vitest'
import App from '../App'
import { server } from '../test/setup'
import { usePortal } from '../store/portal'
vi.mock('../api/client', async original => ({ ...await original<typeof import('../api/client')>(), USE_API: true }))
afterEach(() => { usePortal.setState({ status: 'loading', user: null, identityNamespace: undefined, applications: [], mustChangePassword: false }); window.history.replaceState({}, '', '/') })
it('opens independent notes with portal login even if paper KB access is denied', async () => {
  const calls: string[] = []
  server.use(http.get('*/api/v1/portal/me', () => {
    calls.push('portal/me')
    return HttpResponse.json({ user: { id: 'person', username: 'reader', display_name: '研究员' }, identity_namespace: 'issuer', applications: [{ id: 'notes', enabled: true }, { id: 'kb', enabled: false }], must_change_password: false })
  }))
  server.use(http.get('*/api/v1/notes', () => { calls.push('notes'); return HttpResponse.json({ items: [{ id: 'private-note', title: '自己的笔记', content: '个人思考', source_app: 'manual', source_title: '', source_url: '', revision: 1, deleted_at: null, created_at: '2026-10-25T00:00:00Z', updated_at: '2026-10-25T00:00:00Z' }], total: 1 }) }))
  server.use(http.get('*/api/v1/notes/counts', () => { calls.push('notes/counts'); return HttpResponse.json({ all: 1, manual: 1, knowledge: 0, solutions: 0, information: 0, trash: 0 }) }))
  window.history.replaceState({}, '', '/notes')
  render(<App />)
  expect(await screen.findByRole('heading', { name: '自己的笔记' }, { timeout: 10000 })).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: '我的笔记', level: 1 })).toBeInTheDocument()
  await waitFor(() => expect(screen.getByRole('button', { name: '全部笔记' })).toHaveTextContent('1'))
  expect(calls[0]).toBe('portal/me')
  expect(calls.slice(1).sort()).toEqual(['notes', 'notes/counts'])
  expect(screen.getByRole('link', { name: '应用工作台' })).toHaveAttribute('href', '/')
})
