import { useState } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import PortalGate from './PortalGate'
import { usePortal } from '../../store/portal'

const identity = vi.hoisted(() => vi.fn())
vi.mock('../../api/client', () => ({ USE_API: true, asAPIError: (error: unknown) => error }))
vi.mock('../../api/portal', () => ({ fetchPortalIdentity: identity, getPortalLoginUrl: vi.fn(), portalLogoutUrl: '/logout', changePortalPassword: vi.fn() }))
const loggedIn = { user: { id: 'one', username: 'one', displayName: '同事' }, identityNamespace: 'issuer:one', applications: [], mustChangePassword: false }
beforeEach(() => {
  vi.clearAllMocks()
  identity.mockResolvedValue(loggedIn)
  usePortal.setState({ ...loggedIn, status: 'ready', error: null, refreshError: null })
})
function Draft() {
  const [value, setValue] = useState('')
  return <label>尚未提交的问题<input value={value} onChange={event => setValue(event.target.value)} /></label>
}
it('retains the mounted editor during a temporary refresh failure and retries without navigation', async () => {
  render(<MemoryRouter initialEntries={['/solutions']}><Routes><Route element={<PortalGate />}><Route path="solutions" element={<Draft />} /></Route><Route path="login" element={<p>登录页</p>} /></Routes></MemoryRouter>)
  await waitFor(() => expect(identity).toHaveBeenCalledTimes(1))
  fireEvent.change(screen.getByLabelText('尚未提交的问题'), { target: { value: '请保留这个问题' } })
  identity.mockRejectedValueOnce({ status: 503, detail: 'provider offline' })
  await act(async () => { await usePortal.getState().refresh() })
  expect(screen.getByLabelText('尚未提交的问题')).toHaveValue('请保留这个问题')
  expect(screen.getByRole('status')).toHaveTextContent('当前页面已保留')
  expect(screen.queryByText('登录页')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '重试身份验证' }))
  await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
  expect(screen.getByLabelText('尚未提交的问题')).toHaveValue('请保留这个问题')
  identity.mockRejectedValueOnce({ status: 401, detail: 'session revoked' })
  await act(async () => { await usePortal.getState().refresh() })
  expect(await screen.findByText('登录页')).toBeInTheDocument()
  expect(screen.queryByLabelText('尚未提交的问题')).not.toBeInTheDocument()
})
