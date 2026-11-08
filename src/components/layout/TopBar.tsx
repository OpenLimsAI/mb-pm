import { useLocation } from 'react-router-dom'
import { useAuth } from '../../store/auth'
import { Notifications } from '../management/Notifications'
import { SyncStatus } from './SyncStatus'
import { GlobalSearch } from './GlobalSearch'
import { USE_API } from '../../api/client'
import ApplicationActions from '../application/ApplicationActions'

export function TopBar() {
  const location = useLocation()
  const user = useAuth((s) => s.currentUser)
  const preview = import.meta.env.DEV && !USE_API
  return (
    <header className="app-topbar">
      <span className="app-workspace-name">项目工作台</span>
      <GlobalSearch />
      <div className="flex-1" />
      <SyncStatus />
      <Notifications />
      <ApplicationActions userName={user?.displayName || user?.username} preview={preview} application="pm" page={location} />
    </header>
  )
}
