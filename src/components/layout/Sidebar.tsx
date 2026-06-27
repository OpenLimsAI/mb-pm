import { NavLink } from 'react-router-dom'
import { LayoutDashboard, FolderKanban, Wallet, Users, Beaker, type LucideIcon } from 'lucide-react'
import { cn } from '../../lib/cn'

interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  end?: boolean
}

// 左侧主导航。模板管理改由「项目」页右上角入口进入，不再单列。
const navItems: NavItem[] = [
  { to: '/',          label: '首页',   icon: LayoutDashboard, end: true },
  { to: '/projects',  label: '项目',   icon: FolderKanban },
  { to: '/finance',   label: '财务',   icon: Wallet },
  { to: '/org',       label: '组织',   icon: Users },
]

export function Sidebar() {
  return (
    <aside className="w-56 shrink-0 bg-white border-r border-ink-300/40 flex flex-col">
      {/* Logo */}
      <div className="h-14 px-4 flex items-center gap-2 border-b border-ink-300/40">
        <div className="w-8 h-8 rounded-md bg-brand-600 flex items-center justify-center text-white">
          <Beaker className="w-5 h-5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-ink-900 leading-tight flex items-center gap-1.5">
            CMC-PMS
            <span className="text-[9px] font-mono px-1 py-0.5 rounded bg-brand-50 text-brand-700 border border-brand-200">
              CTO
            </span>
          </div>
          <div className="text-[10px] text-ink-500 leading-tight">研发项目组合 · 决策视图</div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
        {navItems.map((it) => (
          <NavLink
            key={it.to}
            to={it.to}
            end={it.end}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors',
                isActive
                  ? 'bg-brand-50 text-brand-700 font-medium'
                  : 'text-ink-700 hover:bg-ink-100'
              )
            }
          >
            <it.icon className="w-4 h-4 shrink-0" />
            <span>{it.label}</span>
          </NavLink>
        ))}
      </nav>

      {/* Footer */}
      <div className="px-3 py-3 border-t border-ink-300/40 text-[11px] text-ink-500">
        <div>URS-CMC-PMS-001</div>
        <div className="opacity-70">© CMC 部 · 内部使用</div>
      </div>
    </aside>
  )
}
