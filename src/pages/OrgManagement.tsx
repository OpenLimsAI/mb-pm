// 组织管理 —— 组织成员目录 + 增删改。
//
// 入口：左侧导航「组织」。可新增成员、停用/启用、删除（仍负责项目/任务的成员受守卫保护，
// 提示先停用或转移负责人）。写操作走 data/bootstrap（API：后端持久化；离线：本地 mock）。

import { useMemo, useState } from 'react'
import {
  Users, Search, UserPlus, Power, Trash2, Loader2, AlertTriangle, X, ShieldCheck, BadgeCheck,
} from 'lucide-react'
import type { Role, SpecialtyGroup, User } from '../types'
import { Card, CardBody, Button, Tag, Avatar, EmptyState } from '../components/ui'
import { users, projects, subProjects, tasks, specialtyGroups } from '../mock'
import { roleLabels } from '../lib/permissions'
import { can } from '../lib/permissions'
import { useAuth } from '../store/auth'
import { useDataStore } from '../store/data'
import { createOrgMember, updateOrgMember, deleteOrgMember, type OrgMemberInput } from '../data/bootstrap'
import { cn } from '../lib/cn'

const ROLES = Object.keys(roleLabels) as Role[]

export default function OrgManagement() {
  useDataStore((s) => s.version)
  const mode = useDataStore((s) => s.mode)
  const currentUser = useAuth((s) => s.currentUser)
  const role = currentUser?.role
  const canManage = can(role, 'template.edit') // admin / cmc_lead

  const [keyword, setKeyword] = useState('')
  const [roleFilter, setRoleFilter] = useState<Role | 'all'>('all')
  const [groupFilter, setGroupFilter] = useState<SpecialtyGroup | 'all'>('all')
  const [activeFilter, setActiveFilter] = useState<'all' | 'active' | 'inactive'>('all')
  const [addOpen, setAddOpen] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  // 引用集合：仍承担工作的成员不可硬删除
  const referencedIds = useMemo(() => {
    const s = new Set<string>()
    projects.forEach((p) => { if (p.ownerId) s.add(p.ownerId) })
    subProjects.forEach((sp) => { if (sp.ownerId) s.add(sp.ownerId) })
    tasks.forEach((t) => { s.add(t.ownerId); t.collaboratorIds?.forEach((c) => s.add(c)) })
    return s
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useDataStore.getState().version])

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    return users
      .filter((u) => {
        if (kw && !`${u.displayName} ${u.username} ${u.email}`.toLowerCase().includes(kw)) return false
        if (roleFilter !== 'all' && u.role !== roleFilter) return false
        if (groupFilter !== 'all' && u.specialtyGroup !== groupFilter) return false
        if (activeFilter === 'active' && !u.isActive) return false
        if (activeFilter === 'inactive' && u.isActive) return false
        return true
      })
      .sort((a, b) => Number(b.isActive) - Number(a.isActive) || a.displayName.localeCompare(b.displayName))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyword, roleFilter, groupFilter, activeFilter, useDataStore.getState().version])

  const activeCount = users.filter((u) => u.isActive).length

  const toggleActive = async (u: User) => {
    setBusyId(u.id); setActionError(null)
    try {
      await updateOrgMember(u.id, { isActive: !u.isActive })
    } catch (e) {
      setActionError(e instanceof Error ? e.message : '操作失败，请重试。')
    } finally {
      setBusyId(null)
    }
  }

  const del = async (u: User) => {
    setBusyId(u.id); setActionError(null)
    try {
      await deleteOrgMember(u.id)
      setConfirmId(null)
    } catch (e) {
      setActionError(e instanceof Error ? e.message : '删除失败，请重试。')
      setConfirmId(null)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      {/* Header */}
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-ink-900 flex items-center gap-2">
            <Users className="w-6 h-6 text-brand-600" /> 组织管理
          </h1>
          <p className="text-sm text-ink-500 mt-1">
            组织成员目录 —— 共 <b className="text-ink-700">{users.length}</b> 人（在职 {activeCount}）。可新增、停用/启用、删除成员。
          </p>
        </div>
        {canManage && (
          <Button variant="primary" icon={<UserPlus className="w-4 h-4" />} onClick={() => setAddOpen(true)} className="shrink-0">
            添加成员
          </Button>
        )}
      </div>

      <Card>
        {/* Toolbar */}
        <div className="px-4 py-3 border-b border-ink-300/40 flex items-center gap-2 flex-wrap">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-ink-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              value={keyword} onChange={(e) => setKeyword(e.target.value)}
              placeholder="搜索姓名 / 用户名 / 邮箱"
              className="h-8 w-56 pl-8 pr-2 text-sm rounded-md border border-ink-300 bg-white focus:border-brand-400 focus:outline-none"
            />
          </div>
          <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value as Role | 'all')}
            className="h-8 px-2 text-sm rounded-md border border-ink-300 bg-white focus:border-brand-400 focus:outline-none">
            <option value="all">全部角色</option>
            {ROLES.map((r) => <option key={r} value={r}>{roleLabels[r]}</option>)}
          </select>
          <select value={groupFilter} onChange={(e) => setGroupFilter(e.target.value as SpecialtyGroup | 'all')}
            className="h-8 px-2 text-sm rounded-md border border-ink-300 bg-white focus:border-brand-400 focus:outline-none">
            <option value="all">全部专业组</option>
            {specialtyGroups.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
          <select value={activeFilter} onChange={(e) => setActiveFilter(e.target.value as 'all' | 'active' | 'inactive')}
            className="h-8 px-2 text-sm rounded-md border border-ink-300 bg-white focus:border-brand-400 focus:outline-none">
            <option value="all">全部状态</option>
            <option value="active">在职</option>
            <option value="inactive">已停用</option>
          </select>
          <span className="ml-auto text-xs text-ink-500">匹配 {filtered.length} 人</span>
        </div>

        {actionError && (
          <div className="mx-4 mt-3 px-3 py-2 rounded-md bg-red-50 border border-red-200 text-red-700 text-xs flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />{actionError}
          </div>
        )}

        <CardBody className="p-0 overflow-x-auto">
          {filtered.length === 0 ? (
            <EmptyState title="没有匹配的成员" description="试试调整搜索或筛选条件" />
          ) : (
            <table className="w-full text-sm min-w-[860px]">
              <thead>
                <tr className="text-[11px] text-ink-500 bg-ink-100/60 border-b border-ink-300/50">
                  <th className="text-left font-medium px-4 py-2">成员</th>
                  <th className="text-left font-medium px-2 py-2 w-[110px]">角色</th>
                  <th className="text-left font-medium px-2 py-2 w-[90px]">专业组</th>
                  <th className="text-left font-medium px-2 py-2 w-[200px]">邮箱</th>
                  <th className="text-right font-medium px-2 py-2 w-[80px]">周工时</th>
                  <th className="text-center font-medium px-2 py-2 w-[80px]">状态</th>
                  <th className="text-right font-medium px-4 py-2 w-[200px]">操作</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((u) => {
                  const isSelf = currentUser?.id === u.id
                  const referenced = referencedIds.has(u.id)
                  const busy = busyId === u.id
                  return (
                    <tr key={u.id} className={cn('border-b border-ink-200/60 hover:bg-ink-100/30', !u.isActive && 'opacity-60')}>
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-2.5">
                          <Avatar user={u} size="md" />
                          <div className="min-w-0">
                            <div className="text-sm font-medium text-ink-900 flex items-center gap-1.5">
                              {u.displayName}
                              {isSelf && <Tag tone="blue">当前账号</Tag>}
                            </div>
                            <div className="text-[11px] text-ink-500 font-mono">@{u.username}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-2 py-2"><Tag tone="gray">{roleLabels[u.role]}</Tag></td>
                      <td className="px-2 py-2 text-xs text-ink-600">{u.specialtyGroup || '—'}</td>
                      <td className="px-2 py-2 text-xs text-ink-500 truncate">{u.email}</td>
                      <td className="px-2 py-2 text-right text-xs text-ink-600 tabular-nums">{u.weeklyAvailableHours}h</td>
                      <td className="px-2 py-2 text-center">
                        {u.isActive
                          ? <Tag tone="green" className="gap-1"><BadgeCheck className="w-3 h-3" />在职</Tag>
                          : <Tag tone="gray">已停用</Tag>}
                      </td>
                      <td className="px-4 py-2">
                        {!canManage ? (
                          <span className="text-[11px] text-ink-400">—</span>
                        ) : confirmId === u.id ? (
                          <div className="flex items-center justify-end gap-1.5">
                            <span className="text-[11px] text-red-600">删除？</span>
                            <Button size="sm" variant="danger" disabled={busy}
                              icon={busy ? <Loader2 className="w-3 h-3 animate-spin" /> : undefined}
                              onClick={() => del(u)}>确认</Button>
                            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmId(null)}>取消</Button>
                          </div>
                        ) : (
                          <div className="flex items-center justify-end gap-1.5">
                            <Button size="sm" variant="secondary" disabled={busy || isSelf}
                              icon={busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Power className="w-3 h-3" />}
                              onClick={() => toggleActive(u)}>
                              {u.isActive ? '停用' : '启用'}
                            </Button>
                            <button
                              onClick={() => { setActionError(null); setConfirmId(u.id) }}
                              disabled={busy || isSelf || referenced}
                              title={isSelf ? '不能删除当前登录用户' : referenced ? '该成员仍负责项目/任务，请先停用或转移负责人' : '删除成员'}
                              className={cn('p-1.5 rounded-md transition-colors',
                                (isSelf || referenced) ? 'text-ink-300 cursor-not-allowed' : 'text-ink-400 hover:text-red-600 hover:bg-red-50')}
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>

      <p className="mt-3 text-[11px] text-ink-400 flex items-center gap-1.5">
        <ShieldCheck className="w-3.5 h-3.5" />
        仍负责项目/任务的成员不可直接删除（避免悬挂负责人）—— 请先「停用」或将负责人转移给他人。
        {mode === 'mock' && <span className="text-amber-600 ml-1">· 当前离线模式，更改不持久化</span>}
      </p>

      {addOpen && <AddMemberDialog onClose={() => setAddOpen(false)} />}
    </div>
  )
}

// ============= 添加成员对话框 =============

function AddMemberDialog({ onClose }: { onClose: () => void }) {
  const [displayName, setDisplayName] = useState('')
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Role>('rd')
  const [specialtyGroup, setSpecialtyGroup] = useState<SpecialtyGroup | ''>('')
  const [hours, setHours] = useState('40')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const nameInvalid = !displayName.trim()
  const userInvalid = !username.trim()
  const emailInvalid = !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())
  const canSave = !nameInvalid && !userInvalid && !emailInvalid

  const submit = async () => {
    if (!canSave) { setError('请填写姓名、用户名和有效邮箱。'); return }
    setSaving(true); setError(null)
    const input: OrgMemberInput = {
      username: username.trim(),
      displayName: displayName.trim(),
      email: email.trim(),
      role,
      specialtyGroup: specialtyGroup || null,
      weeklyAvailableHours: Number(hours) || 40,
    }
    try {
      await createOrgMember(input)
      onClose()
    } catch (e) {
      // 后端 409（用户名/邮箱重复）或 422（邮箱格式）等
      const msg = e instanceof Error ? e.message : ''
      const detail = (e as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail
      setError(typeof detail === 'string' ? detail : msg || '添加失败，请检查输入或稍后重试。')
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-[520px] bg-white rounded-xl shadow-2xl flex flex-col max-h-[90vh] overflow-y-auto">
        <div className="flex items-center gap-2.5 px-5 py-4 border-b border-ink-300/40 sticky top-0 bg-white">
          <UserPlus className="w-5 h-5 text-brand-600" />
          <h2 className="text-lg font-semibold text-ink-900 flex-1">添加组织成员</h2>
          <button onClick={onClose} className="p-1.5 rounded-md hover:bg-ink-100 text-ink-500" aria-label="关闭"><X className="w-4 h-4" /></button>
        </div>

        <div className="px-5 py-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-[11px] text-ink-500">姓名 <span className="text-red-500">*</span></span>
              <input className={cn('input mt-1', nameInvalid && 'border-red-400')} value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="如：王上游" />
            </label>
            <label className="block">
              <span className="text-[11px] text-ink-500">用户名 <span className="text-red-500">*</span></span>
              <input className={cn('input mt-1', userInvalid && 'border-red-400')} value={username} onChange={(e) => setUsername(e.target.value)} placeholder="如：wang.usp" />
            </label>
          </div>
          <label className="block">
            <span className="text-[11px] text-ink-500">邮箱 <span className="text-red-500">*</span></span>
            <input className={cn('input mt-1', email && emailInvalid && 'border-red-400')} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="如：wang.usp@cmc.com" />
          </label>
          <div className="grid grid-cols-3 gap-3">
            <label className="block">
              <span className="text-[11px] text-ink-500">角色</span>
              <select className="input mt-1" value={role} onChange={(e) => setRole(e.target.value as Role)}>
                {ROLES.map((r) => <option key={r} value={r}>{roleLabels[r]}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-[11px] text-ink-500">专业组</span>
              <select className="input mt-1" value={specialtyGroup} onChange={(e) => setSpecialtyGroup(e.target.value as SpecialtyGroup | '')}>
                <option value="">无</option>
                {specialtyGroups.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-[11px] text-ink-500">周可用工时</span>
              <input type="number" min={0} max={80} className="input mt-1" value={hours} onChange={(e) => setHours(e.target.value)} />
            </label>
          </div>

          {error && <div className="text-xs text-red-600 flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5 shrink-0" />{error}</div>}
        </div>

        <div className="px-5 py-3 border-t border-ink-300/40 sticky bottom-0 bg-white flex items-center justify-end gap-2">
          <Button variant="secondary" size="sm" disabled={saving} onClick={onClose}>取消</Button>
          <Button variant="primary" size="sm" disabled={saving || !canSave}
            icon={saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserPlus className="w-3.5 h-3.5" />}
            onClick={submit}>
            {saving ? '添加中…' : '添加成员'}
          </Button>
        </div>
      </div>
    </div>
  )
}
