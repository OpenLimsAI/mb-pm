import { afterEach, expect, test, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TopBar } from './TopBar'
import { Sidebar } from './Sidebar'
import PortalLayout from '../portal/PortalLayout'

const state = vi.hoisted(() => ({
  logout: vi.fn(),
  user: { id: 'synthetic-signer', username: 'synthetic.signer', displayName: '测试同事', role: 'cmc_lead' },
}))
vi.mock('../../store/auth', () => ({ useAuth: (select: (value: unknown) => unknown) => select({ currentUser: state.user, logout: state.logout }) }))
vi.mock('../../store/data', () => ({ useDataStore: (select: (value: unknown) => unknown) => select({ mode: 'api' }) }))
vi.mock('../management/Notifications', () => ({ Notifications: () => null }))
vi.mock('./SyncStatus', () => ({ SyncStatus: () => null }))
vi.mock('./GlobalSearch', () => ({ GlobalSearch: () => null }))

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

test('PM uses shared header actions and retains logout in the sidebar', () => {
  vi.stubEnv('VITE_DEVICE_LOGOUT_ENABLED', 'true')
  render(<MemoryRouter><TopBar /><Sidebar /></MemoryRouter>)
  expect(screen.getByText('测试同事')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /退出当前设备/ })).not.toBeInTheDocument()
  const logout = screen.getByRole('button', { name: '登出' })
  expect(logout.closest('header')).toBeNull()
  expect(screen.getByRole('button', { name: '切换主题' })).toBeInTheDocument()
  fireEvent.click(logout)
  expect(state.logout).toHaveBeenCalledOnce()
})

test('the portal retains working logout without a current-device action', () => {
  vi.stubEnv('VITE_DEVICE_LOGOUT_ENABLED', 'true')
  render(<MemoryRouter><PortalLayout user={state.user} logout={state.logout}><p>合成工作台</p></PortalLayout></MemoryRouter>)
  expect(screen.queryByRole('button', { name: /退出当前设备/ })).not.toBeInTheDocument()
  const logout = screen.getByRole('button', { name: '退出工作台' })
  expect(logout.closest('aside')).not.toBeNull()
  fireEvent.click(logout)
  expect(state.logout).toHaveBeenCalledOnce()
})
