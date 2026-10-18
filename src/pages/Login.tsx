import { useEffect, useState, type FormEvent } from 'react'
import { Link, Navigate, useLocation, useSearchParams } from 'react-router-dom'
import { ArrowRight, BookOpen, Eye, EyeOff, FolderKanban, Loader2, LockKeyhole, LogOut, ShieldCheck, UserRound } from 'lucide-react'
import { USE_API } from '../api/client'
import { hasIamSession, IamUnreachable, LoginRejected, NeedsIamPage, signInWithPassword, signInWithSession, startLogin } from '../api/iamLogin'
import { useAuth } from '../store/auth'
import { usePortal } from '../store/portal'
import { safeReturnPath, siteMode, workspaceUrl } from '../lib/site'
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
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [autoSignin, setAutoSignin] = useState(true)
  // 浏览器里已有 IAM 登录会话（如刚在项目管理登录过）：直接单点登录，不再要求输入密码
  const [ssoRedirect, setSsoRedirect] = useState(false)
  const from = (location.state as { from?: unknown } | null)?.from
  const returnTo = safeReturnPath(from, siteMode === 'pm' ? '/dashboard' : '/')
  // 本地组合预览兼容 PM 深链接；www 只使用门户会话，pm 只使用业务会话。
  // 门户页面（App.tsx 中 PortalGate 下的路由）须列在这里，否则组合预览会在登录页与门户页之间来回跳转。
  const isProjectReturn = siteMode === 'pm' || (siteMode === 'combined' && !['/', '/workspace', '/account', '/accounts', '/settings'].includes(returnTo.split('?')[0]) && !returnTo.startsWith('/launch/'))
  const { status, refresh, login, logout } = isProjectReturn ? project : portal
  const checking = USE_API && status === 'loading'
  const visibleError = error || (status === 'error' ? (isProjectReturn ? project.error : portal.error) || '暂时无法确认登录身份，请重新登录。' : undefined)

  useEffect(() => {
    if (USE_API) void refresh()
  }, [refresh])

  const kind = isProjectReturn ? 'pm' : 'portal'
  useEffect(() => {
    // 登录出错回到本页时（?error=）不自动登录，避免反复跳转
    if (!USE_API || status !== 'anonymous' || errorCode) return
    let active = true
    void hasIamSession(kind).then(async (signedIn) => {
      if (!active || !signedIn) return
      setSsoRedirect(true)
      try {
        // 单点登录：用 IAM 会话直接换授权码，再走原有回调；失败时照常显示登录表单
        window.location.assign(await signInWithSession(await startLogin(kind, returnTo)))
      } catch {
        if (active) setSsoRedirect(false)
      }
    })
    return () => { active = false }
  }, [status, errorCode, kind, returnTo])

  if (status === 'ready' && !errorCode) return <Navigate to={returnTo} replace />

  // 用户名 / 密码直接在这里登录（提交到迈博 IAM，不经过本系统后端），不再跳到 IAM 登录页面
  const handleLogin = async (event: FormEvent) => {
    event.preventDefault()
    const name = username.trim()
    if (!name || !password || pending || ssoRedirect) {
      setError(!name ? '请输入用户名。' : !password ? '请输入密码。' : undefined)
      return
    }
    setPending(true)
    setError(undefined)
    try {
      const start = await startLogin(kind, returnTo)
      window.location.assign(await signInWithPassword(start, name, password, autoSignin))
    } catch (err) {
      if (err instanceof LoginRejected) {
        setError(err.message)
        setPassword('')
        setPending(false)
      } else if (err instanceof IamUnreachable || err instanceof NeedsIamPage) {
        // 浏览器连不上 IAM（网络或跨域策略），或还需在 IAM 完成两步验证等步骤：改为跳转 IAM 登录页，保证仍能登录
        setError(err instanceof NeedsIamPage ? '需要在迈博统一身份平台完成验证，正在打开…' : '暂时无法在此页面完成登录，正在打开迈博统一身份登录页…')
        await login(returnTo).catch(() => {
          setError('暂时无法连接登录服务，请稍后重试。')
          setPending(false)
        })
      } else {
        setError('暂时无法连接登录服务，请稍后重试。')
        setPending(false)
      }
    }
  }
  // 确认登录状态期间输入框仍可用（不打断自动聚焦与自动填充），只禁用登录按钮
  const inputsDisabled = pending || ssoRedirect || !USE_API
  const busy = pending || checking || ssoRedirect

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
            <form className="mb-login-form" onSubmit={handleLogin} noValidate aria-describedby="mb-login-identity-note">
              <p id="mb-login-identity-note" className="mb-login-identity-note"><ShieldCheck size={15} aria-hidden="true" />迈博统一身份登录 · 使用迈博员工账号</p>
              <div className="mb-login-field">
                <label htmlFor="mb-login-username">用户名</label>
                <div className="mb-login-input">
                  <UserRound size={18} aria-hidden="true" />
                  <input id="mb-login-username" value={username} onChange={(e) => { setUsername(e.target.value); setError(undefined) }} disabled={inputsDisabled}
                    autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={64} placeholder="用户名、邮箱或手机号" autoFocus />
                </div>
              </div>
              <div className="mb-login-field">
                <label htmlFor="mb-login-password">密码</label>
                <div className="mb-login-input">
                  <LockKeyhole size={18} aria-hidden="true" />
                  <input id="mb-login-password" type={showPassword ? 'text' : 'password'} value={password} onChange={(e) => { setPassword(e.target.value); setError(undefined) }} disabled={inputsDisabled}
                    autoComplete="current-password" maxLength={128} placeholder="密码" />
                  <button type="button" className="mb-login-reveal" onClick={() => setShowPassword((v) => !v)} aria-label={showPassword ? '隐藏密码' : '显示密码'} aria-pressed={showPassword}>
                    {showPassword ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
                  </button>
                </div>
              </div>
              <div className="mb-login-options">
                <label><input type="checkbox" checked={autoSignin} onChange={(e) => setAutoSignin(e.target.checked)} disabled={inputsDisabled} />下次自动登录</label>
                <span>忘记密码请联系系统管理员</span>
              </div>
              {visibleError && <p role="alert" className="mb-login-error">{visibleError}</p>}
              <button type="submit" className="mb-login-submit" disabled={busy || !USE_API} aria-busy={busy}>
                {busy ? <Loader2 size={20} className="mb-login-spinner" aria-hidden="true" /> : <ArrowRight size={20} aria-hidden="true" />}
                {ssoRedirect ? '已登录迈博统一身份，正在进入…' : checking ? '正在确认登录状态…' : pending ? '正在登录…' : isProjectReturn ? '登录项目管理' : '登录'}
              </button>
            </form>
            {!USE_API && import.meta.env.DEV && <Link className="mb-login-preview-link" to="/?preview=1">界面预览 <ArrowRight size={16} aria-hidden="true" /></Link>}
            {(errorCode === 'role' || errorCode === 'provider' || errorCode === 'organization' || status === 'error') && (
              <button type="button" className="mb-login-switch" disabled={pending} onClick={logout}><LogOut size={16} aria-hidden="true" /> 切换账号</button>
            )}
          </div>
          <p className="mb-login-help">如需开通账号、重置密码或调整权限，请联系系统管理员。<br /><a href={siteMode === 'pm' ? 'https://www.openlims.ai/help' : '/help'}>查看使用帮助</a></p>
        </section>
      </main>
      <footer className="mb-login-footer"><span>迈博药业</span><span>项目协同 · 知识共享</span></footer>
    </div>
  )
}
