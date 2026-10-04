import { useEffect } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { USE_API } from '../../api/client'
import { usePortal } from '../../store/portal'
import { BootSplash, IdentityProblem } from '../auth/AuthStatus'
import type { PortalContext } from './context'

export default function PortalGate() {
  const { user, applications, status, error, refresh, logout } = usePortal()
  const location = useLocation()
  const preview = import.meta.env.DEV && !USE_API && new URLSearchParams(location.search).get('preview') === '1'
  useEffect(() => {
    if (preview || !USE_API) return
    void refresh()
    const onFocus = () => { void refresh() }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [preview, refresh])

  if (preview) return <Outlet context={{
    user: { id: 'preview', username: 'preview', displayName: '同事' },
    applications: [{ id: 'pm', enabled: true }, { id: 'kb', enabled: true }],
    preview: true, refresh: async () => {}, logout: () => {},
  } satisfies PortalContext} />
  if (!USE_API || status === 'anonymous') return <Navigate to="/login" state={{ from: location.pathname + location.search }} replace />
  if (status === 'error') return <IdentityProblem message={error} onLogout={logout} />
  if (status !== 'ready' || !user) return <BootSplash message="正在确认登录身份 …" />
  return <Outlet context={{ user, applications, preview: false, refresh, logout } satisfies PortalContext} />
}
