import { fireEvent, render, screen } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { afterEach, expect, it, vi } from 'vitest'
import App from '../App'
import { server } from '../test/setup'
import { usePortal } from '../store/portal'
vi.mock('../api/client', async original => ({ ...await original<typeof import('../api/client')>(), USE_API: true }))
afterEach(() => { usePortal.setState({ status: 'loading', user: null, identityNamespace: undefined, applications: [], mustChangePassword: false }); window.history.replaceState({}, '', '/') })
const identity = (enabled: boolean) => ({ user: { id: 'person', username: 'reader', display_name: '研究员' }, identity_namespace: 'issuer', applications: [{ id: 'assistant', enabled }, { id: 'kb', enabled: false }, { id: 'pm', enabled: false }], must_change_password: false })
it('uses portal identity and owned assistant tasks independently of PM and KB', async () => {
  const calls: string[] = [], summary = { id: 'task-id', title: '自己的 AI 任务', instructions: '', revision: 1, created_at: '2026-10-25T00:00:00Z', updated_at: '2026-10-25T00:00:00Z', deleted_at: null, message_count: 0 }
  server.use(http.get('*/api/v1/portal/me', () => { calls.push('identity'); return HttpResponse.json(identity(true)) }))
  server.use(http.get('*/api/v1/assistant/tasks', () => { calls.push('list'); return HttpResponse.json({ items: [summary], total: 1 }) }))
  server.use(http.get('*/api/v1/assistant/tasks/task-id', () => { calls.push('task'); return HttpResponse.json({ ...summary, messages: [], artifacts: [] }) }))
  server.use(http.get('*/api/v1/solutions/ai/settings', () => { calls.push('models'); return HttpResponse.json({ profiles: [], default_profile_id: null, revision: 0 }) }))
  server.use(http.get('*/api/v1/assistant/tasks/capabilities', () => HttpResponse.json({ webSearch: { configured: false }, modes: ['auto', 'general', 'web'] })))
  server.use(http.post('*/api/v1/assistant/tasks/preflight', () => HttpResponse.json({ ready: true, checks: [] })))
  server.use(http.get('*/api/v1/assistant/tasks/task-id/requests/active', () => HttpResponse.json(null)))
  window.history.replaceState({}, '', '/assistant')
  render(<App />)
  const ownedTask = await screen.findByRole('button', { name: '打开任务：自己的 AI 任务' })
  expect(calls).not.toContain('task')
  fireEvent.click(ownedTask)
  expect(await screen.findByRole('heading', { name: '自己的 AI 任务' })).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'AI 助手', level: 1 })).toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: '给 AI 助手的任务' })).toBeEnabled()
  expect(screen.getByRole('link', { name: '应用工作台' })).toHaveAttribute('href', '/')
  expect(screen.getByRole('link', { name: 'AI 模型设置' })).toHaveAttribute('href', '/model-settings')
  expect(calls.sort()).toEqual(['identity', 'list', 'models', 'task'])
})
it('does not mount conversations when the portal catalogue denies access', async () => {
  server.use(http.get('*/api/v1/portal/me', () => HttpResponse.json(identity(false))))
  window.history.replaceState({}, '', '/assistant')
  render(<App />)
  expect(await screen.findByRole('heading', { name: 'AI 助手暂时不可用' })).toBeInTheDocument()
  expect(screen.queryByRole('textbox', { name: '给 AI 助手的任务' })).not.toBeInTheDocument()
})
