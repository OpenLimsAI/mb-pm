// 计划基线与版本对标。
//
// 设立基线 = 冻结当前项目计划快照（结束日/预算/里程碑计划日期）。之后选择任一基线对标，
// 展示「当前计划 vs 基线」的项目结束日顺延、预算变化、里程碑逐条漂移与新增/移除，并记录变更原因。

import { useState } from 'react'
import {
  Flag, Plus, Trash2, Save, Loader2, X, ArrowRight, TrendingUp, Wallet, Diamond,
  CheckCircle2, AlertTriangle, Flame, ListChecks,
} from 'lucide-react'
import type { Project } from '../../types'
import { Card, CardHeader, CardBody, Button, Tag, EmptyState } from '../ui'
import { getProjectBaselines, getProjectTasks, projectFinances, findUser } from '../../mock'
import { useAuth } from '../../store/auth'
import { useDataStore } from '../../store/data'
import { createProjectBaseline, deleteProjectBaseline } from '../../data/bootstrap'
import { compareBaseline, type MilestoneDrift } from '../../lib/baseline'
import { cn } from '../../lib/cn'

const MANAGER_ROLES = ['admin', 'cmc_lead', 'project_lead']
const fmtBudget = (v: number) => `¥${v.toLocaleString('zh-CN')}万`

