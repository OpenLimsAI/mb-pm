// 本人改密码表单（当前密码 + 新密码两次）：工作台「我的设置」与「请先修改临时密码」共用。
// 当前密码必填：后端据此向 IAM 校验（应用凭据调用时若旧密码为空 IAM 不校验）。
import { useState, type FormEvent, type ReactNode } from 'react'
import { CheckCircle2, KeyRound, Loader2, Save } from 'lucide-react'
import { accountError, passwordProblem, PASSWORD_HINT } from '../../lib/account'
import { Button, Field } from '../ui'

export function PasswordChangeForm({ submit, disabled = false, className, title = '修改密码', description, currentLabel = '当前密码', successNotice, onDone }: {
  submit: (current: string, next: string) => Promise<void>
  disabled?: boolean
  className?: string
  title?: ReactNode
  description?: ReactNode
  currentLabel?: string
  successNotice?: string
  onDone?: () => void
}) {
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
  const ready = !!current && !!next && !!confirm && !nextProblem && !confirmProblem

  async function handle(event: FormEvent) {
    event.preventDefault()
    if (!ready || busy) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await submit(current, next)
      setCurrent('')
      setNext('')
      setConfirm('')
      setNotice(successNotice ?? '密码已修改，所有登录已退出，请使用新密码重新登录。')
      setBusy(false)
      onDone?.()
    } catch (err) {
      setError(accountError(err))
      setBusy(false)
    }
  }

  return (
    <form onSubmit={handle} className={className ?? 'card p-5 space-y-4'} noValidate>
      <div>
        <h2 className="font-semibold flex items-center gap-2"><KeyRound className="w-4 h-4 text-brand-600" />{title}</h2>
        {description && <p className="text-sm text-ink-500 mt-1">{description}</p>}
      </div>
      <fieldset disabled={disabled || busy} className="space-y-4">
        <Field label={currentLabel}>
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
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {notice && !error && <p role="status" className="text-sm text-emerald-700 flex items-start gap-1.5"><CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />{notice}</p>}
      <Button type="submit" variant="primary" disabled={disabled || busy || !ready} icon={busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}>
        {busy ? '正在修改…' : '修改密码'}
      </Button>
    </form>
  )
}
