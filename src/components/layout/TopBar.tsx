import { Link } from 'react-router-dom'
import { Search, LogOut } from 'lucide-react'
import { useAuth } from '../../store/auth'
import { useDataStore } from '../../store/data'
import { roleLabels } from '../../lib/permissions'
import { Avatar } from '../ui/Avatar'

export function TopBar() {
  const user = useAuth((s) => s.currentUser)
  const logout = useAuth((s) => s.logout)
  // 离线演示（未连后端）没有登录会话，不显示登出
  const online = useDataStore((s) => s.mode === 'api')

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

      {/* 当前登录身份（角色取自 IAM）；点击进入「设置 › 我的账号」 */}
      {user && (
        <Link
          to="/settings"
          title="账号设置（修改用户名 / 密码）"
          className="flex items-center gap-2 px-2 py-1 rounded-md hover:bg-ink-100 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
        >
          <Avatar user={user} size="sm" />
          <div className="text-left">
            <div className="text-sm font-medium text-ink-900 leading-tight">{user.displayName}</div>
            <div className="text-[10px] text-ink-500 leading-tight">
              {roleLabels[user.role]} · {online ? '决策视图' : '离线演示'}
            </div>
          </div>
        </Link>
      )}

      {/* 登出：销毁业务会话 + 清除 IAM 单点登录，回到登录页 */}
      {online && (
        <button
          type="button"
          onClick={logout}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-sm text-ink-600 hover:text-ink-900 hover:bg-ink-100 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
          title="登出"
        >
          <LogOut className="w-4 h-4" />
          登出
        </button>
      )}
    </header>
  )
}
