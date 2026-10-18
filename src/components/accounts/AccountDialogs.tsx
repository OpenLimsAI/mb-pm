// 账号管理的对话框（仅系统管理员）：新建账号、编辑账号（资料与身份 / 用户名 / 重置密码 / 停用与删除 四页）、
// 开通说明（密码只显示这一次）。项目管理、知识库默认对所有人开放，这里只设身份与成员档案。
import { useEffect, useId, useState, type ReactNode } from 'react'
import { AlertTriangle, Check, Copy, Eye, EyeOff, Loader2, Power, RefreshCw, Trash2, X } from 'lucide-react'
import { Button } from '../ui'
import { cn } from '../../lib/cn'
import { accountError, normalizeUsername, passwordProblem, PASSWORD_HINT, usernameProblem, USERNAME_HINT } from '../../lib/account'
import { credentialText, generatePassword, IDENTITY_OPTIONS, IDENTITY_ROLE, specialtyGroups } from '../../lib/accountAdmin'
import { portalPublicUrl } from '../../lib/site'
import {
  createAccount, deleteAccount, renameAccount, resetAccountPassword, updateAccount,
  type Account, type AccountUpdateInput, type Identity,
} from '../../api/accounts'
import type { SpecialtyGroup } from '../../types'

const ORG_ADMIN_TIP = '该账号是 IAM 组织管理员，只能在 IAM 管理台操作。'

function Modal({ title, onClose, busy, wide, tabs, children }: {
  title: string
  onClose: () => void
  busy?: boolean
  wide?: boolean
  tabs?: ReactNode
  children: ReactNode
}) {
  const titleId = useId()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="absolute inset-0 bg-black/40" onClick={() => !busy && onClose()} />
      <div className={cn('relative w-full max-h-[92vh] bg-white rounded-xl shadow-2xl flex flex-col', wide ? 'max-w-[620px]' : 'max-w-[460px]')}>
        <div className="flex items-center gap-2 px-5 pt-4 pb-3">
          <h2 id={titleId} className="text-base font-semibold text-ink-900 flex-1 min-w-0 truncate">{title}</h2>
          <button onClick={onClose} disabled={busy} className="p-1.5 rounded-md hover:bg-ink-100 text-ink-500" aria-label="关闭">
            <X className="w-4 h-4" />
          </button>
        </div>
        {tabs ?? <div className="border-b border-ink-300/40" />}
        {children}
      </div>
    </div>
  )
}

const Body = ({ children }: { children: ReactNode }) => <div className="px-5 py-4 space-y-4 overflow-y-auto flex-1 min-h-0">{children}</div>
const Footer = ({ children }: { children: ReactNode }) => <div className="px-5 py-3 border-t border-ink-300/40 flex items-center justify-end gap-2">{children}</div>
const Spinner = () => <Loader2 className="w-3.5 h-3.5 animate-spin" />

function FieldLabel({ label, required, children, hint, error }: { label: string; required?: boolean; children: ReactNode; hint?: string; error?: string | null }) {
  return (
    <label className="block">
      <span className="text-xs text-ink-500">{label}{required && <span className="text-red-500"> *</span>}</span>
      {children}
      {error ? <span className="block text-[11px] text-red-600 mt-1">{error}</span>
        : hint && <span className="block text-[11px] text-ink-500 mt-1">{hint}</span>}
    </label>
  )
}

function ErrorLine({ message }: { message: string | null }) {
  if (!message) return null
  return <div role="alert" className="text-xs text-red-600 flex items-start gap-1.5"><AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />{message}</div>
}

function Notice({ children }: { children: ReactNode }) {
  return <div className="rounded-lg bg-ink-100/70 p-3.5 text-sm text-ink-700">{children}</div>
}

// —— 密码：输入两次；「自动生成」同时填好两栏并显示出来 —— //

interface PasswordPairValue { password: string; confirm: string }

const passwordReady = ({ password, confirm }: PasswordPairValue) => !passwordProblem(password) && password === confirm

