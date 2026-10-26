// 门户「我的设置」：个人身份、用户名 / 密码及应用访问。AI 配置在项目管理「AI设置」。
import { Link } from 'react-router-dom'
import { ShieldCheck } from 'lucide-react'
import PortalLayout from '../components/portal/PortalLayout'
import { usePortalContext } from '../components/portal/context'
import { PasswordChangeForm } from '../components/account/PasswordChangeForm'
import { UsernameChangeForm } from '../components/account/UsernameChangeForm'
import { changePortalPassword, changePortalUsername } from '../api/portal'

export default function PortalSettings() {
  const { user, applications, logout, refresh, preview } = usePortalContext()
  return <PortalLayout user={user} logout={logout} preview={preview}>
    <div className="portal-page-heading">
      <div className="workspace-section-label">MY SETTINGS</div>
      <h1>我的设置</h1>
      <p>管理您的登录账号：修改用户名和密码，查看应用访问。</p>
    </div>

    <div>
      <div className="portal-account-grid">
        <section className="portal-panel" aria-labelledby="portal-identity-title">
          <span className="workspace-app-icon"><ShieldCheck size={26} aria-hidden="true" /></span>
          <h2 id="portal-identity-title">登录身份</h2>
          <dl className="portal-identity-list"><div><dt>姓名</dt><dd>{user.displayName}</dd></div><div><dt>用户名</dt><dd>{user.username}</dd></div><div><dt>身份平台</dt><dd>迈博 IAM</dd></div></dl>
          <p className="portal-secondary-copy">姓名、身份由系统管理员在「账号管理」中维护；用户名和密码可在这里自行修改。</p>
        </section>
        <section className="portal-panel" aria-labelledby="portal-access-title">
          <h2 id="portal-access-title">应用访问</h2><p className="portal-secondary-copy">应用内的项目、数据与操作权限由各应用继续验证。</p>
          <ul className="portal-access-list">
            {(['pm', 'kb', 'information', 'solutions'] as const).map((id) => {
              const access = applications.find((app) => app.id === id)
              return <li key={id}><div><strong>{id === 'solutions' ? '知识报告' : id === 'information' ? '信息获取' : id === 'pm' ? '项目管理' : '知识库'}</strong><span>{access?.enabled ? (id === 'information' ? '可体验界面，真实采集尚未接入' : '已开通应用入口') : access?.reason || '请联系管理员开通'}</span></div><span className={access?.enabled ? 'portal-access-status' : 'portal-access-status portal-access-status--pending'}>{access?.enabled ? '已开通' : '待开通'}</span></li>
            })}
          </ul>
          <Link className="portal-text-link" to={'/' + (preview ? '?preview=1' : '')}>返回工作台</Link>
        </section>
        <UsernameChangeForm current={user.username} submit={changePortalUsername} disabled={preview} className="portal-panel space-y-4" onDone={refresh} />
        <PasswordChangeForm submit={changePortalPassword} disabled={preview} className="portal-panel space-y-4"
          description="登录密码在门户、项目管理和知识库中同时生效；修改后其他设备上的登录会退出。" />
      </div>
      <aside className="workspace-help"><div><strong>退出说明</strong><p>退出工作台会结束当前门户会话并请求 IAM 退出。已经打开的项目管理或知识库，请分别使用应用内的退出功能结束会话。</p></div></aside>
    </div>
  </PortalLayout>
}
