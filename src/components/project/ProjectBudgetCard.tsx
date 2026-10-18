// 项目预算与成本卡 —— 项目详情「概览」（只读）与「编辑项目」（可改预算）共用。
//
// 口径（与后端 services/finance.py 一致）：
//   · 项目预算：总预算 / 已承诺 / 成本结构在「编辑项目」中修改（权限 project.edit），预算与项目修改一起保存。
//   · 已花费 = 该项目全部任务的实际花费合计（WBS 中录入，不含内部人力），自动汇总、不可手改。
//   · WBS 任务预算：各任务成本预算之和，并按子项目分解（模板 costBudget → 任务 costBudget）。
// 订阅数据版本：在 WBS 行内改预算 / 花费后即时刷新。

import { useMemo } from 'react'
import { Wallet, Coins, AlertTriangle } from 'lucide-react'
import type { Project } from '../../types'
import { Card, CardHeader, CardBody, Tag } from '../ui'
import {
  FINANCE_CATEGORIES, getProjectFinance, executionRate, isOverBudget,
  getProjectSubs, getSubTasks, getProjectTasks,
} from '../../mock'
import { can } from '../../lib/permissions'
import { useAuth } from '../../store/auth'
import { useDataStore } from '../../store/data'
import { FinanceFields } from '../finance/FinanceFields'
import { financeDraftState, type FinanceDraft } from '../../lib/financeDraft'

const fmt = (v: number) => `¥${Math.round(v).toLocaleString('zh-CN')}万`

