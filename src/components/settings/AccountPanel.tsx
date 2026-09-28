import { useState, type FormEvent, type ReactNode } from 'react'
import { AtSign, CheckCircle2, KeyRound, Loader2, Save, UserRound } from 'lucide-react'
import { changePassword, changeUsername } from '../../api/auth'
import { refreshAllData } from '../../data/bootstrap'
import {
  accountError, normalizeUsername, passwordProblem, usernameProblem, PASSWORD_HINT, USERNAME_HINT,
} from '../../lib/account'
import { roleLabels } from '../../lib/permissions'
import { useAuth } from '../../store/auth'
import { useDataStore } from '../../store/data'
import { Avatar, Button, Field } from '../ui'

// 设置 ›「我的账号」：所有登录用户可用。用户名 / 密码保存在迈博 IAM，由后端校验当前密码后修改。
export function AccountPanel() {
  const user = useAuth((s) => s.currentUser)
  const online = useDataStore((s) => s.mode) === 'api'
  if (!user) return null

  return (
    <div className="space-y-6">
      {!online && (
        <div className="p-4 rounded-lg bg-amber-50 text-amber-800 text-sm">当前为离线演示模式，连接后端并使用 IAM 登录后才能修改账号。</div>
      )}
      <section className="card p-5">
        <h2 className="font-semibold flex items-center gap-2"><UserRound className="w-4 h-4 text-brand-600" />账号信息</h2>
        <div className="mt-4 flex items-start gap-4">
          <Avatar user={user} size="lg" />
          <dl className="flex-1 grid sm:grid-cols-2 gap-x-8 gap-y-3 text-sm">
            <Item label="用户名"><span className="font-mono">{user.username}</span></Item>
            <Item label="姓名">{user.displayName}</Item>
            <Item label="邮箱">{user.email || '—'}</Item>
            <Item label="角色">{roleLabels[user.role]}<span className="text-xs text-ink-500 ml-2">由 IAM 管理员分配</span></Item>
          </dl>
        </div>
        <p className="text-xs text-ink-500 mt-4">用户名和密码保存在迈博 IAM 中，修改后请用新的用户名 / 密码登录；项目、任务等归属不受影响。</p>
      </section>
      <div className="grid lg:grid-cols-2 gap-6 items-start">
        <UsernameForm current={user.username} disabled={!online} />
        <PasswordForm disabled={!online} />
      </div>
    </div>
  )
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-ink-500">{label}</dt>
      <dd className="text-ink-900 mt-0.5 break-all">{children}</dd>
    </div>
  )
}

function Feedback({ error, notice }: { error: string; notice: string }) {
  if (error) return <p role="alert" className="text-sm text-red-600">{error}</p>
  if (notice) return <p role="status" className="text-sm text-emerald-700 flex items-start gap-1.5"><CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />{notice}</p>
  return null
}

function UsernameForm({ current, disabled }: { current: string; disabled: boolean }) {
  const refresh = useAuth((s) => s.refresh)
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const next = normalizeUsername(name)
  const problem = !name ? null : next === current ? '新用户名与当前用户名相同' : usernameProblem(name)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!name || !password || problem || busy) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const updated = await changeUsername(next, password)
      setName('')
      setPassword('')
      setNotice(`用户名已改为 ${updated.username}，下次登录 IAM 请使用新用户名。`)
      await refresh()
      await refreshAllData().catch(() => undefined) // 成员目录里的用户名随之更新；失败不影响已完成的修改
    } catch (err) {
      setError(accountError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="card p-5 space-y-4" noValidate>
      <div>
        <h2 className="font-semibold flex items-center gap-2"><AtSign className="w-4 h-4 text-brand-600" />修改用户名</h2>
        <p className="text-sm text-ink-500 mt-1">用户名即 IAM 登录名。</p>
      </div>
      <fieldset disabled={disabled || busy} className="space-y-4">
        <Field label="新用户名" hint={USERNAME_HINT} error={problem}>
          <input className="input font-mono" value={name} onChange={(e) => { setName(e.target.value); setError(''); setNotice('') }} placeholder={current} autoComplete="username" spellCheck={false} maxLength={32} />
        </Field>
        <Field label="当前密码" hint="用于确认是您本人操作">
          <input className="input" type="password" value={password} onChange={(e) => { setPassword(e.target.value); setError('') }} autoComplete="current-password" />
        </Field>
      </fieldset>
      <Feedback error={error} notice={notice} />
      <Button type="submit" variant="primary" disabled={disabled || busy || !name || !password || !!problem} icon={busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}>
        {busy ? '正在保存…' : '保存新用户名'}
      </Button>
    </form>
  )
}

function PasswordForm({ disabled }: { disabled: boolean }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const nextProblem = !next ? null : passwordProblem(next) ?? (next === current ? '新密码不能与当前密码相同' : null)
  const confirmProblem = confirm && confirm !== next ? '两次输入的新密码不一致' : null
  const type = show ? 'text' : 'password'
  const edit = (setter: (value: string) => void) => (value: string) => { setter(value); setError(''); setNotice('') }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!current || !next || !confirm || nextProblem || confirmProblem || busy) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await changePassword(current, next)
      setCurrent('')
      setNext('')
      setConfirm('')
      setNotice('密码已修改。本系统在其他设备上的登录已退出，下次登录 IAM 请使用新密码。')
    } catch (err) {
      setError(accountError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="card p-5 space-y-4" noValidate>
      <div>
        <h2 className="font-semibold flex items-center gap-2"><KeyRound className="w-4 h-4 text-brand-600" />修改密码</h2>
        <p className="text-sm text-ink-500 mt-1">IAM 登录密码，其他接入迈博 IAM 的系统同时生效。</p>
      </div>
      <fieldset disabled={disabled || busy} className="space-y-4">
        <Field label="当前密码">
          <input className="input" type={type} value={current} onChange={(e) => edit(setCurrent)(e.target.value)} autoComplete="current-password" />
        </Field>
        <Field label="新密码" hint={PASSWORD_HINT} error={nextProblem}>
          <input className="input" type={type} value={next} onChange={(e) => edit(setNext)(e.target.value)} autoComplete="new-password" maxLength={64} />
        </Field>
        <Field label="确认新密码" error={confirmProblem}>
          <input className="input" type={type} value={confirm} onChange={(e) => edit(setConfirm)(e.target.value)} autoComplete="new-password" maxLength={64} />
        </Field>
        <label className="flex items-center gap-2 text-sm text-ink-600">
          <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />显示密码
        </label>
      </fieldset>
      <Feedback error={error} notice={notice} />
      <Button type="submit" variant="primary" disabled={disabled || busy || !current || !next || !confirm || !!nextProblem || !!confirmProblem} icon={busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}>
        {busy ? '正在修改…' : '修改密码'}
      </Button>
    </form>
  )
}
