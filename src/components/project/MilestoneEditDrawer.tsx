// 里程碑设置抽屉：新建 / 编辑 / 删除里程碑 + 配置「达成条件任务」（前驱依赖）。
//
// 复用 TaskDrawer 的右侧抽屉外壳（遮罩 + ml-auto + ESC 关闭）。两块结构：
//   ① 基本信息：名称 / 计划达成日 / 子项目(新建可选) / 优先级 / 备注
//   ② 达成条件：勾选「哪些 WBS 任务完成即可达成此里程碑」（按子项目分组，支持搜索、跨模块）
// 保存前做客户端成环检测；写操作走 data/bootstrap 编排函数（API + 离线 mock 两模式）。

import { useEffect, useMemo, useState } from 'react'
import {
  X, Save, Loader2, Trash2, Search, Diamond, AlertTriangle, ListChecks,
} from 'lucide-react'
import type { Priority, Project, Task } from '../../types'
import { Button, Avatar } from '../ui'
import { getProjectSubs, getProjectTasks, subProjects, findUser, taskDependencies } from '../../mock'
import { useDataStore } from '../../store/data'
import { detectCycle } from '../../lib/dependency-utils'
import {
  createMilestoneWithDeps, updateMilestoneWithDeps, deleteMilestoneWithDeps,
} from '../../data/bootstrap'
import { cn } from '../../lib/cn'

export type MilestoneEditTarget =
  | { mode: 'create' }
  | { mode: 'edit'; milestone: Task }

const PRIORITIES: Priority[] = ['高', '中', '低']

interface Props {
  target: MilestoneEditTarget
  project: Project
  onClose: () => void
}

