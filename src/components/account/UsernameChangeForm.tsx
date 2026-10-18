// 本人改用户名表单（新用户名 + 当前密码）：工作台「我的设置」使用。
// 用户名即 IAM 登录名；后端校验当前密码后改 IAM 用户名，项目管理成员的用户名一并更新。
import { useState, type FormEvent } from 'react'
import { AtSign, CheckCircle2, Loader2, Save } from 'lucide-react'
import { accountError, normalizeUsername, usernameProblem, USERNAME_HINT } from '../../lib/account'
import { Button, Field } from '../ui'

export function UsernameChangeForm({ current, submit, disabled = false, className, onDone }: {
  current: string
  submit: (newUsername: string, currentPassword: string) => Promise<{ username: string }>
  disabled?: boolean
  className?: string
  onDone?: () => void | Promise<void>
}) {
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const next = normalizeUsername(name)
  const problem = !name ? null : next === current ? '新用户名与当前用户名相同' : usernameProblem(name)

  async function handle(event: FormEvent) {
    event.preventDefault()
    if (!name || !password || problem || busy) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const updated = await submit(next, password)
      setName('')
      setPassword('')
      setNotice(`用户名已改为 ${updated.username}，下次登录请使用新用户名。`)
      await onDone?.()
    } catch (err) {
      setError(accountError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={handle} className={className ?? 'card p-5 space-y-4'} noValidate>
      <div>
        <h2 className="font-semibold flex items-center gap-2"><AtSign className="w-4 h-4 text-brand-600" />修改用户名</h2>
        <p className="text-sm text-ink-500 mt-1">用户名即登录名，在门户、项目管理和知识库中通用；项目、任务等归属不受影响。</p>
      </div>
      <fieldset disabled={disabled || busy} className="space-y-4">
        <Field label="新用户名" hint={USERNAME_HINT} error={problem}>
          <input className="input font-mono" value={name} onChange={(e) => { setName(e.target.value); setError(''); setNotice('') }} placeholder={current} autoComplete="username" spellCheck={false} maxLength={32} />
        </Field>
        <Field label="当前密码" hint="用于确认是您本人操作">
          <input className="input" type="password" value={password} onChange={(e) => { setPassword(e.target.value); setError('') }} autoComplete="current-password" />
        </Field>
      </fieldset>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {notice && !error && <p role="status" className="text-sm text-emerald-700 flex items-start gap-1.5"><CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />{notice}</p>}
      <Button type="submit" variant="primary" disabled={disabled || busy || !name || !password || !!problem} icon={busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}>
        {busy ? '正在保存…' : '保存新用户名'}
      </Button>
    </form>
  )
}
