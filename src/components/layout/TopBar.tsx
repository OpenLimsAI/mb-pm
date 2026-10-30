import { Search, LogOut, Grid2X2 } from 'lucide-react'
import { useAuth } from '../../store/auth'
import { useDataStore } from '../../store/data'
import { roleLabels } from '../../lib/permissions'
import { Avatar } from '../ui/Avatar'
import { USE_API } from '../../api/client'
import { feedbackUrl, settingsUrl, workspaceUrl } from '../../lib/site'

export function TopBar() {
  const user = useAuth((s) => s.currentUser)
  const logout = useAuth((s) => s.logout)
  // 离线演示（未连后端）没有登录会话，不显示登出
  const online = useDataStore((s) => s.mode === 'api')

  return (
    <header className="app-topbar">
      <span className="app-workspace-name">研发项目管理</span>
      {/* 全局搜索（演示占位） */}
      <div className="app-search flex-1 max-w-xs relative">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-blue-100 pointer-events-none" />
        <input
          className="w-full pl-9 pr-3 py-2 rounded-md bg-white/10 text-white placeholder:text-blue-100 text-sm border border-white/15 focus:outline-none focus:bg-white/15 focus:border-cyan-200 focus:ring-2 focus:ring-cyan-200/30"
          aria-label="搜索项目、模板"
          placeholder="搜索项目、模板…"
        />
      </div>

      <div className="flex-1" />

      <a
        href={import.meta.env.DEV && !USE_API ? '/?preview=1' : workspaceUrl}
        className="app-workbench-link"
        title="应用工作台"
        aria-label="应用工作台"
      >
        <Grid2X2 className="w-4 h-4" />
        <span className="hidden sm:inline">应用工作台</span>
      </a>

      <a href={import.meta.env.DEV && !USE_API ? '/feedback?preview=1' : feedbackUrl} className="text-sm text-blue-100 hover:text-white px-2 py-1.5">回音壁</a>

      {/* 当前登录身份（角色取自 IAM）；点击进入工作台「我的设置」 */}
      {user && (
        <a
          href={import.meta.env.DEV && !USE_API ? '/settings?preview=1' : settingsUrl}
          title="我的设置（修改用户名 / 密码）"
          className="app-account flex items-center gap-2.5 px-2 py-1.5 rounded-md hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-cyan-200/50"
        >
          <Avatar user={user} size="sm" />
          <div className="text-left">
            <div className="text-sm font-medium text-white leading-tight">{user.displayName}</div>
            <div className="app-account-role text-[10px] text-blue-100 mt-1 leading-tight">
              {roleLabels[user.role]} · {online ? '决策视图' : '离线演示'}
            </div>
          </div>
        </a>
      )}

      {/* 登出：销毁业务会话 + 清除 IAM 单点登录，回到登录页 */}
      {online && (
        <button
          type="button"
          onClick={logout}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-sm text-blue-100 hover:text-white hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-cyan-200/50"
          title="登出"
        >
          <LogOut className="w-4 h-4" />
          登出
        </button>
      )}
    </header>
  )
}