export function MilestoneEditDrawer({ target, project, onClose }: Props) {
  const mode = useDataStore((s) => s.mode)
  const isEdit = target.mode === 'edit'
  const milestone = isEdit ? target.milestone : null

  const subs = useMemo(() => getProjectSubs(project.id).sort((a, b) => a.sortOrder - b.sortOrder), [project.id])

  // —— 基本信息表单 ——
  const [name, setName] = useState(milestone?.name ?? '')
  const [plannedEnd, setPlannedEnd] = useState(milestone?.plannedEnd ?? '')
  const [subProjectId, setSubProjectId] = useState(milestone?.subProjectId ?? subs[0]?.id ?? '')
  const [priority, setPriority] = useState<Priority>(milestone?.priority ?? '中')
  const [notes, setNotes] = useState(milestone?.notes ?? '')

  // —— 达成条件（前驱任务）——
  const initialPredIds = useMemo(
    () => (milestone ? taskDependencies.filter((d) => d.successorId === milestone.id).map((d) => d.predecessorId) : []),
    [milestone],
  )
  const [selected, setSelected] = useState<Set<string>>(new Set(initialPredIds))
  const [keyword, setKeyword] = useState('')

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  // ESC 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // 候选前驱：项目内全部非里程碑任务（排除自身），按子项目分组
  const candidateGroups = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    const all = getProjectTasks(project.id).filter((t) => !t.isMilestone && t.id !== milestone?.id)
    const filtered = kw
      ? all.filter((t) => `${t.code} ${t.name}`.toLowerCase().includes(kw))
      : all
    const groups = new Map<string, Task[]>()
    for (const t of filtered) {
      const arr = groups.get(t.subProjectId) ?? []
      arr.push(t)
      groups.set(t.subProjectId, arr)
    }
    return groups
  }, [project.id, keyword, milestone?.id])

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  const datesInvalid = !plannedEnd
  const nameInvalid = !name.trim()
  const canSave = !nameInvalid && !datesInvalid && (isEdit || !!subProjectId)

  const save = async () => {
    if (!canSave) {
      setError('请填写里程碑名称与计划达成日。')
      return
    }
    const predIds = [...selected]

    // 成环检测：构造「目标图」检查
    const successorId = milestone?.id ?? '__new_milestone__'
    const existing = taskDependencies.filter((d) => d.successorId !== successorId)
    const addEdges = predIds.map((pid) => ({ predecessorId: pid, successorId }))
    if (detectCycle(existing, addEdges)) {
      setError('该前置组合会形成循环依赖，请调整。')
      return
    }

    setSaving(true)
    setError(null)
    try {
      if (isEdit && milestone) {
        await updateMilestoneWithDeps(milestone.id, { name: name.trim(), plannedEnd, priority, notes: notes || null }, predIds)
      } else {
        await createMilestoneWithDeps({
          projectId: project.id,
          subProjectId,
          basics: { name: name.trim(), plannedEnd, priority, notes: notes || null },
          predecessorIds: predIds,
        })
      }
      onClose()
    } catch (e) {
      console.error(e)
      setError('保存失败，请确认后端已启动后重试。')
      setSaving(false)
    }
  }

  const doDelete = async () => {
    if (!milestone) return
    setSaving(true)
    setError(null)
    try {
      await deleteMilestoneWithDeps(milestone.id)
      onClose()
    } catch (e) {
      console.error(e)
      setError('删除失败，请重试。')
      setSaving(false)
    }
  }

  const selectedCount = selected.size

  return (
    <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative ml-auto w-full max-w-[560px] bg-white shadow-2xl overflow-y-auto flex flex-col">
        {/* Header */}
        <div className="flex items-start gap-3 px-5 py-4 border-b border-ink-300/40 sticky top-0 bg-white z-10">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <Diamond className="w-4 h-4 text-amber-600" />
              <h2 className="text-lg font-semibold text-ink-900">{isEdit ? '编辑里程碑' : '新建里程碑'}</h2>
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
        <div className="flex-1 px-5 py-4 space-y-5">
          {/* ① 基本信息 */}
          <section className="space-y-3">
            <h3 className="text-xs font-medium text-ink-500 uppercase tracking-wider">基本信息</h3>
            <label className="block">
              <span className="text-[11px] text-ink-500">里程碑名称 <span className="text-red-500">*</span></span>
              <input
                className={cn('input mt-1', nameInvalid && 'border-red-400')}
                value={name} onChange={(e) => setName(e.target.value)}
                placeholder="如：上游工艺定型"
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-[11px] text-ink-500">计划达成日 <span className="text-red-500">*</span></span>
                <input
                  type="date" className={cn('input mt-1', datesInvalid && 'border-red-400')}
                  value={plannedEnd} onChange={(e) => setPlannedEnd(e.target.value)}
                />
              </label>
              <label className="block">
                <span className="text-[11px] text-ink-500">优先级</span>
                <select className="input mt-1" value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
                  {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </label>
            </div>
            <label className="block">
              <span className="text-[11px] text-ink-500">所属子项目</span>
              {isEdit ? (
                <div className="mt-1 text-sm text-ink-700 px-3 py-2 rounded-md bg-ink-100/60">
                  {subProjects.find((s) => s.id === subProjectId)?.name ?? '—'}
                  <span className="text-[11px] text-ink-400 ml-2">（子项目归属不可更改）</span>
                </div>
              ) : (
                <select className="input mt-1" value={subProjectId} onChange={(e) => setSubProjectId(e.target.value)}>
                  {subs.map((s) => <option key={s.id} value={s.id}>{s.module} · {s.name}</option>)}
                </select>
              )}
            </label>
            <label className="block">
              <span className="text-[11px] text-ink-500">备注</span>
              <textarea
                className="input mt-1 min-h-[60px] resize-y" value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="评审要点 / 交付物说明（可选）"
              />
            </label>
          </section>

          {/* ② 达成条件 */}
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-medium text-ink-500 uppercase tracking-wider flex items-center gap-1.5">
                <ListChecks className="w-3.5 h-3.5" /> 达成条件任务
              </h3>
              <span className="text-[11px] text-ink-500">已选 <b className="text-brand-600">{selectedCount}</b> 个</span>
            </div>
            <p className="text-[11px] text-ink-400">勾选「完成后即可达成此里程碑」的 WBS 任务（可跨子项目/模块）。</p>

            <div className="relative">
              <Search className="w-3.5 h-3.5 text-ink-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                value={keyword} onChange={(e) => setKeyword(e.target.value)}
                placeholder="搜索任务 / 编号"
                className="h-8 w-full pl-8 pr-2 text-sm rounded-md border border-ink-300 bg-white focus:border-brand-400 focus:outline-none"
              />
            </div>

            <div className="border border-ink-300/60 rounded-md max-h-[320px] overflow-y-auto divide-y divide-ink-200/60">
              {[...candidateGroups.entries()].length === 0 ? (
                <div className="p-4 text-center text-xs text-ink-500">没有匹配的任务</div>
              ) : (
                [...candidateGroups.entries()].map(([subId, gtasks]) => {
                  const sub = subProjects.find((s) => s.id === subId)
                  return (
                    <div key={subId}>
                      <div className="px-3 py-1.5 bg-ink-100/60 flex items-center gap-1.5 sticky top-0">
                        <span className="tag bg-purple-100 text-purple-800 font-mono text-[9px]">{sub?.module ?? '—'}</span>
                        <span className="text-[11px] font-medium text-ink-600">{sub?.name ?? '未知子项目'}</span>
                      </div>
                      <ul>
                        {gtasks.map((t) => {
                          const owner = findUser(t.ownerId)
                          const checked = selected.has(t.id)
                          return (
                            <li key={t.id}>
                              <label className={cn('flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-brand-50/40', checked && 'bg-brand-50/60')}>
                                <input type="checkbox" checked={checked} onChange={() => toggle(t.id)} className="accent-brand-600" />
                                <span className="font-mono text-[10px] text-ink-400 shrink-0">{t.code}</span>
                                <span className="text-xs truncate flex-1">{t.name}</span>
                                {owner && <Avatar user={owner} size="sm" />}
                              </label>
                            </li>
                          )
                        })}
                      </ul>
                    </div>
                  )
                })
              )}
            </div>
          </section>

          {error && (
            <div className="text-xs text-red-600 flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />{error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-ink-300/40 sticky bottom-0 bg-white flex items-center gap-2">
          {isEdit && (
            confirmDelete ? (
              <div className="flex items-center gap-2 mr-auto">
                <span className="text-xs text-red-600">
                  删除此里程碑及其 {initialPredIds.length} 条达成条件？
                </span>
                <Button size="sm" variant="danger" disabled={saving} onClick={doDelete}>确认删除</Button>
                <Button size="sm" variant="ghost" disabled={saving} onClick={() => setConfirmDelete(false)}>取消</Button>
              </div>
            ) : (
              <Button size="sm" variant="ghost" className="mr-auto text-red-600" icon={<Trash2 className="w-3.5 h-3.5" />} disabled={saving} onClick={() => setConfirmDelete(true)}>
                删除里程碑
              </Button>
            )
          )}
          {!confirmDelete && (
            <>
              <Button variant="secondary" size="sm" disabled={saving} onClick={onClose} className={cn(!isEdit && 'ml-auto')}>取消</Button>
              <Button
                variant="primary" size="sm"
                icon={saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                disabled={saving || !canSave}
                onClick={save}
              >
                {saving ? '保存中…' : isEdit ? '保存' : '创建里程碑'}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
