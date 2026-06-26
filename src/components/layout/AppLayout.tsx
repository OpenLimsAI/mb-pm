import { Outlet } from 'react-router-dom'
import { WifiOff } from 'lucide-react'
import { Sidebar } from './Sidebar'
import { TopBar } from './TopBar'
import { useDataStore } from '../../store/data'

export function AppLayout() {
  const notice = useDataStore((s) => s.notice)
  return (
    <div className="h-full flex">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar />
        {notice && (
          <div className="px-4 py-2 bg-amber-50 border-b border-amber-200 text-amber-800 text-xs flex items-center gap-2 shrink-0">
            <WifiOff className="w-3.5 h-3.5 shrink-0" /> {notice}
          </div>
        )}
        <main className="flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