function PasswordPair({ label, hint, value, onChange }: {
  label: string
  hint: string
  value: PasswordPairValue
  onChange: (v: PasswordPairValue) => void
}) {
  const [visible, setVisible] = useState(false)
  const problem = value.password ? passwordProblem(value.password) : null
  const mismatch = value.confirm && value.confirm !== value.password ? '两次输入的密码不一致' : null
  const type = visible ? 'text' : 'password'
  const generate = () => {
    const password = generatePassword()
    onChange({ password, confirm: password })
    setVisible(true)
  }
  return (
    <div className="space-y-3">
      <FieldLabel label={label} required hint={hint} error={problem}>
        <div className="mt-1 flex gap-2">
          <div className="relative flex-1">
            <input className={cn('input font-mono pr-9', problem && 'border-red-400')} type={type} value={value.password}
              onChange={(e) => onChange({ ...value, password: e.target.value })} autoComplete="new-password" spellCheck={false} />
            <button type="button" onClick={() => setVisible(!visible)} className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-500 hover:text-ink-700" aria-label={visible ? '隐藏密码' : '显示密码'}>
              {visible ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
          <Button type="button" icon={<RefreshCw className="w-3.5 h-3.5" />} onClick={generate}>自动生成</Button>
        </div>
      </FieldLabel>
      <FieldLabel label={`确认${label}`} required error={mismatch} hint="请再输入一次。">
        <input className={cn('input mt-1 font-mono', mismatch && 'border-red-400')} type={type} value={value.confirm}
          onChange={(e) => onChange({ ...value, confirm: e.target.value })} autoComplete="new-password" spellCheck={false} />
      </FieldLabel>
    </div>
  )
}

// —— 身份与成员档案 —— //

const missing = (role: string) => `当前 IAM 里还没有 ${role} 角色`

function IdentityField({ value, onChange, available, locked }: {
  value: Identity
  onChange: (v: Identity) => void
  available: string[]
  locked?: boolean
}) {
  const current = IDENTITY_OPTIONS.find((o) => o.value === value) ?? IDENTITY_OPTIONS[0]
  const has = (v: Identity) => IDENTITY_ROLE[v] === null || available.includes(IDENTITY_ROLE[v] as string)
  return (
    <div>
      <span className="block text-xs text-ink-500">身份</span>
      <div className="mt-1 grid sm:grid-cols-3 gap-2" role="radiogroup" aria-label="身份">
        {IDENTITY_OPTIONS.map((o) => {
          const selected = value === o.value
          return (
            <button key={o.value} type="button" role="radio" aria-checked={selected}
              disabled={locked ? !selected : !has(o.value)} title={has(o.value) ? undefined : missing(IDENTITY_ROLE[o.value] ?? '')}
              onClick={() => onChange(o.value)}
              className={cn('rounded-md border px-3 py-2 text-left text-sm disabled:opacity-40 disabled:cursor-not-allowed',
                selected ? 'border-brand-600 bg-brand-50 text-brand-800 font-medium' : 'border-ink-300 bg-white text-ink-700 hover:bg-ink-100')}>
              {o.label}
            </button>
          )
        })}
      </div>
      <span className={cn('block text-[11px] mt-1', value === 'admin' ? 'text-amber-700' : 'text-ink-500')}>
        {locked ? '不能取消自己的系统管理员身份。' : current.hint}</span>
      <span className="block text-[11px] text-ink-500 mt-1">项目管理和知识库（编辑）默认对所有人开放。</span>
    </div>
  )
}

interface Profile { specialtyGroup: SpecialtyGroup | ''; weeklyHours: string }

const hoursProblem = (hours: string) => {
  const n = Number(hours)
  return hours === '' || !Number.isInteger(n) || n < 0 || n > 80 ? '请输入 0–80 的整数' : null
}

function ProfileFields({ value, onChange }: { value: Profile; onChange: (v: Profile) => void }) {
  return (
    <div className="grid sm:grid-cols-2 gap-3">
      <FieldLabel label="专业组" hint="用于人员负荷和任务分配。">
        <select className="input mt-1" value={value.specialtyGroup} onChange={(e) => onChange({ ...value, specialtyGroup: e.target.value as SpecialtyGroup | '' })}>
          <option value="">无</option>
          {specialtyGroups.map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
      </FieldLabel>
      <FieldLabel label="每周可用工时" error={hoursProblem(value.weeklyHours)}>
        <input className={cn('input mt-1', hoursProblem(value.weeklyHours) && 'border-red-400')} type="number" min={0} max={80}
          value={value.weeklyHours} onChange={(e) => onChange({ ...value, weeklyHours: e.target.value })} />
      </FieldLabel>
    </div>
  )
}

export interface Credentials { kind: 'created' | 'reset'; displayName: string; username: string; password: string }

const emailProblemOf = (email: string) => (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ? '邮箱格式不正确' : null)
const nameProblemOf = (name: string) => (name.trim().length > 50 ? '最多 50 个字' : null)

// —— 新建账号 —— //

/** 新建账号；成功后交回初始密码，由调用方显示开通说明。 */
export function CreateAccountDialog({ preset, available, onClose, onCreated }: {
  preset?: { username?: string; displayName?: string }
  available: string[]
  onClose: () => void
  onCreated: (c: Credentials) => void
}) {
  const [displayName, setDisplayName] = useState(preset?.displayName ?? '')
  const [username, setUsername] = useState(preset?.username ?? '')
  const [password, setPassword] = useState<PasswordPairValue>({ password: '', confirm: '' })
  const [email, setEmail] = useState('')
  const [identity, setIdentity] = useState<Identity>('staff')
  const [profile, setProfile] = useState<Profile>({ specialtyGroup: '', weeklyHours: '40' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const userProblem = username ? usernameProblem(username) : null
  const ready = !!displayName.trim() && !nameProblemOf(displayName) && !emailProblemOf(email) && !!username && !userProblem
    && passwordReady(password) && !hoursProblem(profile.weeklyHours)

  const submit = async () => {
    if (!ready || saving) return
    setSaving(true)
    setError(null)
    try {
      const name = normalizeUsername(username)
      await createAccount({
        username: name, displayName: displayName.trim(), password: password.password, email: email.trim() || undefined,
        identity, specialtyGroup: profile.specialtyGroup || null, weeklyHours: Number(profile.weeklyHours),
      })
      onCreated({ kind: 'created', displayName: displayName.trim(), username: name, password: password.password })
    } catch (e) {
      setError(accountError(e))
      setSaving(false)
    }
  }

  return (
    <Modal title="新建账号" onClose={onClose} busy={saving} wide>
      <Body>
        <div className="grid sm:grid-cols-2 gap-3">
          <FieldLabel label="姓名" required error={nameProblemOf(displayName)}>
            <input className="input mt-1" value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={60} autoFocus placeholder="如：邓爱鹏" />
          </FieldLabel>
          <FieldLabel label="用户名（登录用）" required hint={USERNAME_HINT} error={userProblem}>
            <input className={cn('input mt-1 font-mono', userProblem && 'border-red-400')} value={username}
              onChange={(e) => setUsername(e.target.value)} maxLength={40} autoCapitalize="none" spellCheck={false} placeholder="如：dap" />
          </FieldLabel>
        </div>
        <PasswordPair label="初始密码" hint={`${PASSWORD_HINT}。对方首次登录时须修改。`} value={password} onChange={setPassword} />
        <FieldLabel label="邮箱（选填）" error={emailProblemOf(email)} hint="可用于找回密码；不填也能正常登录。">
          <input className={cn('input mt-1', emailProblemOf(email) && 'border-red-400')} type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={120} />
        </FieldLabel>
        <IdentityField value={identity} onChange={setIdentity} available={available} />
        <ProfileFields value={profile} onChange={setProfile} />
        <ErrorLine message={error} />
      </Body>
      <Footer>
        <Button disabled={saving} onClick={onClose}>取消</Button>
        <Button variant="primary" disabled={!ready || saving} onClick={submit} icon={saving ? <Spinner /> : <Check className="w-3.5 h-3.5" />}>
          {saving ? '创建中…' : '创建账号'}
        </Button>
      </Footer>
    </Modal>
  )
}

// —— 编辑账号：四个分页 —— //

export type AccountTab = 'profile' | 'username' | 'password' | 'status'

const TABS: { id: AccountTab; label: string }[] = [
  { id: 'profile', label: '资料与身份' },
  { id: 'username', label: '用户名' },
  { id: 'password', label: '重置密码' },
  { id: 'status', label: '停用 / 删除' },
]

function blockedReason(tab: AccountTab, account: Account): string | null {
  if (tab === 'profile') return null
  if (account.orgAdmin) return ORG_ADMIN_TIP
  if (!account.isSelf) return null
  if (tab === 'password') return '修改自己的密码请到工作台「我的设置」。'
  if (tab === 'status') return '不能停用或删除自己的账号。'
  return null
}

interface PanelProps {
  account: Account
  busy: boolean
  setBusy: (busy: boolean) => void
  onClose: () => void
}

/** 编辑账号（系统管理员）：资料与身份、用户名、重置密码、停用 / 删除 合在一个对话框里。 */
export function AccountDialog({ account, initialTab = 'profile', available, onClose, onSaved, onPasswordReset }: {
  account: Account
  initialTab?: AccountTab
  available: string[]
  onClose: () => void
  onSaved: (message: string) => void
  onPasswordReset: (c: Credentials) => void
}) {
  const [tab, setTab] = useState<AccountTab>(initialTab)
  const [busy, setBusy] = useState(false)
  const blocked = blockedReason(tab, account)
  const panel: PanelProps = { account, busy, setBusy, onClose }
  const tabs = (
    <div className="px-5 border-b border-ink-300/40 flex gap-5 overflow-x-auto" role="tablist" aria-label="编辑内容">
      {TABS.map((t) => (
        <button key={t.id} role="tab" aria-selected={tab === t.id} disabled={busy} onClick={() => setTab(t.id)}
          className={cn('py-2.5 text-sm whitespace-nowrap border-b-2 -mb-px', tab === t.id ? 'border-brand-600 text-brand-700 font-medium' : 'border-transparent text-ink-500 hover:text-ink-900')}>
          {t.label}
        </button>
      ))}
    </div>
  )
  return (
    <Modal title={`编辑账号 · ${account.displayName}（${account.username}）`} onClose={onClose} busy={busy} wide tabs={tabs}>
      {blocked ? <>
        <Body><Notice>{blocked}</Notice></Body>
        <Footer><Button onClick={onClose}>关闭</Button></Footer>
      </>
        : tab === 'profile' ? <ProfilePanel {...panel} available={available} onSaved={onSaved} />
          : tab === 'username' ? <UsernamePanel {...panel} onSaved={onSaved} />
            : tab === 'password' ? <PasswordPanel {...panel} onDone={onPasswordReset} />
              : <StatusPanel {...panel} onSaved={onSaved} />}
    </Modal>
  )
}

function useSubmit(setBusy: (busy: boolean) => void) {
  const [error, setError] = useState<string | null>(null)
  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (e) {
      setError(accountError(e))
      setBusy(false)
    }
  }
  return { error, run }
}

function ProfilePanel({ account, busy, setBusy, onClose, available, onSaved }: PanelProps & { available: string[]; onSaved: (m: string) => void }) {
  const [displayName, setDisplayName] = useState(account.displayName)
  const [email, setEmail] = useState(account.email)
  const [identity, setIdentity] = useState<Identity>(account.identity)
  const [profile, setProfile] = useState<Profile>({
    specialtyGroup: account.pmMember?.specialtyGroup ?? '',
    weeklyHours: String(account.pmMember?.weeklyHours ?? 40),
  })
  const { error, run } = useSubmit(setBusy)
  const ready = !!displayName.trim() && !nameProblemOf(displayName) && !emailProblemOf(email) && !hoursProblem(profile.weeklyHours)

  const changes: AccountUpdateInput = {}
  if (displayName.trim() !== account.displayName) changes.displayName = displayName.trim()
  if (email.trim() !== account.email) changes.email = email.trim()
  if (identity !== account.identity) changes.identity = identity
  if (profile.specialtyGroup !== (account.pmMember?.specialtyGroup ?? '')) changes.specialtyGroup = profile.specialtyGroup
  if (Number(profile.weeklyHours) !== (account.pmMember?.weeklyHours ?? 40)) changes.weeklyHours = Number(profile.weeklyHours)
  const dirty = Object.keys(changes).length > 0

  const submit = () => run(async () => {
    await updateAccount(account.id, changes)
    const name = displayName.trim()
    onSaved('identity' in changes ? `已保存 ${name} 的修改；身份变更在对方重新登录后生效。` : `已保存 ${name} 的修改。`)
  })

  return <>
    <Body>
      <div className="grid sm:grid-cols-2 gap-3">
        <FieldLabel label="姓名" required error={nameProblemOf(displayName)}>
          <input className="input mt-1" value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={60} />
        </FieldLabel>
        <FieldLabel label="邮箱（选填）" error={emailProblemOf(email)}>
          <input className={cn('input mt-1', emailProblemOf(email) && 'border-red-400')} type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={120} />
        </FieldLabel>
      </div>
      <IdentityField value={identity} onChange={setIdentity} available={available} locked={account.isSelf && account.identity === 'admin'} />
      <ProfileFields value={profile} onChange={setProfile} />
      <ErrorLine message={error} />
    </Body>
    <Footer>
      <Button disabled={busy} onClick={onClose}>取消</Button>
      <Button variant="primary" disabled={!ready || !dirty || busy} onClick={submit} icon={busy ? <Spinner /> : <Check className="w-3.5 h-3.5" />}>保存</Button>
    </Footer>
  </>
}

function UsernamePanel({ account, busy, setBusy, onClose, onSaved }: PanelProps & { onSaved: (m: string) => void }) {
  const [username, setUsername] = useState(account.username)
  const { error, run } = useSubmit(setBusy)
  const name = normalizeUsername(username)
  const unchanged = name === account.username
  const problem = unchanged ? null : usernameProblem(username)
  const submit = () => run(async () => {
    await renameAccount(account.id, name)
    onSaved(`已把 ${account.displayName} 的用户名改为 ${name}，请告知对方用新用户名登录。`)
  })
  return <>
    <Body>
      <FieldLabel label="新用户名" hint={USERNAME_HINT} error={problem}>
        <input className={cn('input mt-1 font-mono', problem && 'border-red-400')} value={username} onChange={(e) => setUsername(e.target.value)}
          maxLength={40} autoCapitalize="none" spellCheck={false} />
      </FieldLabel>
      <p className="text-xs text-ink-500">IAM 账号、角色和项目管理成员会一起改名，权限和数据都不变。对方之后要用新用户名登录。</p>
      <ErrorLine message={error} />
    </Body>
    <Footer>
      <Button disabled={busy} onClick={onClose}>取消</Button>
      <Button variant="primary" disabled={!!problem || unchanged || busy} onClick={submit} icon={busy ? <Spinner /> : undefined}>修改用户名</Button>
    </Footer>
  </>
}

function PasswordPanel({ account, busy, setBusy, onClose, onDone }: PanelProps & { onDone: (c: Credentials) => void }) {
  const [password, setPassword] = useState<PasswordPairValue>({ password: '', confirm: '' })
  const { error, run } = useSubmit(setBusy)
  const submit = () => run(async () => {
    await resetAccountPassword(account.id, password.password)
    onDone({ kind: 'reset', displayName: account.displayName, username: account.username, password: password.password })
  })
  return <>
    <Body>
      <p className="text-sm text-ink-700">为 <b className="font-medium">{account.username}</b> 设置新密码。旧密码立即失效，对方下次登录时须再修改一次。</p>
      <PasswordPair label="新密码" hint={PASSWORD_HINT} value={password} onChange={setPassword} />
      <ErrorLine message={error} />
    </Body>
    <Footer>
      <Button disabled={busy} onClick={onClose}>取消</Button>
      <Button variant="primary" disabled={!passwordReady(password) || busy} onClick={submit} icon={busy ? <Spinner /> : undefined}>重置密码</Button>
    </Footer>
  </>
}

function StatusPanel({ account, busy, setBusy, onClose, onSaved }: PanelProps & { onSaved: (m: string) => void }) {
  const [confirming, setConfirming] = useState<'toggle' | 'delete' | null>(null)
  const [typed, setTyped] = useState('')
  const { error, run } = useSubmit(setBusy)
  const toggle = () => run(async () => {
    await updateAccount(account.id, { enabled: !account.enabled })
    onSaved(account.enabled ? `已停用 ${account.displayName}。` : `已启用 ${account.displayName}。`)
  })
  const remove = () => run(async () => {
    await deleteAccount(account.id)
    onSaved(`已删除 ${account.displayName} 的账号。`)
  })
  return <>
    <Body>
      <section className="rounded-lg border border-ink-300/60 p-3.5 space-y-2">
        <h3 className="text-sm font-medium text-ink-900">{account.enabled ? '停用账号' : '启用账号'}</h3>
        <p className="text-xs text-ink-600">
          {account.enabled ? '停用后不能再登录任何应用，项目管理立即不可用；身份和数据都保留，随时可以重新启用。'
            : '账号目前已停用。启用后可以按原有身份重新登录。'}
        </p>
        {confirming === 'toggle' ? <div className="flex items-center gap-2 pt-1">
          <span className="text-sm text-ink-900 flex-1">确定{account.enabled ? '停用' : '启用'} {account.displayName}？</span>
          <Button size="sm" disabled={busy} onClick={() => setConfirming(null)}>取消</Button>
          <Button size="sm" variant={account.enabled ? 'danger' : 'primary'} disabled={busy} onClick={toggle} icon={busy ? <Spinner /> : undefined}>
            确定{account.enabled ? '停用' : '启用'}
          </Button>
        </div> : <Button size="sm" icon={<Power className="w-3.5 h-3.5" />} disabled={busy} onClick={() => setConfirming('toggle')}>
          {account.enabled ? '停用账号' : '启用账号'}
        </Button>}
      </section>
      <section className="rounded-lg border border-red-200 bg-red-50/40 p-3.5 space-y-2">
        <h3 className="text-sm font-medium text-red-700">删除账号</h3>
        <p className="text-xs text-ink-600">
          从 IAM 删除 <b className="font-medium">{account.username}</b> 并移出全部角色，<b className="font-medium">无法恢复</b>。
          {account.pmMember && ` 项目管理成员 ${account.pmMember.username} 会被停用，其负责的项目、任务和历史记录保留。`}
          只是暂时不让登录的话，用「停用」更合适。
        </p>
        {confirming === 'delete' ? <div className="space-y-2 pt-1">
          <FieldLabel label={`请输入用户名 ${account.username} 以确认删除`}>
            <input className="input mt-1 font-mono" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus autoCapitalize="none" spellCheck={false} />
          </FieldLabel>
          <div className="flex justify-end gap-2">
            <Button size="sm" disabled={busy} onClick={() => { setConfirming(null); setTyped('') }}>取消</Button>
            <Button size="sm" variant="danger" disabled={busy || typed.trim() !== account.username} onClick={remove} icon={busy ? <Spinner /> : <Trash2 className="w-3.5 h-3.5" />}>确定删除</Button>
          </div>
        </div> : <Button size="sm" className="text-red-600" icon={<Trash2 className="w-3.5 h-3.5" />} disabled={busy} onClick={() => setConfirming('delete')}>删除账号</Button>}
      </section>
      <ErrorLine message={error} />
    </Body>
    <Footer><Button disabled={busy} onClick={onClose}>关闭</Button></Footer>
  </>
}

// —— 开通说明 —— //

/** 开通 / 重置后的说明：密码只在这里显示一次，不保存。 */
export function CredentialDialog({ credentials, onClose }: { credentials: Credentials; onClose: () => void }) {
  const text = credentialText(credentials.kind, credentials.displayName, credentials.username, credentials.password, portalPublicUrl)
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }
  return (
    <Modal title={credentials.kind === 'created' ? '账号已创建' : '密码已重置'} onClose={onClose}>
      <Body>
        <p className="text-sm text-ink-700">把下面的信息发给 {credentials.displayName}。密码<b className="font-medium">只在这里显示一次</b>，关闭后无法再查看，忘记了可以重置。</p>
        <pre className="whitespace-pre-wrap rounded-lg bg-ink-100/70 p-3.5 text-[13px] leading-6 text-ink-900 font-mono select-all">{text}</pre>
      </Body>
      <Footer>
        <Button icon={copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />} onClick={copy}>
          {copied ? '已复制' : credentials.kind === 'created' ? '复制开通说明' : '复制重置说明'}</Button>
        <Button variant="primary" onClick={onClose}>完成</Button>
      </Footer>
    </Modal>
  )
}
