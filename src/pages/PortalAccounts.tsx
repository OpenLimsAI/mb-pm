// 门户「账号管理」：IAM 的简化版，也是组织成员的唯一修改入口。系统管理员新建账号、设身份、维护专业组 / 周工时；
// 项目负责人只能查看。数据每次直接读 IAM，修改直接写回 IAM；项目管理成员档案由后端随账号同步。
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle, CheckCircle2, Loader2, LogIn, Pencil, RefreshCw, Search, Trash2, UserPlus, Wrench,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import PortalLayout from '../components/portal/PortalLayout'
import { usePortalContext } from '../components/portal/context'
import { Button, Tag } from '../components/ui'
import {
  AccountDialog, CreateAccountDialog, CredentialDialog, type AccountTab, type Credentials,
} from '../components/accounts/AccountDialogs'
import { fetchAccounts, repairAccount, type Account, type AccountIssue, type ActorTier } from '../api/accounts'
import { accountError } from '../lib/account'
import { identityLabel } from '../lib/accountAdmin'
import { cn } from '../lib/cn'

type Filter = 'all' | 'disabled'
type Dialog =
  | { kind: 'create'; preset?: { username?: string; displayName?: string } }
  | { kind: 'edit'; account: Account; tab?: AccountTab }
  | { kind: 'credentials'; credentials: Credentials }

const ORG_ADMIN_TIP = '该账号是 IAM 组织管理员，部分操作只能在 IAM 管理台进行'

// 组织成员名单只给系统管理员和项目负责人看（入口按门户 /me 的 accounts 准入显示；接口每次请求都向 IAM 核对）。
export default function PortalAccounts() {
  const { user, applications, logout, preview } = usePortalContext()
  if (preview || applications.some((app) => app.id === 'accounts' && app.enabled)) return <AccountsAdmin />
  return (
    <PortalLayout user={user} logout={logout} preview={preview}>
      <div className="portal-page-heading">
        <div className="workspace-section-label">ACCOUNT ADMIN</div>
        <h1>账号管理</h1>
        <p>组织成员与账号仅系统管理员和项目负责人可以查看。如需调整账号或身份，请联系系统管理员。</p>
      </div>
      <Link className="portal-text-link" to="/">返回工作台</Link>
    </PortalLayout>
  )
}

