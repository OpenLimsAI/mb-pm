// 财务 —— 组合预算与成本中心（CTO 视角）。
//
//「预算总览」：
//   §1 组合 KPI —— 总预算 / 已花费 / 已承诺 / 剩余 / 执行率 / 超支项目
//   §2 预算执行 + 成本结构（手工填报）+ 超支项目
//   §3 分项目预算明细 —— 每个项目的预算执行 + 任务预算合计；有「编辑项目」权限的人可逐项目编辑预算
// 财务 AI 能力统一进入项目 AI 助手；旧标签链接保留跳转。
//
// 口径：已花费 = 该项目全部任务实际花费合计（后端实时汇总，不含内部人力）；
//       总预算 / 已承诺 / 成本结构为项目级填报。

import { useMemo, useState } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { Wallet, CheckCircle2, AlertTriangle, ChevronRight, Pencil, Sparkles } from 'lucide-react'
import {
  projects, getProjectFinance, getProjectTasks,
  summarizeFinances, executionRate, isOverBudget,
} from '../mock'
import { useDataStore } from '../store/data'
import { useAuth } from '../store/auth'
import { can } from '../lib/permissions'
import { Card, CardHeader, CardBody, Tag, HealthTag } from '../components/ui'
import { FinanceEditDialog } from '../components/finance/FinanceEditDialog'
import { projectAssistantUrl } from '../lib/projectAssistantNavigation'
import { cn } from '../lib/cn'
import type { Project } from '../types'

const fmt = (v: number) => `¥${Math.round(v).toLocaleString('zh-CN')}万`
const CATS = ['人力', '设备', '原材料', '外部服务', '其他'] as const

export default function Finance() {
  const role = useAuth((s) => s.currentUser?.role)
  const canAI = can(role, 'ai.finance')
  const [params] = useSearchParams()
  if (canAI && params.get('tab') === 'ai') return <Navigate to={projectAssistantUrl('finance')} replace />

  return (
    <div className="p-6 max-w-[1600px] mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold text-ink-900 flex items-center gap-2">
          <Wallet className="w-6 h-6 text-brand-600" />财务
        </h1>
        <p className="text-sm text-ink-500 mt-1">
          组合预算与成本中心 —— 已花费 = 各项目任务实际花费合计（WBS 录入，不含内部人力）；总预算、已承诺、成本结构由系统管理员 / CMC 负责人维护。
        </p>
      </div>

      {canAI && <Link className="inline-flex items-center gap-2 text-sm text-brand-700" to={projectAssistantUrl('finance')}><Sparkles className="h-4 w-4" />在项目 AI 助手中评估组合财务</Link>}
      <FinanceOverview />
    </div>
  )
}

