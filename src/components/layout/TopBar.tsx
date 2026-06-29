import { Search, LogOut } from 'lucide-react'
import { useAuth } from '../../store/auth'
import { roleLabels } from '../../lib/permissions'
import { logout } from '../../lib/oidc'
import { Avatar } from '../ui/Avatar'

export function TopBar() {
  const user = useAuth((s) => s.currentUser)

  return (
    <header className="h-14 bg-white border-b border-ink-300/40 px-4 flex items-center gap-4 shrink-0">
      {/* 全局搜索（演示占位） */}
      <div className="flex-1 max-w-xl relative">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-ink-500" />
        <input
          className="w-full pl-9 pr-3 py-1.5 rounded-md bg-ink-100 text-sm border border-transparent focus:outline-none focus:bg-white focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
          placeholder="搜索项目、模板…"
        />
      </div>

      <div className="flex-1" />

      {/* CTO 身份 */}
      <div className="flex items-center gap-2 px-2 py-1">
        <Avatar user={user} size="sm" />
        <div className="text-left">
          <div className="text-sm font-medium text-ink-900 leading-tight">{user.displayName}</div>
          <div className="text-[10px] text-ink-500 leading-tight">{roleLabels[user.role]} · 决策视图</div>
        </div>
      </div>

      {/* 登出（RP-initiated logout：清本地会话 + 跳 Casdoor end-session） */}
      <button
        type="button"
        onClick={() => logout()}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-sm text-ink-600 hover:text-ink-900 hover:bg-ink-100 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
        title="登出"
      >
        <LogOut className="w-4 h-4" />
        登出
      </button>
    </header>
  )
}
