// 复制项目对话框（项目列表「复制项目」）：选一个已有项目，生成一个结构与计划完全相同的新项目。
//
// 照搬：子项目、任务 / 里程碑、前置依赖、负责人与协作人、工时、成本预算、备注、团队成员、项目总预算。
// 重置：任务状态与进度（全部「未开始」）、实际日期、实际工时与实际花费、已承诺与成本结构。不复制基线与 AI 分析。
// 改计划开始日期时，全部计划日期按同样天数平移。后端一个事务内完成（POST /projects/{id}/copy）。

import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, Copy, Diamond, Info, Loader2, X } from 'lucide-react'
import { Button, Tag } from '../ui'
import { projects, subProjects, taskDependencies, tasks, users } from '../../mock'
import { copyProject } from '../../api/projects'
import { asAPIError } from '../../api/client'
import { refreshAllData } from '../../data/bootstrap'
import type { Project } from '../../types'
import { cn } from '../../lib/cn'

const DAY = 86400000
const shiftDays = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / DAY)
const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v))
/** 默认沿用原项目负责人（已停用则留空，需另选） */
const defaultOwner = (p?: Project) => (p && users.some((u) => u.id === p.ownerId && u.isActive) ? p.ownerId : '')

export function CopyProjectDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate()
  const sources = useMemo(() => [...projects].sort((a, b) => a.code.localeCompare(b.code)), [])
  // 只有一个项目时直接选中
  const only = sources.length === 1 ? sources[0] : undefined
  const [sourceId, setSourceId] = useState(only?.id ?? '')
  const [code, setCode] = useState('')
  const [name, setName] = useState(only ? `${only.name}（副本）` : '')
  const [nameTouched, setNameTouched] = useState(false)
  const [ownerId, setOwnerId] = useState(() => defaultOwner(only))
  const [plannedStart, setPlannedStart] = useState(only?.plannedStart ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !saving) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, saving])

  const source = sources.find((p) => p.id === sourceId)
  const stats = useMemo(() => {
    if (!source) return null
    const subIds = new Set(subProjects.filter((s) => s.projectId === source.id).map((s) => s.id))
    const own = tasks.filter((t) => subIds.has(t.subProjectId))
    const taskIds = new Set(own.map((t) => t.id))
    return {
      subProjects: subIds.size,
      tasks: own.filter((t) => !t.isMilestone).length,
      milestones: own.filter((t) => t.isMilestone).length,
      dependencies: taskDependencies.filter((d) => taskIds.has(d.predecessorId) && taskIds.has(d.successorId)).length,
      members: source.memberIds?.length ?? 0,
    }
  }, [source])

  // 负责人候选：在职的项目负责人 / CMC 负责人；原项目负责人（在职）一并列出
  const owners = useMemo(
    () => users.filter((u) => u.isActive && (u.role === 'project_lead' || u.role === 'cmc_lead' || u.id === source?.ownerId)),
    [source],
  )

  const chooseSource = (id: string) => {
    const next = sources.find((p) => p.id === id)
    setSourceId(id)
    setError(null)
    if (!next) return
    if (!nameTouched) setName(`${next.name}（副本）`)
    setOwnerId(defaultOwner(next))
    setPlannedStart(next.plannedStart)
  }

  const codeText = code.trim()
  const nameText = name.trim()
  const codeError = codeText.length > 40 ? '最多 40 个字符'
    : projects.some((p) => p.code === codeText) ? '项目编号已存在，请换一个' : null
  const nameError = nameText.length > 200 ? '最多 200 个字符' : null
  const shift = source && isDate(plannedStart) ? shiftDays(source.plannedStart, plannedStart) : 0
  const canSubmit = !!source && !!codeText && !!nameText && !codeError && !nameError && !!ownerId && isDate(plannedStart)

  const submit = async () => {
    if (!source || !canSubmit || saving) return
    setSaving(true)
    setError(null)
    let id: string
    try {
      id = (await copyProject(source.id, { code: codeText, name: nameText, ownerId, plannedStart })).id
    } catch (e) {
      const { detail } = asAPIError(e)
      setError(typeof detail === 'string' ? detail : '提交的内容无效，请检查后重试。')
      setSaving(false)
      return
    }
    try {
      await refreshAllData()
    } catch {
      // 已复制成功；数据刷新失败时不能报「复制失败」（否则重试会因编号重复被拒）
      setError(`已复制为 ${codeText}，但页面数据刷新失败，请刷新页面后查看。`)
      setSaving(false)
      return
    }
    onClose()
    navigate(`/projects/${id}`)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="复制项目">
      <div className="absolute inset-0 bg-black/40" onClick={() => !saving && onClose()} />
      <div className="relative w-full max-w-[560px] max-h-[90vh] bg-white rounded-xl shadow-2xl overflow-y-auto flex flex-col">
        {/* Header */}
        <div className="flex items-center gap-2.5 px-5 py-4 border-b border-ink-300/40 sticky top-0 bg-white z-10">
          <div className="w-8 h-8 rounded-md bg-brand-600 text-white flex items-center justify-center">
            <Copy className="w-4 h-4" />
          </div>
          <h2 className="text-lg font-semibold text-ink-900 flex-1">复制项目</h2>
          <button onClick={onClose} disabled={saving} className="p-1.5 rounded-md hover:bg-ink-100 text-ink-500" aria-label="关闭">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4">
          <label className="block">
            <span className="text-[11px] text-ink-500">要复制的项目 <span className="text-red-500">*</span></span>
            <select className="input mt-1" value={sourceId} onChange={(e) => chooseSource(e.target.value)}>
              <option value="">请选择项目</option>
              {sources.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}
            </select>
            {stats && source && (
              <div className="mt-2 flex items-center gap-2 flex-wrap text-[11px] text-ink-500">
                <Tag tone="gray">{stats.subProjects} 子项目</Tag>
                <Tag tone="gray">{stats.tasks} 任务</Tag>
                <span className="inline-flex items-center gap-1"><Diamond className="w-3 h-3 text-amber-600" />{stats.milestones} 里程碑</span>
                <span>{stats.dependencies} 条依赖</span>
                <span>团队 {stats.members} 人</span>
                <span className="tabular-nums">计划 {source.plannedStart} ~ {source.plannedEnd}</span>
              </div>
            )}
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-[11px] text-ink-500">新项目编号 <span className="text-red-500">*</span></span>
              <input
                autoFocus
                className={cn('input mt-1', codeError && 'border-red-400')}
                value={code} onChange={(e) => setCode(e.target.value)} maxLength={60}
                placeholder="如：CMB821"
              />
              {codeError && <span className="block text-[11px] text-red-600 mt-1">{codeError}</span>}
            </label>
            <label className="block">
              <span className="text-[11px] text-ink-500">项目负责人 <span className="text-red-500">*</span></span>
              <select className="input mt-1" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
                <option value="">请选择</option>
                {owners.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
              </select>
            </label>
          </div>

          <label className="block">
            <span className="text-[11px] text-ink-500">新项目名称 <span className="text-red-500">*</span></span>
            <input
              className={cn('input mt-1', nameError && 'border-red-400')}
              value={name} maxLength={220}
              onChange={(e) => { setName(e.target.value); setNameTouched(true) }}
              placeholder="如：821项目IND申报"
            />
            {nameError && <span className="block text-[11px] text-red-600 mt-1">{nameError}</span>}
          </label>

          <label className="block">
            <span className="text-[11px] text-ink-500">计划开始 <span className="text-red-500">*</span></span>
            <input type="date" className="input mt-1 max-w-[200px]" value={plannedStart} onChange={(e) => setPlannedStart(e.target.value)} disabled={!source} />
            {source && isDate(plannedStart) && (
              <span className="block text-[11px] text-ink-500 mt-1">
                {shift === 0
                  ? '与原项目相同，全部计划日期保持不变。'
                  : `全部计划日期整体${shift > 0 ? '推后' : '提前'} ${Math.abs(shift)} 天（任务之间的间隔不变）。`}
              </span>
            )}
          </label>

          <div className="text-xs rounded-md bg-ink-100/70 text-ink-700 p-3 space-y-1">
            <p className="flex gap-1.5"><Info className="w-3.5 h-3.5 shrink-0 mt-0.5 text-brand-600" />
              <span><b className="font-medium">照搬：</b>子项目、任务与里程碑、前置依赖、负责人与协作人、工时、成本预算、备注、团队成员、项目总预算。</span>
            </p>
            <p className="pl-5"><b className="font-medium">重置：</b>任务全部「未开始」、进度 0，不带实际日期、实际工时和实际花费；已承诺与成本结构清零。</p>
            <p className="pl-5"><b className="font-medium">不复制：</b>基线、AI 分析报告。已停用的人员由新项目负责人接替。</p>
          </div>

          {error && (
            <div role="alert" className="text-xs text-red-600 flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />{error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-ink-300/40 sticky bottom-0 bg-white flex items-center justify-end gap-2">
          <Button variant="secondary" size="sm" disabled={saving} onClick={onClose}>取消</Button>
          <Button
            variant="primary" size="sm"
            icon={saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Copy className="w-3.5 h-3.5" />}
            disabled={saving || !canSubmit}
            onClick={submit}
          >
            {saving ? '复制中…' : '复制项目'}
          </Button>
        </div>
      </div>
    </div>
  )
}