function FinanceOverview() {
  const navigate = useNavigate()
  const version = useDataStore((s) => s.version)
  const canEdit = can(useAuth((s) => s.currentUser?.role), 'project.edit')
  const [editing, setEditing] = useState<Project | null>(null)

  const data = useMemo(() => {
    // 全部可见项目 → 关联预算 + 任务预算合计（后端汇总优先；无预算记录时按可见任务计算）
    const rows = projects
      .map((p) => {
        const f = getProjectFinance(p.id)
        const taskBudget = f?.taskBudget ?? getProjectTasks(p.id).reduce((a, t) => a + (t.costBudget ?? 0), 0)
        return { p, f, taskBudget }
      })
      .sort((a, b) => (b.f?.totalBudget ?? 0) - (a.f?.totalBudget ?? 0))

    const summary = summarizeFinances(projects.map((p) => p.id))
    const taskBudgetTotal = rows.reduce((a, r) => a + r.taskBudget, 0)
    const cats = CATS
      .map((c) => ({ cat: c, val: summary.byCategory[c] }))
      .filter((x) => x.val > 0)
      .sort((a, b) => b.val - a.val)
    const catTotal = cats.reduce((a, x) => a + x.val, 0)
    const overBudget = rows.filter((r) => r.f && isOverBudget(r.f))
    return { rows, summary, taskBudgetTotal, cats, catTotal, overBudget }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version])

  const { summary } = data
  const spentPct = summary.totalBudget ? (summary.totalSpent / summary.totalBudget) * 100 : 0
  const commitPct = summary.totalBudget ? (summary.totalCommitted / summary.totalBudget) * 100 : 0

  return (
    <div className="space-y-6">

      {/* §1 KPI */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <Stat label="组合总预算" value={fmt(summary.totalBudget)} tone="blue" />
        <Stat label="已花费" value={fmt(summary.totalSpent)} sub={`${summary.totalBudget ? Math.round(summary.totalSpent / summary.totalBudget * 100) : 0}% of 预算 · 任务实际花费合计`} tone="indigo" />
        <Stat label="已承诺" value={fmt(summary.totalCommitted)} tone="amber" />
        <Stat label="剩余" value={fmt(summary.remaining)} tone={summary.remaining < 0 ? 'red' : 'emerald'} />
        <Stat label="执行率" value={`${summary.executionRate}%`} tone={summary.overBudgetCount > 0 ? 'red' : 'emerald'} />
        <Stat label="超支项目" value={summary.overBudgetCount} sub={summary.overBudgetCount > 0 ? '需关注' : '无'} tone={summary.overBudgetCount > 0 ? 'red' : 'emerald'} />
      </div>

      {/* §2 预算执行 + 成本结构 + 超支项目 */}
      <Card>
        <CardHeader
          title={<span className="flex items-center gap-2"><Wallet className="w-4 h-4 text-brand-600" />组合预算执行</span>}
          subtitle="在研项目预算执行与成本结构"
          action={<Tag tone={data.overBudget.length > 0 ? 'red' : 'green'}>{data.overBudget.length > 0 ? `${data.overBudget.length} 超支` : '无超支'}</Tag>}
        />
        <CardBody>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {/* 总预算 + 执行 */}
            <div>
              <div className="text-xs text-ink-500">组合总预算</div>
              <div className="text-2xl font-semibold text-ink-900 mt-0.5">{fmt(summary.totalBudget)}</div>
              <div className="text-xs text-ink-500 mt-1">执行率 <span className="font-medium text-ink-700">{summary.executionRate}%</span></div>
              <div className="mt-3 h-2.5 rounded-full bg-ink-100 overflow-hidden flex">
                <div className="h-full bg-brand-600" style={{ width: `${Math.min(100, spentPct)}%` }} title="已花费" />
                <div className="h-full bg-amber-400" style={{ width: `${Math.min(100 - Math.min(100, spentPct), commitPct)}%` }} title="已承诺" />
              </div>
              <div className="flex items-center gap-3 mt-2 text-[11px] text-ink-500 flex-wrap">
                <span className="flex items-center gap-1"><i className="w-2 h-2 rounded-sm bg-brand-600 inline-block" />已花费 {fmt(summary.totalSpent)}</span>
                <span className="flex items-center gap-1"><i className="w-2 h-2 rounded-sm bg-amber-400 inline-block" />已承诺 {fmt(summary.totalCommitted)}</span>
                <span className="flex items-center gap-1"><i className="w-2 h-2 rounded-sm bg-emerald-400 inline-block" />剩余 {fmt(summary.remaining)}</span>
              </div>
            </div>

            {/* 成本结构 */}
            <div>
              <div className="text-xs text-ink-500 mb-2">成本结构（手工填报）</div>
              {data.cats.length === 0 && <div className="text-xs text-ink-400">未填报</div>}
              <div className="space-y-1.5">
                {data.cats.map(({ cat, val }) => {
                  const pct = data.catTotal ? Math.round((val / data.catTotal) * 100) : 0
                  return (
                    <div key={cat} className="flex items-center gap-2">
                      <span className="text-xs text-ink-700 w-16 shrink-0">{cat}</span>
                      <div className="flex-1 h-1.5 rounded-full bg-ink-100 overflow-hidden">
                        <div className="h-full bg-brand-500 rounded-full" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-[11px] text-ink-500 w-20 text-right shrink-0">{fmt(val)}</span>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* 超支项目 */}
            <div>
              <div className="text-xs text-ink-500 mb-2">超支项目</div>
              {data.overBudget.length === 0 ? (
                <div className="flex items-center gap-2 text-sm text-emerald-700 py-2">
                  <CheckCircle2 className="w-4 h-4" /> 无超支项目
                </div>
              ) : (
                <ul className="space-y-1.5">
                  {data.overBudget.slice(0, 4).map(({ p, f }) => (
                    <li key={p.id} className="flex items-center gap-2 text-sm">
                      <span className="text-xs font-mono text-ink-500">{p.code}</span>
                      <span className="min-w-0 truncate flex-1" title={p.name}>{p.name}</span>
                      <span className="text-red-600 font-medium">{executionRate(f!)}%</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </CardBody>
      </Card>

      {/* §3 分项目预算明细 */}
      <Card>
        <CardHeader
          title="分项目预算明细"
          subtitle={`点击行进入项目详情 · 任务预算合计为各任务成本预算之和${canEdit ? ' · 点击铅笔图标编辑项目预算' : ''}`}
        />
        <CardBody className="p-0 overflow-x-auto">
          <table className="w-full text-sm border-collapse min-w-[920px]">
            <thead>
              <tr className="text-[11px] text-ink-500 bg-ink-100/60 border-b border-ink-300/50">
                <th className="text-left font-medium px-4 py-2">项目</th>
                <th className="text-right font-medium px-3 py-2 w-[110px]">总预算</th>
                <th className="text-right font-medium px-3 py-2 w-[110px]">已花费</th>
                <th className="text-right font-medium px-3 py-2 w-[110px]">已承诺</th>
                <th className="text-left font-medium px-3 py-2 w-[160px]">执行率</th>
                <th className="text-right font-medium px-3 py-2 w-[110px]">剩余</th>
                <th className="text-right font-medium px-3 py-2 w-[110px]">任务预算合计</th>
                <th className="w-16" />
              </tr>
            </thead>
            <tbody>
              {data.rows.map(({ p, f, taskBudget }) => {
                const over = f ? isOverBudget(f) : false
                const rate = f ? executionRate(f) : 0
                return (
                  <tr
                    key={p.id}
                    onClick={() => navigate(`/projects/${p.id}`)}
                    className="border-b border-ink-200/60 hover:bg-brand-50/30 cursor-pointer"
                  >
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2 min-w-0">
                        <HealthTag health={p.health} />
                        <span className="font-mono text-[11px] text-ink-400 shrink-0">{p.code}</span>
                        <span className="text-ink-900 min-w-0 truncate" title={p.name}>{p.name}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-medium text-ink-900">{f ? fmt(f.totalBudget) : '—'}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-ink-700">{f ? fmt(f.spent) : '—'}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-ink-700">{f ? fmt(f.committed) : '—'}</td>
                    <td className="px-3 py-2.5">
                      {f ? (
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-1.5 rounded-full bg-ink-100 overflow-hidden min-w-[60px]">
                            <div className={cn('h-full rounded-full', over ? 'bg-red-500' : 'bg-brand-500')} style={{ width: `${Math.min(100, rate)}%` }} />
                          </div>
                          <span className={cn('text-[11px] tabular-nums w-9 text-right', over ? 'text-red-600 font-medium' : 'text-ink-500')}>{rate}%</span>
                        </div>
                      ) : <span className="text-ink-400">—</span>}
                    </td>
                    <td className={cn('px-3 py-2.5 text-right tabular-nums', f && (f.totalBudget - f.spent - f.committed) < 0 ? 'text-red-600' : 'text-ink-700')}>
                      {f ? fmt(f.totalBudget - f.spent - f.committed) : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-amber-700">{taskBudget > 0 ? fmt(taskBudget) : '—'}</td>
                    <td className="px-2">
                      <div className="flex items-center justify-end gap-1 text-ink-300">
                        {canEdit && (
                          <button
                            type="button"
                            className="p-1 rounded text-ink-500 hover:text-brand-700 hover:bg-brand-50"
                            title={f ? '编辑项目预算' : '设置项目预算'}
                            aria-label={`${f ? '编辑' : '设置'}「${p.name}」的项目预算`}
                            onClick={(e) => { e.stopPropagation(); setEditing(p) }}
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                        )}
                        <ChevronRight className="w-4 h-4" />
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-ink-300/50 bg-ink-100/40 font-medium text-ink-900">
                <td className="px-4 py-2.5">合计（{data.rows.length} 项目）</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{fmt(summary.totalBudget)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{fmt(summary.totalSpent)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{fmt(summary.totalCommitted)}</td>
                <td className="px-3 py-2.5 text-[11px] text-ink-500">执行率 {summary.executionRate}%</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{fmt(summary.remaining)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-amber-700">{fmt(data.taskBudgetTotal)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </CardBody>
      </Card>

      <p className="text-[11px] text-ink-400 flex items-center gap-1">
        <AlertTriangle className="w-3 h-3" />
        已花费按各任务在「项目 → WBS」录入的实际花费自动汇总（不含内部人力）；任务预算由项目负责人及以上在 WBS 维护，执行层只录入实际花费。
      </p>
      {editing && <FinanceEditDialog project={editing} finance={getProjectFinance(editing.id)} onClose={() => setEditing(null)} />}
    </div>
  )
}

const STAT_TONE: Record<string, string> = {
  blue: 'text-brand-700',
  indigo: 'text-indigo-700',
  amber: 'text-amber-700',
  emerald: 'text-emerald-700',
  red: 'text-red-700',
}

function Stat({ label, value, sub, tone = 'blue' }: {
  label: string
  value: string | number
  sub?: string
  tone?: keyof typeof STAT_TONE | string
}) {
  return (
    <Card>
      <CardBody className="py-3">
        <div className="text-xs text-ink-500">{label}</div>
        <div className={cn('text-xl font-semibold mt-0.5 tabular-nums', STAT_TONE[tone] ?? 'text-ink-900')}>{value}</div>
        {sub && <div className="text-[11px] text-ink-400 mt-0.5">{sub}</div>}
      </CardBody>
    </Card>
  )
}
