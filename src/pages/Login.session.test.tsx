import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import Login from './Login'

const state = vi.hoisted(() => ({
  hasSession: vi.fn().mockResolvedValue(false),
  pmRefresh: vi.fn().mockResolvedValue(undefined),
  portalRefresh: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../api/client', () => ({ USE_API: true }))
vi.mock('../api/iamLogin', () => ({
  hasIamSession: state.hasSession,
  startLogin: vi.fn(),
  signInWithSession: vi.fn(),
  signInWithPassword: vi.fn(),
  IamUnreachable: class extends Error {},
  LoginRejected: class extends Error {},
  NeedsIamPage: class extends Error {},
}))
vi.mock('../store/auth', () => ({ useAuth: () => ({
  status: 'anonymous', refresh: state.pmRefresh, login: vi.fn(), logout: vi.fn(), error: null,
}) }))
vi.mock('../store/portal', () => ({ usePortal: () => ({
  status: 'anonymous', refresh: state.portalRefresh, login: vi.fn(), logout: vi.fn(), error: null,
}) }))
beforeEach(() => vi.clearAllMocks())
function show(url: string) { render(<MemoryRouter initialEntries={[url]}><Login /></MemoryRouter>) }
test('local PM logout does not immediately use the still-active provider SSO session', async () => {
  show('/login?local=1&app=pm')
  await waitFor(() => expect(state.pmRefresh).toHaveBeenCalledTimes(1))
  expect(state.portalRefresh).not.toHaveBeenCalled()
  expect(state.hasSession).not.toHaveBeenCalled()
  expect(screen.getByLabelText('用户名')).toBeInTheDocument()
})
test('incomplete provider logout is explicitly shown without an automatic SSO loop', async () => {
  show('/login?error=logout_incomplete')
  await waitFor(() => expect(state.portalRefresh).toHaveBeenCalledTimes(1))
  expect(screen.getByText('本应用已退出，统一身份退出未完成。其他应用可能仍已登录，请重试统一退出或联系管理员。')).toBeInTheDocument()
  expect(state.hasSession).not.toHaveBeenCalled()
})