export function ProjectBudgetCard({ project, editor }: { project: Project; editor?: {
  draft: FinanceDraft
  onChange: (draft: FinanceDraft) => void
  spent: number
  groups: { id: string; name: string; total: number; cost: number }[]
  disabled: boolean
  showRequiredError: boolean
} }) {
  // 订阅版本：WBS 改预算 / 花费、编辑项目预算后重新汇总
  const version = useDataStore((s) => s.version)
  const role = useAuth((s) => s.currentUser?.role)
  const canEditProject = can(role, 'project.edit')

  const storedFinance = getProjectFinance(project.id)
  const finance = editor ? (editor.draft.totalBudget.trim() ? {
    projectId: project.id, ...financeDraftState(editor.draft).value, spent: editor.spent,
    taskBudget: editor.groups.reduce((sum, g) => sum + g.total, 0),
  } : undefined) : storedFinance

  // 自下而上：任务预算合计 + 实际花费合计 + 按子项目分解（按当前用户可见的任务）
  const { taskTotal, costTotal, bySub } = useMemo(() => {
    if (editor) return {
      taskTotal: editor.groups.reduce((sum, g) => sum + g.total, 0),
      costTotal: editor.spent,
      bySub: editor.groups.filter((g) => g.total > 0 || g.cost > 0).map((g) => ({ sub: { id: g.id, name: g.name }, total: g.total, cost: g.cost })),
    }
    const subs = getProjectSubs(project.id).sort((a, b) => a.sortOrder - b.sortOrder)
    const bySub = subs
      .map((s) => {
        const ts = getSubTasks(s.id)
        return {
          sub: s,
          total: ts.reduce((a, t) => a + (t.costBudget ?? 0), 0),
          cost: ts.reduce((a, t) => a + (t.actualCost ?? 0), 0),
        }
      })
      .filter((x) => x.total > 0 || x.cost > 0)
    const projTasks = getProjectTasks(project.id)
    return {
      // 后端汇总覆盖全部任务（执行层只看得到自己的任务），有则优先
      taskTotal: finance?.taskBudget ?? projTasks.reduce((a, t) => a + (t.costBudget ?? 0), 0),
      costTotal: finance?.spent ?? projTasks.reduce((a, t) => a + (t.actualCost ?? 0), 0),
      bySub,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, version, editor])

  const over = finance ? isOverBudget(finance) : false
  const spentPct = finance && finance.totalBudget ? (finance.spent / finance.totalBudget) * 100 : 0
  const commitPct = finance && finance.totalBudget ? (finance.committed / finance.totalBudget) * 100 : 0
  const cats = finance
    ? FINANCE_CATEGORIES.map((c) => ({ cat: c, val: finance.breakdown?.[c] ?? 0 })).filter((x) => x.val > 0).sort((a, b) => b.val - a.val)
    : []
  const catTotal = cats.reduce((a, x) => a + x.val, 0)
  const allocatedPct = finance && finance.totalBudget ? Math.round((taskTotal / finance.totalBudget) * 100) : null

  return (
    <Card>
      <CardHeader
        title={<span className="flex items-center gap-2"><Wallet className="w-4 h-4 text-brand-600" />预算与成本</span>}
        subtitle={editor
          ? '直接修改下方预算，与项目信息和结构一起点击「保存修改」生效 · 金额单位：万元'
          : '项目预算执行（已花费 = 任务实际花费合计）· WBS 任务预算明细'}
        action={
          <div className="flex items-center gap-2">
            {finance
              ? <Tag tone={over ? 'red' : 'green'}>{over ? '超支' : `执行 ${executionRate(finance)}%`}</Tag>
              : <Tag tone="gray">未设置项目预算</Tag>}
          </div>
        }
      />
      <CardBody>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {editor ? (
            <div className="lg:col-span-2">
              <FinanceFields draft={editor.draft} onChange={editor.onChange} spent={editor.spent} taskBudget={taskTotal} disabled={editor.disabled} showRequiredError={editor.showRequiredError} />
            </div>
          ) : <>
          {/* 1. 项目预算执行 */}
          <div>
            <div className="text-xs text-ink-500">项目总预算</div>
            {finance ? (
              <>
                <div className="text-2xl font-semibold text-ink-900 mt-0.5">{fmt(finance.totalBudget)}</div>
                <div className="text-xs text-ink-500 mt-1">
                  执行率 <span className={`font-medium ${over ? 'text-red-600' : 'text-ink-700'}`}>{executionRate(finance)}%</span>
                  {finance.fiscalYear ? <span className="text-ink-400"> · {finance.fiscalYear}</span> : null}
                </div>
                <div className="mt-3 h-2.5 rounded-full bg-ink-100 overflow-hidden flex">
                  <div className="h-full bg-brand-600" style={{ width: `${Math.min(100, spentPct)}%` }} title="已花费" />
                  <div className="h-full bg-amber-400" style={{ width: `${Math.min(100 - Math.min(100, spentPct), commitPct)}%` }} title="已承诺" />
                </div>
                <div className="flex items-center gap-3 mt-2 text-[11px] text-ink-500 flex-wrap">
                  <span className="flex items-center gap-1" title="该项目全部任务实际花费的合计，自动汇总"><i className="w-2 h-2 rounded-sm bg-brand-600 inline-block" />已花费 {fmt(finance.spent)}</span>
                  <span className="flex items-center gap-1"><i className="w-2 h-2 rounded-sm bg-amber-400 inline-block" />已承诺 {fmt(finance.committed)}</span>
                  <span className="flex items-center gap-1"><i className="w-2 h-2 rounded-sm bg-emerald-400 inline-block" />剩余 {fmt(finance.totalBudget - finance.spent - finance.committed)}</span>
                </div>
                {over && (
                  <div className="mt-2 text-[11px] text-red-600 flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3" /> 已花费+已承诺超出总预算
                  </div>
                )}
                {finance.notes && <div className="mt-2 text-[11px] text-ink-500 line-clamp-2" title={finance.notes}>备注：{finance.notes}</div>}
              </>
            ) : (
              <div className="mt-2 text-xs text-ink-400 leading-relaxed">
                尚未设置项目预算。{canEditProject ? <>可在页首「编辑项目」中设置。</> : <>请联系系统管理员或项目负责人设置。</>}
              </div>
            )}
          </div>

          {/* 2. 成本结构（手工填报） */}
          <div>
            <div className="text-xs text-ink-500 mb-2">成本结构（手工填报）</div>
            {cats.length > 0 ? (
              <div className="space-y-1.5">
                {cats.map(({ cat, val }) => {
                  const pct = catTotal ? Math.round((val / catTotal) * 100) : 0
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
            ) : (
              <div className="text-xs text-ink-400">未填报</div>
            )}
          </div>

          </>}

          {/* 3. WBS 任务预算 / 实际花费（自下而上） */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-ink-500 flex items-center gap-1"><Coins className="w-3.5 h-3.5 text-amber-500" />任务预算 / 实际花费</span>
              <span className="text-sm">
                <span className="font-semibold text-ink-900">{fmt(taskTotal)}</span>
                <span className="text-ink-400"> / </span>
                <span className={`font-semibold ${costTotal > taskTotal ? 'text-red-600' : 'text-rose-600'}`}>{fmt(costTotal)}</span>
              </span>
            </div>
            <div className="text-[11px] text-ink-400 mb-2">
              花费占任务预算 <b className={costTotal > taskTotal ? 'text-red-600' : 'text-ink-600'}>{taskTotal ? Math.round(costTotal / taskTotal * 100) : 0}%</b>
              {allocatedPct !== null && <> · 任务预算占总预算 <b className="text-ink-600">{allocatedPct}%</b></>}
            </div>
            {bySub.length > 0 ? (
              <div className="space-y-1.5">
                {bySub.map(({ sub, total, cost }) => {
                  const pct = taskTotal ? Math.round((total / taskTotal) * 100) : 0
                  const costPct = total ? Math.min(100, Math.round((cost / total) * 100)) : 0
                  return (
                    <div key={sub.id} className="flex items-center gap-2">
                      <span className="text-xs text-ink-700 w-24 shrink-0 truncate" title={sub.name}>{sub.name}</span>
                      <div className="flex-1 h-1.5 rounded-full bg-ink-100 overflow-hidden relative" title={`预算 ${fmt(total)} · 花费 ${fmt(cost)}`}>
                        <div className="h-full bg-amber-200 rounded-full absolute inset-y-0 left-0" style={{ width: `${pct}%` }} />
                        <div className="h-full bg-rose-500 rounded-full absolute inset-y-0 left-0" style={{ width: `${Math.round(pct * costPct / 100)}%` }} />
                      </div>
                      <span className="text-[11px] text-ink-500 w-24 text-right shrink-0 tabular-nums">{fmt(total)}<span className="text-ink-300">/</span>{fmt(cost)}</span>
                    </div>
                  )
                })}
                <div className="text-[11px] text-ink-400 pt-1">任务预算由项目负责人及以上在 WBS 维护；实际花费由任务负责人在 WBS 录入</div>
              </div>
            ) : (
              <div className="text-xs text-ink-400">任务暂无预算明细</div>
            )}
          </div>
        </div>
      </CardBody>
    </Card>
  )
}
