import { useEffect } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { bootstrap, watchIdentity } from '../../data/bootstrap'
import { useAuth } from '../../store/auth'
import { useDataStore } from '../../store/data'
import { BootSplash, IdentityProblem } from './AuthStatus'
import { ForcedPasswordChange } from './ForcedPasswordChange'
import { changePassword } from '../../api/auth'

// 仅进入项目应用时载入业务引导及数据；门户不依赖项目角色、业务数据或演示数组。
export default function ProjectReadyGate() {
  const ready = useDataStore((s) => s.ready)
  const status = useAuth((s) => s.status)
  const error = useAuth((s) => s.error)
  const logout = useAuth((s) => s.logout)
  const mustChangePassword = useAuth((s) => s.mustChangePassword)
  const currentUser = useAuth((s) => s.currentUser)
  const location = useLocation()

  useEffect(() => {
    void bootstrap()
    return watchIdentity()
  }, [])

  if (status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search + location.hash }} />
  }
  if (status === 'error') return <IdentityProblem message={error} onLogout={logout} />
  if (status === 'ready' && mustChangePassword) {
    // 改完后整页重新进入：会话已更新，重新确认身份并加载业务数据
    return <ForcedPasswordChange name={currentUser?.displayName} submit={changePassword} onDone={() => window.location.reload()} onLogout={logout} />
  }
  if (!ready) return <BootSplash />
  return <Outlet />
}
