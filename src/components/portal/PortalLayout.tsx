import type { ReactNode } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import { Archive, LogOut, ShieldCheck, LayoutDashboard, Sparkles, Library, BriefcaseBusiness, Settings2, CircleHelp, Grid2X2 } from 'lucide-react'
import type { PortalUser } from '../../api/portal'
import { workspaceSections } from './workspaceSections'
import '../../styles/workspace.css'
import ApplicationActions from '../application/ApplicationActions'

export default function PortalLayout({ user, logout, preview = false, children }: {
  user?: PortalUser | null
  logout?: () => void
  preview?: boolean
  children: ReactNode
}) {
  const displayName = user?.displayName || user?.username || ''
  const location = useLocation()
  const { pathname, hash } = location
  const atWorkspace = pathname === '/'
  const suffix = preview ? '?preview=1' : ''
  const sectionIcons = [Sparkles, Library, BriefcaseBusiness, Archive, Settings2]
  return <div id="workspace-top" className="workspace-shell efficient-portal">
    <a className="portal-skip-link" href="#portal-content">跳至主要内容</a>
    <header className="workspace-header">
      <div className="workspace-header-inner">
        <Link className="workspace-brand" to={'/' + suffix} aria-label="迈博药业应用工作台首页">
          <span className="forest-app-mark" aria-hidden="true"><Grid2X2 size={22} /></span>
          <span className="workspace-brand-copy"><strong>应用工作台</strong><span lang="en">WORKSPACE</span></span>
        </Link>
        <span className="workspace-context">迈博数字化工作空间</span>
        <div className="workspace-account">
          <ApplicationActions userName={displayName || undefined} preview={preview} page={location} />
          {!user && !preview && <Link className="workspace-header-action" to="/login">前往登录</Link>}
        </div>
      </div>
    </header>
    <aside className="workspace-sidebar">
      <span className="workspace-sidebar-caption">工作空间</span>
      <nav className="portal-navigation" aria-label="门户导航">
        <Link to={'/' + suffix} className={atWorkspace && !hash ? 'active' : undefined} aria-current={atWorkspace && !hash ? 'page' : undefined}><LayoutDashboard size={17} aria-hidden="true" /><span>工作台</span></Link>
        {(user || preview) && workspaceSections.map((section, index) => {
          const active = atWorkspace && hash === `#${section.id}`
          const Icon = sectionIcons[index]
          return <Link key={section.id} to={'/' + suffix + `#${section.id}`} className={active ? 'active' : undefined} aria-current={active ? 'location' : undefined}><Icon size={17} aria-hidden="true" /><span>{section.label}</span></Link>
        })}
        <NavLink to="/help"><CircleHelp size={17} aria-hidden="true" /><span>使用帮助</span></NavLink>
      </nav>
      <div className={`workspace-sidebar-footer${user && logout ? ' workspace-sidebar-footer--session' : ''}`}>{user && logout && <button type="button" className="workspace-header-action workspace-logout" aria-label="退出工作台" title="退出工作台" onClick={logout} disabled={preview}><LogOut size={16} aria-hidden="true" /><span>退出工作台</span></button>}<strong>MBERP</strong><span>迈博数字化工作空间</span></div>
    </aside>
    <main id="portal-content" className="workspace-main">
      {preview && <div className="workspace-preview-label"><ShieldCheck size={15} aria-hidden="true" />界面预览：当前未验证真实账号与应用访问权限。</div>}
      {children}
    </main>
    <footer className="workspace-footer"><span>迈博药业 · 数字化工作空间</span><span>MAIBO PHARMACEUTICALS</span></footer>
  </div>
}
