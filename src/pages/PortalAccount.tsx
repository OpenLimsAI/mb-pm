import { Link } from 'react-router-dom'
import { ArrowUpRight, ShieldCheck } from 'lucide-react'
import PortalLayout from '../components/portal/PortalLayout'
import { usePortalContext } from '../components/portal/context'
import { iamLoginUrl } from '../lib/site'

export default function PortalAccount() {
  const { user, applications, logout, preview } = usePortalContext()
  return <PortalLayout user={user} logout={logout} preview={preview}>
    <div className="portal-page-heading"><div className="workspace-section-label">YOUR ACCOUNT</div><h1>我的账号</h1><p>查看您的登录身份与应用入口，账号信息由 IAM 统一管理。</p></div>
    <div className="portal-account-grid">
      <section className="portal-panel" aria-labelledby="portal-identity-title">
        <span className="workspace-app-icon"><ShieldCheck size={26} aria-hidden="true" /></span>
        <h2 id="portal-identity-title">登录身份</h2>
        <dl className="portal-identity-list"><div><dt>姓名</dt><dd>{user.displayName}</dd></div><div><dt>用户名</dt><dd>{user.username}</dd></div><div><dt>身份平台</dt><dd>迈博 IAM</dd></div></dl>
        <p className="portal-secondary-copy">修改个人资料、密码或管理账号，请前往 IAM 平台。管理其他用户需要管理员权限。</p>
        <a className="portal-primary-action" href={iamLoginUrl} target="_blank" rel="noopener noreferrer">前往 IAM 平台<ArrowUpRight size={17} aria-hidden="true" /></a>
      </section>
      <section className="portal-panel" aria-labelledby="portal-access-title">
        <h2 id="portal-access-title">应用访问</h2><p className="portal-secondary-copy">应用内的项目、数据与操作权限由各应用继续验证。</p>
        <ul className="portal-access-list">
          {(['pm', 'kb'] as const).map((id) => {
            const access = applications.find((app) => app.id === id)
            return <li key={id}><div><strong>{id === 'pm' ? '项目管理' : '知识库'}</strong><span>{access?.enabled ? '已开通应用入口' : access?.reason || '请联系管理员开通'}</span></div><span className={access?.enabled ? 'portal-access-status' : 'portal-access-status portal-access-status--pending'}>{access?.enabled ? '已开通' : '待开通'}</span></li>
          })}
        </ul>
        <Link className="portal-text-link" to={'/' + (preview ? '?preview=1' : '')}>返回工作台</Link>
      </section>
    </div>
    <aside className="workspace-help"><div><strong>退出说明</strong><p>退出工作台会结束当前门户会话并请求 IAM 退出。已经打开的项目管理或知识库，请分别使用应用内的退出功能结束会话。</p></div></aside>
  </PortalLayout>
}
