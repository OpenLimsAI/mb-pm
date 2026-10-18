// 更改项目成员抽屉：全量编辑项目团队成员。
//
// 复用里程碑设置抽屉的右侧外壳（遮罩 + ml-auto + ESC）。负责人单列展示且锁定（不可移除，
// 由后端单独维护、不计入成员）；其余在职用户以可搜索勾选列表呈现，勾选=团队成员，当前团队排在前面。
// 任务只能派给团队成员（lib/projectTeam）：负责或协作本项目任务的人勾选并锁定，先在 WBS 转交任务才能移出。
// 保存走 data/bootstrap.updateProjectMembers（API：PUT 全量替换 + 重新同步；离线 mock：本地替换）。

import { useEffect, useMemo, useState } from 'react'
import { X, Save, Loader2, Search, Users, AlertTriangle, Crown } from 'lucide-react'
import type { Project } from '../../types'
import { Button, Avatar, Tag } from '../ui'
import { users, findUser } from '../../mock'
import { roleLabels } from '../../lib/permissions'
import { useDataStore } from '../../store/data'
import { refreshAllData, updateProjectMembers } from '../../data/bootstrap'
import { rejectionText } from '../../api/client'
import { cn } from '../../lib/cn'
import { taskLoadOf } from '../../lib/projectTeam'

interface Props {
  project: Project
  onClose: () => void
}