function AccountsAdmin() {
  const { user, logout, preview } = usePortalContext()
  const [accounts, setAccounts] = useState<Account[]>([])
  const [issues, setIssues] = useState<AccountIssue[]>([])
  const [roles, setRoles] = useState<string[]>([])
  const [actor, setActor] = useState<ActorTier>('lead')
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState('')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [notice, setNotice] = useState('')
  const [fixing, setFixing] = useState<string | null>(null)

  const apply = useCallback((data: Awaited<ReturnType<typeof fetchAccounts>>) => {
    setAccounts(data.accounts)
    setIssues(data.issues)
    setRoles(data.roles)
    setActor(data.actor)
    setStatus('ready')
  }, [])
  const fail = useCallback((e: unknown) => {
    setLoadError(accountError(e))
    setStatus('error')
  }, [])
  const load = useCallback(() => fetchAccounts().then(apply, fail), [apply, fail])

  useEffect(() => {
    if (preview) return
    let active = true
    fetchAccounts().then((data) => { if (active) apply(data) }, (e) => { if (active) fail(e) })
    return () => { active = false }
  }, [apply, fail, preview])

  const done = (message: string) => {
    setDialog(null)
    setNotice(message)
    void load()
  }

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return accounts.filter((a) =>
      (filter === 'all' || !a.enabled)
      && (!q || a.displayName.toLowerCase().includes(q) || a.username.toLowerCase().includes(q)))
  }, [accounts, query, filter])
  const disabledCount = accounts.filter((a) => !a.enabled).length
  const byId = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts])

  const fixIssue = async (issue: AccountIssue) => {
    const account = issue.accountId ? byId.get(issue.accountId) : undefined
    if (issue.kind === 'pm_only_member') return setDialog({ kind: 'create', preset: { username: issue.username, displayName: issue.displayName } })
    if (!account) return
    if (issue.kind === 'default_account') return setDialog({ kind: 'edit', account, tab: 'status' })
    setFixing(account.id)
    try {
      await repairAccount(account.id)
      setNotice(`已修复 ${account.displayName} 的账号。`)
      await load()
    } catch (e) {
      setNotice(accountError(e))
    } finally {
      setFixing(null)
    }
  }

  return (
    <PortalLayout user={user} logout={logout} preview={preview}>
      <div className="portal-page-heading">
        <div className="workspace-section-label">ACCOUNT ADMIN</div>
        <h1>账号管理</h1>
        <p>{actor === 'admin'
          ? '全公司账号与组织成员都在这里维护：账号保存在迈博 IAM，这里的修改直接写入 IAM，与 IAM 管理台看到的一致。项目管理和知识库默认对所有人开放，身份只决定项目管理里的重要编辑（编辑项目、删除项目等）。'
          : '你可以查看全体成员；新建账号、修改身份等请联系系统管理员。'}</p>
      </div>

      {preview ? <PreviewNote /> : <>
        <div className="flex flex-wrap items-center gap-2.5 mb-4">
          <div className="relative flex-1 min-w-[200px] max-w-[340px]">
            <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-500" aria-hidden="true" />
            <input className="input pl-8" placeholder="搜索姓名或用户名" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="搜索账号" />
          </div>
          <div className="inline-flex rounded-md border border-ink-300 overflow-hidden text-sm" role="tablist" aria-label="筛选">
            {([['all', `全部 ${accounts.length}`], ['disabled', `已停用 ${disabledCount}`]] as const).map(([key, label]) => (
              <button key={key} role="tab" aria-selected={filter === key} onClick={() => setFilter(key)}
                className={cn('px-3 py-1.5 border-l first:border-l-0 border-ink-300', filter === key ? 'bg-ink-100 text-ink-900 font-medium' : 'bg-white text-ink-600 hover:bg-ink-100')}>{label}</button>
            ))}
          </div>
          <div className="flex-1" />
          <Button icon={<RefreshCw className="w-3.5 h-3.5" />} onClick={() => { setStatus('loading'); void load() }}>刷新</Button>
          {actor === 'admin' && <Button variant="primary" icon={<UserPlus className="w-4 h-4" />} onClick={() => setDialog({ kind: 'create' })}>新建账号</Button>}
        </div>

        <p className="min-h-5 mb-2 text-sm text-emerald-700 flex items-center gap-1.5" role="status" aria-live="polite">
          {notice && <><CheckCircle2 className="w-4 h-4 shrink-0" />{notice}</>}
        </p>

        {status === 'ready' && actor === 'admin' && issues.length > 0 && <IssuesPanel issues={issues} fixing={fixing} onFix={fixIssue} />}

        <div className="bg-white border border-[#dfe7ed] rounded-xl overflow-x-auto">
          {status === 'loading' && accounts.length === 0 ? <div className="p-10 text-center text-sm text-ink-500"><Loader2 className="w-5 h-5 animate-spin inline mr-2" />正在读取 IAM 账号…</div>
            : status === 'error' ? <div className="p-10 text-center text-sm text-red-600"><AlertTriangle className="w-5 h-5 inline mr-2" />{loadError}</div>
              : <AccountTable accounts={visible} actor={actor} onEdit={(account) => setDialog({ kind: 'edit', account })} />}
        </div>

      </>}

      {dialog?.kind === 'create' && <CreateAccountDialog preset={dialog.preset} available={roles} onClose={() => setDialog(null)}
        onCreated={(credentials) => { setDialog({ kind: 'credentials', credentials }); setNotice(`已创建 ${credentials.displayName} 的账号。`); void load() }} />}
      {dialog?.kind === 'edit' && <AccountDialog account={dialog.account} initialTab={dialog.tab} available={roles} onClose={() => setDialog(null)} onSaved={done}
        onPasswordReset={(credentials) => { setDialog({ kind: 'credentials', credentials }); setNotice(`已重置 ${credentials.displayName} 的密码。`); void load() }} />}
      {dialog?.kind === 'credentials' && <CredentialDialog credentials={dialog.credentials} onClose={() => setDialog(null)} />}
    </PortalLayout>
  )
}

function PreviewNote() {
  return <div className="bg-white border border-[#dfe7ed] rounded-xl p-8 text-sm text-ink-500">界面预览模式不连接 IAM，请登录后使用账号管理。</div>
}

