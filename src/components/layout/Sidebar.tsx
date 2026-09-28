import { useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import {
  LayoutDashboard, FolderKanban, ListChecks, GanttChartSquare, Gauge, Wallet, Users, Beaker, ChevronDown,
  Settings2, type LucideIcon,
} from 'lucide-react'
import { cn } from '../../lib/cn'
import { can, type PermKey } from '../../lib/permissions'
import { useAuth } from '../../store/auth'

interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  end?: boolean
  perms?: PermKey[]   // 满足其一才显示（与 App 路由守卫一致）
  children?: NavItem[]
}

// 左侧主导航。模板管理由「项目」页右上角入口进入；任务 / 甘特图 / 人员负荷 收在「项目」下，可折叠。
const navItems: NavItem[] = [
  { to: '/',          label: '首页',   icon: LayoutDashboard, end: true },
  {
    to: '/projects',  label: '项目',   icon: FolderKanban,
    children: [
      { to: '/tasks',    label: '任务',     icon: ListChecks },
      { to: '/gantt',    label: '甘特图',   icon: GanttChartSquare, perms: ['gantt.view', 'gantt.view.own'] },
      { to: '/workload', label: '人员负荷', icon: Gauge, perms: ['workload.view'] },
    ],
  },
  { to: '/finance',   label: '财务',   icon: Wallet },
  { to: '/org',       label: '组织',   icon: Users },
  { to: '/settings',  label: '设置',   icon: Settings2 },
]

// 记住用户收起的分组（仅本浏览器的界面偏好；读写失败时按默认全部展开）
const COLLAPSED_KEY = 'cmc-pms-lite-nav-collapsed'

function loadCollapsed(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function Sidebar() {
  const role = useAuth((s) => s.currentUser?.role)
  const { pathname } = useLocation()
  const [collapsed, setCollapsed] = useState<string[]>(loadCollapsed)
  const allowed = (it: NavItem) => !it.perms || it.perms.some((p) => can(role, p))

  const toggle = (key: string) => {
    const next = collapsed.includes(key) ? collapsed.filter((k) => k !== key) : [...collapsed, key]
    setCollapsed(next)
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next))
    } catch {
      // 隐私模式等场景写不进去时，仅本次会话生效
    }
  }

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
        {navItems.filter(allowed).map((it) => {
          const children = it.children?.filter(allowed) ?? []
          if (children.length === 0) return <NavItemLink key={it.to} item={it} />

          const open = !collapsed.includes(it.to)
          // 收起时若正处在子页面，父级保持高亮，方便定位
          const childActive = children.some((c) => pathname === c.to || pathname.startsWith(`${c.to}/`))
          const groupId = `nav-group${it.to.replace(/\//g, '-')}`
          return (
            <div key={it.to}>
              <div className="flex items-center gap-0.5">
                <NavItemLink item={it} className="flex-1" highlight={!open && childActive} />
                <button
                  type="button"
                  onClick={() => toggle(it.to)}
                  aria-expanded={open}
                  aria-controls={groupId}
                  aria-label={`${open ? '收起' : '展开'}「${it.label}」子菜单`}
                  title={open ? '收起' : '展开'}
                  className="w-7 h-7 shrink-0 rounded-md flex items-center justify-center text-ink-500 hover:bg-ink-100 hover:text-ink-900 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                >
                  <ChevronDown className={cn('w-4 h-4 transition-transform', !open && '-rotate-90')} />
                </button>
              </div>
              <div id={groupId} hidden={!open} className="mt-0.5 ml-5 pl-2 border-l border-ink-300/60 space-y-0.5">
                {children.map((c) => <NavItemLink key={c.to} item={c} child />)}
              </div>
            </div>
          )
        })}
      </nav>

      {/* Footer */}
      <div className="px-3 py-3 border-t border-ink-300/40 text-[11px] text-ink-500">
        <div>URS-CMC-PMS-001</div>
        <div className="opacity-70">© CMC 部 · 内部使用</div>
      </div>
    </aside>
  )
}

function NavItemLink({
  item, child, className, highlight,
}: { item: NavItem; child?: boolean; className?: string; highlight?: boolean }) {
  return (
    <NavLink
      to={item.to}
      end={item.end}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-2.5 rounded-md transition-colors',
          child ? 'px-2.5 py-1.5 text-[13px]' : 'px-3 py-2 text-sm',
          isActive || highlight
            ? 'bg-brand-50 text-brand-700 font-medium'
            : 'text-ink-700 hover:bg-ink-100',
          className,
        )
      }
    >
      <item.icon className={cn('shrink-0', child ? 'w-3.5 h-3.5' : 'w-4 h-4')} />
      <span>{item.label}</span>
    </NavLink>
  )
}