export function ProjectMembersDrawer({ project, onClose }: Props) {
  const mode = useDataStore((s) => s.mode)
  const owner = findUser(project.ownerId)

  const initial = useMemo(
    () => new Set((project.memberIds || []).filter((id) => id !== project.ownerId)),
    [project.memberIds, project.ownerId],
  )
  const [selected, setSelected] = useState<Set<string>>(() => new Set(initial))
  const [keyword, setKeyword] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // ESC 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // 本项目任务的负责 / 协作人数（不含项目负责人）：这些人不能移出团队
  const taskLoad = useMemo(() => taskLoadOf(project), [project])

  // 候选：在职用户（已停用的只在仍属团队时列出），排除负责人；当前团队在前，按关键词过滤
  const candidates = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    const inTeam = (id: string) => initial.has(id) || taskLoad.has(id)
    return users
      .filter((u) => u.id !== project.ownerId && (u.isActive !== false || inTeam(u.id)))
      .filter((u) => !kw || `${u.displayName} ${u.username} ${u.specialtyGroup ?? ''} ${roleLabels[u.role] ?? ''}`.toLowerCase().includes(kw))
      .sort((a, b) => Number(inTeam(b.id)) - Number(inTeam(a.id)))
  }, [keyword, project.ownerId, initial, taskLoad])

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const dirty = selected.size !== initial.size || [...selected].some((id) => !initial.has(id))

  const teamSize = new Set([...selected, ...taskLoad.keys()]).size + (owner ? 1 : 0)

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      await updateProjectMembers(project.id, [...selected])
      onClose()
    } catch (e) {
      console.error(e)
      setError(rejectionText(e, '保存失败，请确认后端已启动后重试。'))
      setSaving(false)
      // 被拒多半是他人刚给某人派了任务：刷新后锁定状态与服务器一致
      if (rejectionText(e, '') && mode === 'api') void refreshAllData().catch(() => undefined)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative ml-auto w-full max-w-[520px] bg-white shadow-2xl overflow-y-auto flex flex-col">
        {/* Header */}
        <div className="flex items-start gap-3 px-5 py-4 border-b border-ink-300/40 sticky top-0 bg-white z-10">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <Users className="w-4 h-4 text-brand-600" />
              <h2 className="text-lg font-semibold text-ink-900">更改项目成员</h2>
              {mode === 'mock' && (
                <span className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">
                  离线模式 · 不持久化
                </span>
              )}
            </div>
            <p className="text-xs text-ink-500 mt-1">{project.code} · {project.name}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-md hover:bg-ink-100 text-ink-500" aria-label="关闭">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 px-5 py-4 space-y-4">
          {/* 负责人（锁定） */}
          {owner && (
            <div>
              <span className="text-[11px] text-ink-500 uppercase tracking-wider">项目负责人</span>
              <div className="mt-1.5 flex items-center gap-2.5 px-3 py-2 rounded-md bg-brand-50/60 border border-brand-100">
                <Avatar user={owner} size="md" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-ink-900">{owner.displayName}</div>
                  <div className="text-[11px] text-ink-500">{roleLabels[owner.role]}{owner.specialtyGroup ? ` · ${owner.specialtyGroup}` : ''}</div>
                </div>
                <Tag tone="blue" className="gap-1"><Crown className="w-3 h-3" />负责人</Tag>
              </div>
              <p className="text-[11px] text-ink-400 mt-1">负责人由项目设置单独维护，不在此处更改。</p>
            </div>
          )}

          {/* 团队成员选择 */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-ink-500 uppercase tracking-wider">团队成员</span>
              <span className="text-[11px] text-ink-500">团队共 <b className="text-brand-600">{teamSize}</b> 人（含负责人）</span>
            </div>

            <div className="relative">
              <Search className="w-3.5 h-3.5 text-ink-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                value={keyword} onChange={(e) => setKeyword(e.target.value)}
                placeholder="搜索姓名 / 工号 / 专业组 / 角色"
                className="h-8 w-full pl-8 pr-2 text-sm rounded-md border border-ink-300 bg-white focus:border-brand-400 focus:outline-none"
              />
            </div>

            <div className="border border-ink-300/60 rounded-md max-h-[420px] overflow-y-auto divide-y divide-ink-200/60">
              {candidates.length === 0 ? (
                <div className="p-4 text-center text-xs text-ink-500">没有匹配的人员</div>
              ) : (
                candidates.map((u) => {
                  const load = taskLoad.get(u.id)
                  const checked = !!load || selected.has(u.id)
                  return (
                    <label
                      key={u.id}
                      title={load ? '负责或协作本项目任务，不能移出团队；请先在 WBS 中转交其任务' : undefined}
                      className={cn(
                        'flex items-center gap-2.5 px-3 py-2',
                        load ? 'cursor-default' : 'cursor-pointer hover:bg-brand-50/40',
                        checked && 'bg-brand-50/60',
                      )}
                    >
                      <input type="checkbox" checked={checked} disabled={!!load} onChange={() => toggle(u.id)} className="accent-brand-600" />
                      <Avatar user={u} size="sm" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-ink-900 truncate">{u.displayName}</div>
                        <div className="text-[11px] text-ink-500 truncate">{roleLabels[u.role]}{u.specialtyGroup ? ` · ${u.specialtyGroup}` : ''}</div>
                      </div>
                      {u.isActive === false && <Tag tone="gray">已停用</Tag>}
                      {load && (
                        <Tag tone="gray" className="shrink-0">
                          {[load.owned && `负责 ${load.owned}`, load.assisted && `协作 ${load.assisted}`].filter(Boolean).join(' · ')} 个任务
                        </Tag>
                      )}
                    </label>
                  )
                })
              )}
            </div>
            {taskLoad.size > 0 && (
              <p className="text-[11px] text-ink-400">
                任务只能派给团队成员。标「任务」的人负责或协作本项目任务，不能在这里取消；要移出请先在 WBS 中转交其任务。
              </p>
            )}
          </div>

          {error && (
            <div className="text-xs text-red-600 flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />{error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-ink-300/40 sticky bottom-0 bg-white flex items-center justify-end gap-2">
          <span className="mr-auto text-[11px] text-ink-400">
            {dirty ? '有未保存的更改' : '与当前成员一致'}
          </span>
          <Button variant="secondary" size="sm" disabled={saving} onClick={onClose}>取消</Button>
          <Button
            variant="primary" size="sm"
            icon={saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            disabled={saving || !dirty}
            onClick={save}
          >
            {saving ? '保存中…' : '保存成员'}
          </Button>
        </div>
      </div>
    </div>
  )
}