function IssuesPanel({ issues, fixing, onFix }: { issues: AccountIssue[]; fixing: string | null; onFix: (issue: AccountIssue) => void }) {
  const action: Record<AccountIssue['kind'], { label: string; icon: typeof Wrench } | null> = {
    iam_password_flag: { label: '修复', icon: Wrench },
    kb_missing: { label: '修复', icon: Wrench },
    pm_member_inactive: { label: '修复', icon: Wrench },
    default_account: { label: '删除', icon: Trash2 },
    pm_only_member: { label: '新建账号', icon: UserPlus },
    pm_member_conflict: null,
  }
  return (
    <section className="mb-4 rounded-xl border border-amber-200 bg-amber-50/70 p-4" aria-labelledby="account-issues-title">
      <h2 id="account-issues-title" className="text-sm font-semibold text-amber-800 flex items-center gap-1.5 mb-2">
        <AlertTriangle className="w-4 h-4" />需要处理（{issues.length}）
      </h2>
      <ul className="divide-y divide-amber-200/70">
        {issues.map((issue) => {
          const a = action[issue.kind]
          const key = `${issue.kind}-${issue.accountId ?? issue.memberId}`
          const busy = !!issue.accountId && fixing === issue.accountId
          return (
            <li key={key} className="py-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span className="font-medium text-ink-900">{issue.displayName}</span>
              <span className="font-mono text-xs text-ink-500">{issue.username}</span>
              <span className="text-ink-700 flex-1 min-w-[200px]">{issue.message}</span>
              {a ? <Button size="sm" disabled={busy}
                icon={busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <a.icon className="w-3.5 h-3.5" />}
                onClick={() => onFix(issue)}>{a.label}</Button>
                : <span className="text-xs text-ink-500">请联系技术支持核对</span>}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

const Dash = () => <span className="text-ink-500/60">—</span>

function AccountTable({ accounts, actor, onEdit }: { accounts: Account[]; actor: ActorTier; onEdit: (account: Account) => void }) {
  if (accounts.length === 0) return <div className="p-10 text-center text-sm text-ink-500">没有符合条件的账号。</div>
  return (
    <table className="w-full min-w-[760px] text-sm">
      <thead>
        <tr className="text-left text-xs text-ink-500 border-b border-[#e6edf2]">
          <th className="font-medium px-4 py-2.5">姓名 / 用户名</th>
          <th className="font-medium px-3 py-2.5">身份</th>
          <th className="font-medium px-3 py-2.5">专业组</th>
          <th className="font-medium px-3 py-2.5 text-right">周工时</th>
          <th className="font-medium px-3 py-2.5">状态</th>
          {actor === 'admin' && <th className="font-medium px-4 py-2.5 text-right">操作</th>}
        </tr>
      </thead>
      <tbody>
        {accounts.map((a) => (
          <tr key={a.id} className={cn('border-b border-[#eef2f5] last:border-b-0', a.isSelf ? 'bg-blue-50/70' : !a.enabled && 'bg-ink-100/40')}>
            <td className={cn('px-4 py-3', a.isSelf && 'shadow-[inset_3px_0_0_#1d4ed8]')}>
              <div className="flex items-center gap-2.5">
                <span className={cn('w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold shrink-0', a.isSelf ? 'bg-blue-100 text-blue-800' : 'bg-[#e7eff5] text-[rgb(35,72,111)]')} aria-hidden="true">{Array.from(a.displayName)[0]}</span>
                <div className="min-w-0">
                  <div className="font-medium text-ink-900 flex items-center gap-1.5 flex-wrap">
                    {a.displayName}
                    {a.isSelf && <Tag className="gap-1.5 whitespace-nowrap bg-blue-700 text-white font-semibold px-2 py-1" title="当前登录的账号">
                      <LogIn className="w-3.5 h-3.5" aria-hidden="true" />登录账号
                    </Tag>}
                    {a.orgAdmin && <Tag tone="purple" title={ORG_ADMIN_TIP}>IAM 组织管理员</Tag>}
                  </div>
                  <div className="font-mono text-xs text-ink-500">{a.username}</div>
                </div>
              </div>
            </td>
            <td className="px-3 py-3">
              {/* 身份标签等宽居中：「员工」与「项目负责人」字数不同，列内保持齐整 */}
              <Tag tone={a.identity === 'admin' ? 'purple' : a.identity === 'lead' ? 'blue' : 'gray'} className="w-[5.25rem] justify-center">{identityLabel(a.identity)}</Tag>
            </td>
            <td className="px-3 py-3 text-ink-700">{a.pmMember?.specialtyGroup || <Dash />}</td>
            <td className="px-3 py-3 text-right tabular-nums text-ink-700">{a.pmMember ? `${a.pmMember.weeklyHours}h` : <Dash />}</td>
            <td className="px-3 py-3">
              <div className="flex flex-wrap gap-1">
                {!a.enabled ? <Tag tone="red">已停用</Tag>
                  : a.mustChangePassword ? <Tag tone="yellow" title="对方首次登录时会被要求修改密码">待改初始密码</Tag>
                    : <Tag tone="green">正常</Tag>}
                {a.enabled && !a.pmMember && <Tag tone="gray" title="首次进入项目管理时自动建成员">未进入项目管理</Tag>}
              </div>
            </td>
            {actor === 'admin' && <td className="px-4 py-3">
              <div className="flex justify-end">
                <Button size="sm" icon={<Pencil className="w-3.5 h-3.5" />} aria-label={`编辑 ${a.displayName}`} onClick={() => onEdit(a)}>编辑</Button>
              </div>
            </td>}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
