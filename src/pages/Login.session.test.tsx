import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { MemoryRouter, useNavigate } from 'react-router-dom'
import Login from './Login'

const state = vi.hoisted(() => ({
  hasSession: vi.fn().mockResolvedValue('anonymous'),
  pmRefresh: vi.fn().mockResolvedValue(undefined),
  portalRefresh: vi.fn().mockResolvedValue(undefined),
  pmLogin: vi.fn().mockResolvedValue(undefined),
  portalLogin: vi.fn().mockResolvedValue(undefined),
  startLogin: vi.fn().mockResolvedValue({ callbackUrl: 'https://portal.test/callback' }),
  sessionLogin: vi.fn().mockRejectedValue(new Error('IAM unavailable')),
  passwordLogin: vi.fn().mockRejectedValue(new Error('Synthetic login failure')),
}))
vi.mock('../api/client', () => ({ USE_API: true }))
vi.mock('../api/iamLogin', () => ({
  hasIamSession: state.hasSession,
  startLogin: state.startLogin,
  signInWithSession: state.sessionLogin,
  signInWithPassword: state.passwordLogin,
  IamUnreachable: class extends Error {},
  LoginRejected: class extends Error {},
  NeedsIamPage: class extends Error {},
}))
vi.mock('../store/auth', () => ({ useAuth: () => ({
  status: 'anonymous', refresh: state.pmRefresh, login: state.pmLogin, logout: vi.fn(), error: null,
}) }))
vi.mock('../store/portal', () => ({ usePortal: () => ({
  status: 'anonymous', refresh: state.portalRefresh, login: state.portalLogin, logout: vi.fn(), error: null,
}) }))
beforeEach(() => { vi.clearAllMocks(); sessionStorage.clear(); state.hasSession.mockResolvedValue('anonymous'); state.startLogin.mockResolvedValue({ callbackUrl: 'https://portal.test/callback' }); state.sessionLogin.mockRejectedValue(new Error('IAM unavailable')) })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
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
test('completed global logout does not automatically resurrect the IAM session', async () => {
  show('/login?signed_out=1')
  await waitFor(() => expect(state.portalRefresh).toHaveBeenCalled())
  expect(state.hasSession).not.toHaveBeenCalled()
})
test('provider callback errors do not automatically retry authorization', async () => {
  show('/login?error=provider')
  await waitFor(() => expect(state.portalRefresh).toHaveBeenCalled())
  expect(state.hasSession).not.toHaveBeenCalled()
})
test('a failed probe is shown as uncertain and provides explicit IAM recovery', async () => {
  state.hasSession.mockResolvedValue('unknown')
  show('/login')
  expect(await screen.findByText('暂时无法确认统一身份登录状态。可以重试检查，或打开统一身份平台恢复登录。')).toBeInTheDocument()
  expect(state.sessionLogin).not.toHaveBeenCalled()
  expect(screen.getByLabelText('用户名')).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: '打开统一身份平台' }))
  expect(state.portalLogin).toHaveBeenCalledWith('/')
})
test('unknown status can be checked again without a redirect loop', async () => {
  state.hasSession.mockResolvedValue('unknown')
  show('/login')
  fireEvent.click(await screen.findByRole('button', { name: '重试登录检查' }))
  await waitFor(() => expect(state.hasSession).toHaveBeenCalledTimes(2))
  expect(state.startLogin).not.toHaveBeenCalled()
})
test('a quick-sign-in failure is visible and not retried on rerenders', async () => {
  state.hasSession.mockResolvedValue('authenticated')
  render(<StrictMode><MemoryRouter initialEntries={['/login']}><Login /></MemoryRouter></StrictMode>)
  expect(await screen.findByText('统一身份登录尚在，但自动恢复未完成。请重试检查，或打开统一身份平台继续。')).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'colleague' } })
  expect(state.startLogin).toHaveBeenCalledTimes(1)
  expect(state.sessionLogin).toHaveBeenCalledTimes(1)
  expect(state.hasSession).toHaveBeenCalledTimes(1)
})
test('a recent redirect attempt requires explicit recovery instead of looping after remount', async () => {
  state.hasSession.mockResolvedValue('authenticated')
  sessionStorage.setItem('mb-iam-auto-attempt:portal', String(Date.now()))
  show('/login')
  expect(await screen.findByText('刚才的自动登录未能恢复工作空间，请重试检查或打开统一身份平台。')).toBeInTheDocument()
  expect(state.startLogin).not.toHaveBeenCalled()
})

function LoginWithNavigation({ destination }: { destination: string }) {
  const navigate = useNavigate()
  return <><button onClick={() => { void navigate(destination) }}>改变登录入口</button><Login /></>
}
test('cancelled automatic start cannot leave a reused login instance disabled', async () => {
  let resolveOld!: (value: { callbackUrl: string }) => void
  state.hasSession.mockResolvedValue('authenticated')
  state.startLogin.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
  render(<MemoryRouter initialEntries={['/login']}><LoginWithNavigation destination="/login?local=1&app=pm" /></MemoryRouter>)
  await waitFor(() => expect(state.startLogin).toHaveBeenCalledTimes(1))
  expect(screen.getByLabelText('用户名')).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: '改变登录入口' }))
  expect(screen.getByLabelText('用户名')).toBeEnabled()
  await act(async () => { resolveOld({ callbackUrl: 'https://portal.test/obsolete' }) })
  expect(state.sessionLogin).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'colleague' } })
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'synthetic-test-password' } })
  fireEvent.click(screen.getByRole('button', { name: '登录项目管理' }))
  await waitFor(() => expect(state.passwordLogin).toHaveBeenCalledTimes(1))
  expect(state.startLogin).toHaveBeenLastCalledWith('pm', '/dashboard')
})
test('a late cancelled attempt cannot clear a newer automatic login operation', async () => {
  let rejectOld!: (reason: Error) => void
  state.hasSession.mockResolvedValue('authenticated')
  state.startLogin.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject }))
  state.sessionLogin.mockImplementationOnce(() => new Promise(() => {}))
  render(<MemoryRouter initialEntries={['/login']}><LoginWithNavigation destination="/login" /></MemoryRouter>)
  await waitFor(() => expect(state.startLogin).toHaveBeenCalledTimes(1))
  sessionStorage.removeItem('mb-iam-auto-attempt:portal')
  fireEvent.click(screen.getByRole('button', { name: '改变登录入口' }))
  await waitFor(() => expect(state.startLogin).toHaveBeenCalledTimes(2))
  await act(async () => { rejectOld(new Error('Old operation failed late')) })
  expect(screen.getByLabelText('用户名')).toBeDisabled()
  expect(screen.queryByText('统一身份登录尚在，但自动恢复未完成。请重试检查，或打开统一身份平台继续。')).not.toBeInTheDocument()
})
test('unavailable session storage stops automatic redirects and offers manual IAM recovery', async () => {
  state.hasSession.mockResolvedValue('authenticated')
  vi.stubGlobal('sessionStorage', { getItem: () => { throw new DOMException('Storage unavailable', 'SecurityError') }, setItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn() })
  show('/login')
  expect(await screen.findByText('浏览器暂时无法保存自动登录状态，已停止自动跳转。请打开统一身份平台继续登录。')).toBeInTheDocument()
  expect(state.startLogin).not.toHaveBeenCalled()
  expect(screen.getByLabelText('用户名')).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: '打开统一身份平台' }))
  expect(state.portalLogin).toHaveBeenCalledWith('/')
})
