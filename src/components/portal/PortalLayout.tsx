import type { ReactNode } from 'react'
import { Link, NavLink } from 'react-router-dom'
import { LogOut, ShieldCheck } from 'lucide-react'
import type { PortalUser } from '../../api/portal'
import { usePortal } from '../../store/portal'
import '../../styles/workspace.css'

export default function PortalLayout({ user, logout, preview = false, children }: {
  user?: PortalUser | null
  logout?: () => void
  preview?: boolean
  children: ReactNode
}) {
  const displayName = user?.displayName || user?.username || ''
  const accountsEnabled = usePortal((state) => state.applications.some((entry) => entry.id === 'accounts' && entry.enabled))
  const suffix = preview ? '?preview=1' : ''
  return <div className="workspace-shell">
    <a className="portal-skip-link" href="#portal-content">跳至主要内容</a>
    <header className="workspace-header">
      <div className="workspace-header-inner">
        <Link className="workspace-brand" to={'/' + suffix} aria-label="迈博药业应用工作台首页">
          <img src="/brand/maibo-pharma-logo.png" alt="迈博药业" />
          <span className="workspace-brand-copy"><strong>迈博药业</strong><span>数字化工作空间</span></span>
        </Link>
        <nav className="portal-navigation" aria-label="门户导航">
          <NavLink to={'/' + suffix} end>工作台</NavLink>
          {user && !preview && accountsEnabled && <NavLink to="/accounts">账号管理</NavLink>}
          {user && <NavLink to={'/settings' + suffix}>我的设置</NavLink>}
          {user && <NavLink to={'/model-settings' + suffix}>AI 设置</NavLink>}
          <NavLink to="/help">使用帮助</NavLink>
        </nav>
        <div className="workspace-account">
          {user && <Link className="portal-account-link" to={'/settings' + suffix} title="我的设置">
            <span className="workspace-user-avatar" aria-hidden="true">{Array.from(displayName)[0]}</span>
            <span className="workspace-user-name" title={displayName}>{displayName}</span>
          </Link>}
          {user && logout ? <button type="button" className="workspace-header-action workspace-logout" onClick={logout} disabled={preview}>
            <LogOut size={16} aria-hidden="true" /><span>退出工作台</span>
          </button> : <Link className="workspace-header-action workspace-logout" to="/login">前往登录</Link>}
        </div>
      </div>
    </header>
    <main id="portal-content" className="workspace-main">
      {preview && <div className="workspace-preview-label"><ShieldCheck size={15} aria-hidden="true" />界面预览：当前未验证真实账号与应用访问权限。</div>}
      {children}
    </main>
    <footer className="workspace-footer"><span>迈博药业 · 数字化工作空间</span><span>MAIBO PHARMACEUTICALS</span></footer>
  </div>
}
