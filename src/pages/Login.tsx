import { useEffect, useState } from 'react'
import { Navigate, useLocation, useSearchParams } from 'react-router-dom'
import { ArrowRight, LogOut, ShieldCheck } from 'lucide-react'
import { USE_API } from '../api/client'
import { useAuth } from '../store/auth'
import { Button } from '../components/ui'
import { AuthShell } from '../components/auth/AuthShell'

// 后端回调失败时以 ?error=<code> 回到本页
const errors: Record<string, string> = {
  state: '登录请求已过期或无效，请重新登录。',
  cancelled: '登录已取消，请重试。',
  role: '此 IAM 账号尚未关联有效的项目管理用户，或未分配唯一的项目管理角色。请联系管理员，或切换账号。',
  provider: 'IAM 登录验证未通过，请重试；如持续失败，请联系管理员检查服务配置。',
}

export default function Login() {
  const status = useAuth((s) => s.status)
  const refresh = useAuth((s) => s.refresh)
  const login = useAuth((s) => s.login)
  const logout = useAuth((s) => s.logout)
  const location = useLocation()
  const [params] = useSearchParams()
  const errorCode = params.get('error') ?? ''
  const [error, setError] = useState<string | undefined>(errors[errorCode])
  const [pending, setPending] = useState(false)

  // 已登录时访问 /login（书签、后退）直接回到系统
  useEffect(() => {
    if (USE_API) void refresh()
  }, [refresh])

  if (!USE_API || status === 'ready' || status === 'offline') return <Navigate to="/" replace />

  const handleLogin = async () => {
    setPending(true)
    setError(undefined)
    try {
      const from = (location.state as { from?: string } | null)?.from
      await login(from && from.startsWith('/') && from !== '/login' ? from : '/')
    } catch {
      setError('暂时无法连接登录服务，请稍后重试。')
      setPending(false)
    }
  }

  return (
    <AuthShell>
      <h1 className="text-xl font-semibold text-ink-900 mb-3">迈博统一身份登录</h1>
      <p className="text-sm text-ink-500 leading-relaxed">
        使用迈博 IAM 账号登录。可见的项目范围与可执行的操作由您在 IAM 中分配的角色决定。
      </p>
      <div className="flex items-center gap-2 text-sm text-ink-600 mt-5">
        <ShieldCheck className="w-4 h-4" /> 由迈博 IAM（mb-casd）统一验证身份
      </div>
      {error && <p role="alert" className="text-sm text-red-600 mt-5">{error}</p>}
      <Button
        className="w-full mt-7"
        variant="primary"
        size="lg"
        disabled={pending}
        onClick={handleLogin}
        icon={<ArrowRight className="w-4 h-4" />}
      >
        {pending ? '正在前往登录…' : '使用 IAM 账号登录'}
      </Button>
      {(errorCode === 'role' || errorCode === 'provider') && (
        // IAM 仍保留着 SSO 会话时，重新登录会自动沿用同一账号：先在 IAM 退出再换账号。
        <Button className="w-full mt-2" variant="ghost" onClick={logout} icon={<LogOut className="w-4 h-4" />}>
          切换账号
        </Button>
      )}
      <p className="text-sm text-ink-500 text-center mt-6">所有用户信息在iam平台管理</p>
    </AuthShell>
  )
}
