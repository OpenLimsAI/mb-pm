import { useEffect, useState, type FormEvent } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { ArrowLeft, ArrowRight, CheckCircle2, Loader2, UserPlus } from 'lucide-react'
import { getAuthConfig, register } from '../api/auth'
import { USE_API } from '../api/client'
import { useAuth } from '../store/auth'
import { Button, Field } from '../components/ui'
import { AuthShell } from '../components/auth/AuthShell'
import { roleLabels } from '../lib/permissions'
import {
  accountError, emailProblem, normalizeUsername, passwordProblem, usernameProblem,
  PASSWORD_HINT, USERNAME_HINT,
} from '../lib/account'
import type { Role } from '../types'

type Fields = 'username' | 'displayName' | 'email' | 'password' | 'confirm'
const EMPTY: Record<Fields, string> = { username: '', displayName: '', email: '', password: '', confirm: '' }

// 自助注册：后端在迈博 IAM 建号（默认执行层角色）并建好业务账号，之后走正常的 IAM 登录。
export default function Register() {
  const status = useAuth((s) => s.status)
  const refresh = useAuth((s) => s.refresh)
  const login = useAuth((s) => s.login)
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [form, setForm] = useState(EMPTY)
  const [submitted, setSubmitted] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [created, setCreated] = useState<{ username: string; role: Role } | null>(null)

  useEffect(() => {
    if (USE_API) void refresh()
  }, [refresh])

  useEffect(() => {
    if (!USE_API) return
    let active = true
    getAuthConfig()
      .then((config) => { if (active) setEnabled(config.signupEnabled) })
      .catch(() => { if (active) setError('暂时无法连接登录服务，请稍后重试。') })
    return () => { active = false }
  }, [])

  if (!USE_API || status === 'ready' || status === 'offline') return <Navigate to="/" replace />

  const problems: Record<Fields, string | null> = {
    username: usernameProblem(form.username),
    displayName: form.displayName.trim() ? (form.displayName.trim().length > 50 ? '姓名最多 50 个字符' : null) : '请填写姓名',
    email: emailProblem(form.email),
    password: passwordProblem(form.password),
    confirm: form.confirm === form.password ? null : '两次输入的密码不一致',
  }
  const invalid = Object.values(problems).some(Boolean)
  const set = (field: Fields) => (value: string) => { setForm({ ...form, [field]: value }); setError('') }

  async function submit(event: FormEvent) {
    event.preventDefault()
    setSubmitted(true)
    if (invalid || pending) return
    setPending(true)
    setError('')
    try {
      setCreated(await register({
        username: normalizeUsername(form.username),
        displayName: form.displayName.trim(),
        email: form.email.trim(),
        password: form.password,
      }))
      setForm(EMPTY)
    } catch (err) {
      setError(accountError(err))
    } finally {
      setPending(false)
    }
  }

  if (created) {
    return (
      <AuthShell>
        <div className="flex items-center gap-2 text-emerald-700 mb-3">
          <CheckCircle2 className="w-5 h-5" />
          <h1 className="text-xl font-semibold text-ink-900">账号已创建</h1>
        </div>
        <p className="text-sm text-ink-700 leading-relaxed">
          用户名 <b className="font-mono">{created.username}</b>，默认角色「{roleLabels[created.role] ?? created.role}」。
          请使用新账号登录迈博 IAM；如需其他角色或加入项目，请联系管理员。
        </p>
        <Button className="w-full mt-7" variant="primary" size="lg" onClick={() => void login('/')} icon={<ArrowRight className="w-4 h-4" />}>
          使用新账号登录
        </Button>
      </AuthShell>
    )
  }

  return (
    <AuthShell>
      <h1 className="text-xl font-semibold text-ink-900 mb-2 flex items-center gap-2">
        <UserPlus className="w-5 h-5 text-brand-600" />注册新账号
      </h1>
      <p className="text-sm text-ink-500 leading-relaxed">
        账号建在迈博 IAM 中，用于登录本系统。新账号默认为「{roleLabels.rd}」角色，可见范围随后由管理员分配。
      </p>
      {enabled === false ? (
        <p role="status" className="mt-6 p-3 rounded-lg bg-amber-50 text-amber-800 text-sm">当前未开放自助注册，请联系管理员开通账号。</p>
      ) : (
        <form className="mt-6 space-y-4" onSubmit={submit} noValidate>
          <fieldset disabled={pending || enabled === null} className="space-y-4">
            <Field label="用户名" hint={USERNAME_HINT} error={submitted || form.username ? problems.username : null}>
              <input className="input font-mono" value={form.username} onChange={(e) => set('username')(e.target.value)} autoComplete="username" spellCheck={false} autoFocus />
            </Field>
            <Field label="姓名" hint="在项目、任务中显示的名字" error={submitted ? problems.displayName : null}>
              <input className="input" value={form.displayName} onChange={(e) => set('displayName')(e.target.value)} autoComplete="name" maxLength={50} />
            </Field>
            <Field label="邮箱" error={submitted ? problems.email : null}>
              <input className="input" type="email" value={form.email} onChange={(e) => set('email')(e.target.value)} autoComplete="email" maxLength={120} />
            </Field>
            <Field label="密码" hint={PASSWORD_HINT} error={submitted || form.password ? problems.password : null}>
              <input className="input" type="password" value={form.password} onChange={(e) => set('password')(e.target.value)} autoComplete="new-password" maxLength={64} />
            </Field>
            <Field label="确认密码" error={submitted || form.confirm ? problems.confirm : null}>
              <input className="input" type="password" value={form.confirm} onChange={(e) => set('confirm')(e.target.value)} autoComplete="new-password" maxLength={64} />
            </Field>
          </fieldset>
          {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
          <Button
            type="submit"
            className="w-full"
            variant="primary"
            size="lg"
            disabled={pending || enabled === null || (submitted && invalid)}
            icon={pending ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
          >
            {pending ? '正在创建账号…' : '注册'}
          </Button>
        </form>
      )}
      <Link to="/login" className="mt-6 text-sm text-ink-600 hover:text-ink-900 flex items-center justify-center gap-1">
        <ArrowLeft className="w-4 h-4" />已有账号，返回登录
      </Link>
    </AuthShell>
  )
}
