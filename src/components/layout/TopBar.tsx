import { useLocation } from 'react-router-dom'
import { FolderKanban } from 'lucide-react'
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
      <div className="forest-app-identity">
        <span className="forest-app-mark" aria-hidden="true"><FolderKanban size={22} /></span>
        <span className="forest-app-copy"><strong>项目管理</strong><small lang="en">PROJECT WORKSPACE</small></span>
      </div>
      <GlobalSearch />
      <div className="flex-1" />
      <SyncStatus />
      <Notifications />
      <ApplicationActions userName={user?.displayName || user?.username} preview={preview} application="pm" page={location} />
    </header>
  )
}
