import { useEffect, useState } from 'react'
import { Link, Navigate, useLocation, useSearchParams } from 'react-router-dom'
import { ArrowRight, BookOpen, FolderKanban, Loader2, LogOut, ShieldCheck } from 'lucide-react'
import { USE_API } from '../api/client'
import { useAuth } from '../store/auth'
import { usePortal } from '../store/portal'
import { iamLoginUrl, safeReturnPath, siteMode, workspaceUrl } from '../lib/site'
import '../styles/login.css'

// 后端回调失败时以 ?error=<code> 回到本页
const errors: Record<string, string> = {
  state: '登录请求已过期或无效，请重新登录。',
  cancelled: '登录已取消，请重试。',
  role: '此 IAM 账号暂时无法进入项目管理。请联系管理员确认账号和角色，或切换账号。',
  provider: 'IAM 登录验证未通过，请重试；如持续失败，请联系管理员检查服务配置。',
  workspace: '暂时无法确认工作空间身份，请重新登录；如持续失败，请联系管理员。',
  organization: '当前 IAM 账号不属于迈博药业业务组织，或已停用。请联系管理员，或切换账号。',
}

export default function Login() {
  const portal = usePortal()
  const project = useAuth()
  const location = useLocation()
  const [params] = useSearchParams()
  const errorCode = params.get('error') ?? ''
  const [error, setError] = useState<string | undefined>(errors[errorCode])
  const [pending, setPending] = useState(false)
  const from = (location.state as { from?: unknown } | null)?.from
  const returnTo = safeReturnPath(from, siteMode === 'pm' ? '/dashboard' : '/')
  // 本地组合预览兼容 PM 深链接；www 只使用门户会话，pm 只使用业务会话。
  const isProjectReturn = siteMode === 'pm' || (siteMode === 'combined' && !['/', '/workspace', '/account'].includes(returnTo.split('?')[0]) && !returnTo.startsWith('/launch/'))
  const { status, refresh, login, logout } = isProjectReturn ? project : portal
  const checking = USE_API && status === 'loading'
  const visibleError = error || (status === 'error' ? (isProjectReturn ? project.error : portal.error) || '暂时无法确认登录身份，请重新登录。' : undefined)

  useEffect(() => {
    if (USE_API) void refresh()
  }, [refresh])

  if (status === 'ready' && !errorCode) return <Navigate to={returnTo} replace />

  const handleLogin = async () => {
    setPending(true)
    setError(undefined)
    try {
      await login(returnTo)
    } catch {
      setError('暂时无法连接登录服务，请稍后重试。')
      setPending(false)
    }
  }

  return (
    <div className="mb-login">
      <header className="mb-login-header">
        <a className="mb-login-brand" href={workspaceUrl} aria-label="迈博药业员工应用门户">
          <img src="/brand/maibo-pharma-logo.png" alt="迈博药业" width="60" height="60" />
          <div><span className="mb-login-brand-name">迈博药业</span><span className="mb-login-brand-caption">{siteMode === 'pm' ? '研发项目管理' : '员工应用门户'}</span></div>
        </a>
        <div className="mb-login-header-note"><ShieldCheck aria-hidden="true" size={17} /> 统一身份 · 协同工作</div>
      </header>

      <main className="mb-login-main">
        <section className="mb-login-intro" aria-labelledby="mb-login-intro-title">
          <div className="mb-login-intro-content">
            <div className="mb-login-eyebrow"><span /> MAIBO WORKSPACE</div>
            <h1 id="mb-login-intro-title">连接团队，<br />让工作更专注。</h1>
            <p className="mb-login-intro-description">一个工作入口，连接项目与知识。<br />使用迈博账号登录，开启您的工作空间。</p>
            <div className="mb-login-app-preview" aria-label="工作应用">
              <div className="mb-login-preview-item">
                <span className="mb-login-preview-icon"><FolderKanban size={23} aria-hidden="true" /></span>
                <div><h2>项目管理</h2><p>统筹研发进度，协同推进项目</p></div>
              </div>
              <div className="mb-login-preview-item">
                <span className="mb-login-preview-icon"><BookOpen size={23} aria-hidden="true" /></span>
                <div><h2>知识库</h2><p>沉淀团队知识，连接经验与实践</p></div>
              </div>
            </div>
            <div className="mb-login-intro-footnote"><span /> 迈博药业 · 数字化工作空间</div>
          </div>
          <div className="mb-login-orbit mb-login-orbit-one" aria-hidden="true" />
          <div className="mb-login-orbit mb-login-orbit-two" aria-hidden="true" />
        </section>

        <section className="mb-login-panel" aria-labelledby="mb-login-title">
          <div className="mb-login-card">
            <div className="mb-login-card-mark"><ShieldCheck size={28} strokeWidth={1.7} aria-hidden="true" /></div>
            <div className="mb-login-card-eyebrow">欢迎使用迈博工作空间</div>
            <h2 id="mb-login-title">登录，开启今天的工作</h2>
            <p className="mb-login-card-description">{isProjectReturn ? '登录后进入项目管理，继续您的工作。' : <>登录后选择项目管理或知识库，<br />继续您的工作。</>}</p>
            <div className="mb-login-identity">
              <ShieldCheck size={19} aria-hidden="true" />
              <div><strong>迈博统一身份登录</strong><span>使用 IAM 平台中的员工账号</span></div>
            </div>
            {visibleError && <p role="alert" className="mb-login-error">{visibleError}</p>}
            <button type="button" className="mb-login-submit" disabled={pending || checking || !USE_API} aria-busy={pending || checking} onClick={handleLogin}>
              {pending || checking ? <Loader2 size={20} className="mb-login-spinner" aria-hidden="true" /> : <ArrowRight size={20} aria-hidden="true" />}
              {checking ? '正在确认登录状态…' : pending ? '正在前往登录…' : isProjectReturn ? '登录项目管理' : '使用迈博账号登录'}
            </button>
            {!USE_API && import.meta.env.DEV && <Link className="mb-login-preview-link" to="/?preview=1">界面预览 <ArrowRight size={16} aria-hidden="true" /></Link>}
            {(errorCode === 'role' || errorCode === 'provider' || errorCode === 'organization' || status === 'error') && (
              <button type="button" className="mb-login-switch" disabled={pending} onClick={logout}><LogOut size={16} aria-hidden="true" /> 切换账号</button>
            )}
            <p className="mb-login-management">所有用户信息在{' '}<a href={iamLoginUrl} target="_blank" rel="noopener noreferrer">IAM 平台</a>{' '}管理</p>
          </div>
          <p className="mb-login-help">如需开通账号或调整应用权限，请联系管理员。<br /><a href={siteMode === 'pm' ? 'https://www.openlims.ai/help' : '/help'}>查看使用帮助</a></p>
        </section>
      </main>
      <footer className="mb-login-footer"><span>迈博药业</span><span>项目协同 · 知识共享</span></footer>
    </div>
  )
}
