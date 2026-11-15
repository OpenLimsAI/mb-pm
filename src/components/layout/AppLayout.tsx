import { Outlet } from 'react-router-dom'
import { WifiOff } from 'lucide-react'
import { Sidebar } from './Sidebar'
import { TopBar } from './TopBar'
import { useDataStore } from '../../store/data'
import { useAuth } from '../../store/auth'
import { IdentityRetryNotice } from '../auth/AuthStatus'

export function AppLayout() {
  const notice = useDataStore((s) => s.notice)
  const refreshError = useAuth((s) => s.refreshError)
  const refresh = useAuth((s) => s.refresh)
  return (
    <div className="app-shell h-full min-h-0 flex overflow-hidden">
      <Sidebar />
      <div className="app-content flex-1 flex flex-col min-w-0 min-h-0">
        <TopBar />
        {refreshError && <div className="shrink-0"><IdentityRetryNotice message={refreshError} onRetry={() => { void refresh() }} /></div>}
        {notice && (
          <div className="px-4 py-2 bg-amber-50 border-b border-amber-200 text-amber-800 text-xs flex items-center gap-2 shrink-0">
            <WifiOff className="w-3.5 h-3.5 shrink-0" /> {notice}
          </div>
        )}
        {/* Keep absolute helpers inside this scrollport instead of the document. */}
        <main className="app-main relative flex-1 min-w-0 min-h-0 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