export function BaselinePanel({ project }: { project: Project }) {
  useDataStore((s) => s.version)
  const role = useAuth((s) => s.currentUser?.role)
  const canManage = !!role && MANAGER_ROLES.includes(role)

  const [creating, setCreating] = useState(false)
  const [label, setLabel] = useState('')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | undefined>()

  const baselines = getProjectBaselines(project.id) // 新→旧
  const selected = baselines.find((b) => b.id === selectedId) ?? baselines[0]

  const currentTasks = getProjectTasks(project.id)
  const currentMilestones = currentTasks.filter((t) => t.isMilestone)
  const currentBudget = projectFinances.find((f) => f.projectId === project.id)?.totalBudget ?? 0
  const cmp = selected
    ? compareBaseline(selected.snapshot, project, currentMilestones, currentBudget, currentTasks.length)
    : null

  const save = async () => {
    if (!label.trim()) { setError('请填写基线名称。'); return }
    setSaving(true); setError(null)
    try {
      const id = await createProjectBaseline(project.id, label.trim(), reason.trim())
      setSelectedId(id)
      setCreating(false); setLabel(''); setReason('')
    } catch (e) {
      console.error(e); setError('设立基线失败，请确认后端已启动后重试。')
    } finally {
      setSaving(false)
    }
  }

  const remove = async (id: string) => {
    await deleteProjectBaseline(id)
    if (selectedId === id) setSelectedId(undefined)
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title={<span className="flex items-center gap-2"><Flag className="w-4 h-4 text-brand-600" />计划基线与版本对标</span>}
          subtitle="冻结当前计划为基线，对标后续计划的进度顺延与成本变化"
          action={canManage && !creating && (
            <Button size="sm" variant="primary" icon={<Plus className="w-3.5 h-3.5" />} onClick={() => setCreating(true)}>
              设立基线
            </Button>
          )}
        />
        <CardBody>
          {/* 设立基线表单 */}
          {creating && (
            <div className="mb-4 p-3 rounded-lg border border-brand-200 bg-brand-50/40 space-y-2.5">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                <label className="block">
                  <span className="text-[11px] text-ink-500">基线名称 <span className="text-red-500">*</span></span>
                  <input className="input mt-1" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="如：立项基线 / IND 申报基线 / v2 重排" />
                </label>
                <label className="block">
                  <span className="text-[11px] text-ink-500">变更原因 / 说明</span>
                  <input className="input mt-1" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="为何在此刻设立基线（可选）" />
                </label>
              </div>
              {error && <div className="text-xs text-red-600">{error}</div>}
              <div className="flex items-center justify-end gap-2">
                <Button size="sm" variant="secondary" disabled={saving} onClick={() => { setCreating(false); setError(null) }}>取消</Button>
                <Button size="sm" variant="primary" disabled={saving || !label.trim()}
                  icon={saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                  onClick={save}>
                  {saving ? '保存中…' : '冻结当前计划为基线'}
                </Button>
              </div>
            </div>
          )}

          {baselines.length === 0 ? (
            <EmptyState
              title="尚未设立基线"
              description={canManage ? '点击「设立基线」冻结当前计划，之后即可对标计划偏移。' : '暂无可对标的基线。'}
            />
          ) : (
            <div className="space-y-1.5">
              <div className="text-[11px] text-ink-500 uppercase tracking-wider mb-1">选择对标基线（{baselines.length}）</div>
              {baselines.map((b) => {
                const author = findUser(b.createdBy || '')
                const active = selected?.id === b.id
                return (
                  <div key={b.id}
                    onClick={() => setSelectedId(b.id)}
                    className={cn('flex items-center gap-2.5 px-3 py-2 rounded-md border cursor-pointer group',
                      active ? 'border-brand-400 bg-brand-50/60 ring-1 ring-brand-200' : 'border-ink-300/60 hover:bg-ink-100/50')}>
                    <Flag className={cn('w-3.5 h-3.5 shrink-0', active ? 'text-brand-600' : 'text-ink-400')} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-ink-900 min-w-0 truncate" title={b.label}>{b.label}</span>
                        {active && <Tag tone="blue">对标中</Tag>}
                      </div>
                      <div className="text-[11px] text-ink-500 truncate" title={[b.createdAt.slice(0, 10), author?.displayName, b.reason].filter(Boolean).join(' · ')}>
                        {b.createdAt.slice(0, 10)}
                        {author && <> · {author.displayName}</>}
                        {b.reason && <> · {b.reason}</>}
                      </div>
                    </div>
                    <span className="text-[11px] text-ink-400 shrink-0">基线结束 {b.snapshot.projectPlannedEnd}</span>
                    {canManage && (
                      <button onClick={(e) => { e.stopPropagation(); remove(b.id) }}
                        className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-red-50 text-ink-400 hover:text-red-600 transition-opacity"
                        title="删除基线">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </CardBody>
      </Card>

      {/* 对标结果 */}
      {cmp && selected && (
        <Card>
          <CardHeader
            title={<span className="flex items-center gap-2"><ListChecks className="w-4 h-4 text-brand-600" />对标「{selected.label}」</span>}
            subtitle={`基线设立于 ${selected.createdAt.slice(0, 10)} —— 当前计划相对该基线的偏移`}
          />
          <CardBody className="space-y-4">
            {/* 概要 */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <DriftCard
                icon={<TrendingUp className="w-4 h-4" />} label="项目结束日"
                from={cmp.baselineProjectEnd} to={cmp.currentProjectEnd}
                delta={cmp.projectEndSlipDays} unit="天" higherIsBad
              />
              <DriftCard
                icon={<Wallet className="w-4 h-4" />} label="组合预算"
                from={fmtBudget(cmp.baselineBudget)} to={fmtBudget(cmp.currentBudget)}
                delta={cmp.budgetDelta} unit="万" higherIsBad
              />
              <DriftCard
                icon={<Diamond className="w-4 h-4" />} label="任务数"
                from={`${cmp.baselineTaskCount}`} to={`${cmp.currentTaskCount}`}
                delta={cmp.taskCountDelta} unit="个"
              />
            </div>

            {/* 里程碑漂移概览 */}
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Tag tone={cmp.slippedCount > 0 ? 'red' : 'gray'}>顺延 {cmp.slippedCount}</Tag>
              <Tag tone={cmp.aheadCount > 0 ? 'green' : 'gray'}>提前 {cmp.aheadCount}</Tag>
              <Tag tone="blue">新增 {cmp.addedCount}</Tag>
              <Tag tone={cmp.removedCount > 0 ? 'yellow' : 'gray'}>移除 {cmp.removedCount}</Tag>
              {cmp.maxSlipDays > 0 && <span className="text-ink-500">最大单点顺延 <b className="text-red-600">{cmp.maxSlipDays}</b> 天</span>}
            </div>

            {/* 里程碑漂移表 */}
            <div className="border border-ink-300/50 rounded-md overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[11px] text-ink-500 bg-ink-100/60 border-b border-ink-300/50">
                    <th className="text-left font-medium px-3 py-2">里程碑</th>
                    <th className="text-left font-medium px-2 py-2 w-[110px]">基线计划</th>
                    <th className="text-center font-medium px-2 py-2 w-[40px]"></th>
                    <th className="text-left font-medium px-2 py-2 w-[110px]">当前计划</th>
                    <th className="text-right font-medium px-3 py-2 w-[120px]">漂移</th>
                  </tr>
                </thead>
                <tbody>
                  {cmp.milestones.map((m) => <DriftRow key={m.id} m={m} />)}
                </tbody>
              </table>
            </div>
          </CardBody>
        </Card>
      )}
    </div>
  )
}

function DriftCard({ icon, label, from, to, delta, unit, higherIsBad }: {
  icon: React.ReactNode; label: string; from: string; to: string; delta: number; unit: string; higherIsBad?: boolean
}) {
  const tone = delta === 0 ? 'flat' : (higherIsBad ? (delta > 0 ? 'bad' : 'good') : 'neutral')
  const color = tone === 'bad' ? 'text-red-600' : tone === 'good' ? 'text-emerald-600' : tone === 'neutral' ? 'text-brand-600' : 'text-ink-400'
  const sign = delta > 0 ? '+' : ''
  return (
    <div className="rounded-lg border border-ink-300/50 p-3">
      <div className="flex items-center gap-1.5 text-xs text-ink-500">{icon}{label}</div>
      <div className="mt-1.5 flex items-center gap-2 text-sm">
        <span className="text-ink-500 font-mono">{from}</span>
        <ArrowRight className="w-3.5 h-3.5 text-ink-400 shrink-0" />
        <span className="font-mono font-medium text-ink-900">{to}</span>
      </div>
      <div className={cn('mt-1 text-sm font-semibold', color)}>
        {delta === 0 ? '无变化' : `${sign}${delta} ${unit}`}
      </div>
    </div>
  )
}

const driftStatusMeta: Record<MilestoneDrift['status'], { tone: 'red' | 'green' | 'blue' | 'yellow' | 'gray'; label: string; icon: React.ReactNode }> = {
  slip:    { tone: 'red',    label: '顺延', icon: <AlertTriangle className="w-3 h-3" /> },
  ahead:   { tone: 'green',  label: '提前', icon: <CheckCircle2 className="w-3 h-3" /> },
  on:      { tone: 'gray',   label: '准时', icon: <CheckCircle2 className="w-3 h-3" /> },
  added:   { tone: 'blue',   label: '新增', icon: <Plus className="w-3 h-3" /> },
  removed: { tone: 'yellow', label: '移除', icon: <X className="w-3 h-3" /> },
}

function DriftRow({ m }: { m: MilestoneDrift }) {
  const meta = driftStatusMeta[m.status]
  return (
    <tr className="border-b border-ink-200/60 last:border-b-0">
      <td className="px-3 py-1.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <Diamond className="w-3 h-3 text-amber-600 shrink-0" />
          <span className="font-mono text-[10px] text-ink-400 shrink-0">{m.code}</span>
          <span className="text-xs min-w-0 flex-1 truncate" title={m.name}>{m.name}</span>
          {m.isCriticalPath && <Flame className="w-3 h-3 text-red-500 shrink-0" aria-label="关键路径" />}
        </div>
      </td>
      <td className="px-2 py-1.5 font-mono text-[11px] text-ink-500">{m.baselineEnd ?? '—'}</td>
      <td className="px-2 py-1.5 text-center"><ArrowRight className="w-3 h-3 text-ink-300 inline" /></td>
      <td className="px-2 py-1.5 font-mono text-[11px] text-ink-700">{m.currentEnd ?? '—'}</td>
      <td className="px-3 py-1.5 text-right">
        <span className="inline-flex items-center gap-1.5 justify-end">
          {m.status === 'slip' && <span className="text-xs font-semibold text-red-600 tabular-nums">+{m.slipDays}天</span>}
          {m.status === 'ahead' && <span className="text-xs font-semibold text-emerald-600 tabular-nums">{Math.abs(m.slipDays)}天</span>}
          <Tag tone={meta.tone} className="gap-1">{meta.icon}{meta.label}</Tag>
        </span>
      </td>
    </tr>
  )
}
