import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePortal } from './portal'
import { useAuth } from './auth'
import type { User } from '../types'

const api = vi.hoisted(() => ({ portal: vi.fn(), pm: vi.fn() }))
vi.mock('../api/portal', () => ({ fetchPortalIdentity: api.portal, getPortalLoginUrl: vi.fn(), portalLogoutUrl: '/portal/logout' }))
vi.mock('../api/auth', () => ({ fetchMe: api.pm, getLoginUrl: vi.fn(), logoutUrl: '/auth/logout' }))
vi.mock('../api/client', () => ({ asAPIError: (error: unknown) => error }))

const portalUser = { id: 'one', username: 'one', displayName: '同事' }
const pmUser = { id: 'one', displayName: '同事', role: 'admin' } as User
beforeEach(() => {
  vi.clearAllMocks()
  usePortal.setState({ user: portalUser, identityNamespace: 'issuer:one', applications: [{ id: 'solutions', enabled: true }], status: 'ready', error: null, refreshError: null })
  useAuth.setState({ currentUser: pmUser, status: 'ready', error: null, refreshError: null })
})

describe('temporary identity failures', () => {
  it.each([undefined, 500, 502, 503, 504])('keeps both mounted identities on a transient status %s', async status => {
    api.portal.mockRejectedValue({ status, detail: 'unavailable' }); api.pm.mockRejectedValue({ status, detail: 'unavailable' })
    await Promise.all([usePortal.getState().refresh(), useAuth.getState().refresh()])
    expect(usePortal.getState()).toMatchObject({ user: portalUser, identityNamespace: 'issuer:one', status: 'ready', refreshError: expect.stringContaining('当前页面已保留') })
    expect(useAuth.getState()).toMatchObject({ currentUser: pmUser, status: 'ready', refreshError: expect.stringContaining('当前页面已保留') })
  })
  it.each([401, 403])('clears both identities for a definitive denial %s', async status => {
    api.portal.mockRejectedValue({ status, detail: 'denied' }); api.pm.mockRejectedValue({ status, detail: 'denied' })
    await Promise.all([usePortal.getState().refresh(), useAuth.getState().refresh()])
    expect(usePortal.getState()).toMatchObject({ user: null, identityNamespace: undefined, applications: [], status: status === 401 ? 'anonymous' : 'error', refreshError: null })
    expect(useAuth.getState()).toMatchObject({ currentUser: null, status: status === 401 ? 'anonymous' : 'error', refreshError: null })
  })
  it('does not manufacture a valid login after a first-load provider failure', async () => {
    usePortal.setState({ user: null, status: 'loading', applications: [] })
    useAuth.setState({ currentUser: null, status: 'loading' })
    api.portal.mockRejectedValue({ status: 503, detail: 'unavailable' }); api.pm.mockRejectedValue({ status: 503, detail: 'unavailable' })
    await Promise.all([usePortal.getState().refresh(), useAuth.getState().refresh()])
    expect(usePortal.getState()).toMatchObject({ user: null, status: 'error' })
    expect(useAuth.getState()).toMatchObject({ currentUser: null, status: 'error' })
  })
  it('clears the notice after a successful retry and accepts the newly verified identity', async () => {
    usePortal.setState({ refreshError: 'temporary' }); useAuth.setState({ refreshError: 'temporary' })
    api.portal.mockResolvedValue({ user: { ...portalUser, id: 'two' }, identityNamespace: 'issuer:two', applications: [] })
    api.pm.mockResolvedValue({ ...pmUser, id: 'two' })
    await Promise.all([usePortal.getState().refresh(), useAuth.getState().refresh()])
    expect(usePortal.getState()).toMatchObject({ user: { id: 'two' }, identityNamespace: 'issuer:two', refreshError: null })
    expect(useAuth.getState()).toMatchObject({ currentUser: { id: 'two' }, refreshError: null })
  })
  it('rechecks a delayed project 401 instead of discarding a renewed login', async () => {
    api.pm.mockResolvedValue(pmUser)
    window.dispatchEvent(new Event('pms:unauthorized'))
    await useAuth.getState().refresh()
    expect(api.pm).toHaveBeenCalledTimes(1)
    expect(useAuth.getState()).toMatchObject({ currentUser: pmUser, status: 'ready' })
  })
})
