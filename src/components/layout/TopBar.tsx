import { LogOut, Grid2X2, MessageSquareText } from 'lucide-react'
import { useAuth } from '../../store/auth'
import { useDataStore } from '../../store/data'
import { roleLabels } from '../../lib/permissions'
import { Notifications } from '../management/Notifications'
import { SyncStatus } from './SyncStatus'
import { GlobalSearch } from './GlobalSearch'
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
      <span className="app-workspace-name">项目工作台</span>
      <GlobalSearch />

      <div className="flex-1" />
      <SyncStatus />
      <Notifications />

      <a
        href={import.meta.env.DEV && !USE_API ? '/?preview=1' : workspaceUrl}
        className="app-workbench-link"
        title="应用工作台"
        aria-label="应用工作台"
      >
        <Grid2X2 className="w-4 h-4" />
        <span className="hidden sm:inline">应用工作台</span>
      </a>

      <a
        href={import.meta.env.DEV && !USE_API ? '/feedback?preview=1&compose=1' : `${feedbackUrl}?compose=1`}
        target="_blank"
        rel="noopener noreferrer"
        className="app-feedback-link flex shrink-0 items-center gap-1.5 rounded-md border border-ink-200 px-2.5 py-1.5 text-sm text-ink-600 hover:bg-ink-100 hover:text-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
        title="在新标签页打开回音壁，原页面保留"
        aria-label="问题反馈（新标签页打开）"
      ><MessageSquareText className="w-4 h-4" aria-hidden="true" /><span>问题反馈</span></a>

      {/* 当前登录身份（角色取自 IAM）；点击进入工作台「我的设置」 */}
      {user && (
        <a
          href={import.meta.env.DEV && !USE_API ? '/settings?preview=1' : settingsUrl}
          title="我的设置（修改用户名 / 密码）"
          className="app-account flex items-center gap-2 px-2 py-1 rounded-md hover:bg-ink-100 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
        >
          <Avatar user={user} size="sm" />
          <div className="app-account-copy text-left">
            <div className="text-sm font-medium text-ink-900 leading-tight">{user.displayName}</div>
            <div className="app-account-role text-xs text-ink-500 mt-0.5 leading-tight">
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
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-sm text-ink-500 hover:text-brand-700 hover:bg-ink-100 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
          title="登出"
          aria-label="登出"
        >
          <LogOut className="w-4 h-4" />
          <span className="app-logout-label">登出</span>
        </button>
      )}
    </header>
  )
}
