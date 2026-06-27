// 项目预算与成本卡 —— 项目详情「概览」用。
//
// 两个视角并列：
//   · 项目预算（自上而下）：ProjectFinance 的总预算 / 已花费 / 已承诺 / 执行率 / 成本结构。
//   · WBS 任务预算（自下而上）：各任务 costBudget 之和，并按子项目分解 —— 这就是
//     「模板里的预算」实例化到项目后的去向（DMP 模板 costBudget → 任务 costBudget）。
// 订阅数据版本：在 WBS 行内改预算后即时刷新。

import { useMemo } from 'react'
import { Wallet, Coins, AlertTriangle } from 'lucide-react'
import type { Project } from '../../types'
import { Card, CardHeader, CardBody, Tag } from '../ui'
import {
  getProjectFinance, executionRate, isOverBudget,
  getProjectSubs, getSubTasks, getProjectTasks,
} from '../../mock'
import { useDataStore } from '../../store/data'

const fmt = (v: number) => `¥${Math.round(v).toLocaleString('zh-CN')}万`

const CATS = ['人力', '设备', '原材料', '外部服务', '其他'] as const

export function ProjectBudgetCard({ project }: { project: Project }) {
  // 订阅版本：WBS 改预算后重新汇总
  const version = useDataStore((s) => s.version)

  const finance = getProjectFinance(project.id)

  // 自下而上：任务预算合计 + 按子项目分解
  const { taskTotal, bySub } = useMemo(() => {
    const subs = getProjectSubs(project.id).sort((a, b) => a.sortOrder - b.sortOrder)
    const bySub = subs
      .map((s) => ({
        sub: s,
        total: getSubTasks(s.id).reduce((a, t) => a + (t.costBudget ?? 0), 0),
      }))
      .filter((x) => x.total > 0)
    const taskTotal = getProjectTasks(project.id).reduce((a, t) => a + (t.costBudget ?? 0), 0)
    return { taskTotal, bySub }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, version])

  const over = finance ? isOverBudget(finance) : false
  const spentPct = finance && finance.totalBudget ? (finance.spent / finance.totalBudget) * 100 : 0
  const commitPct = finance && finance.totalBudget ? (finance.committed / finance.totalBudget) * 100 : 0
  const cats = finance
    ? CATS.map((c) => ({ cat: c, val: finance.breakdown[c] ?? 0 })).filter((x) => x.val > 0).sort((a, b) => b.val - a.val)
    : []

  return (
    <Card>
      <CardHeader
        title={<span className="flex items-center gap-2"><Wallet className="w-4 h-4 text-brand-600" />预算与成本</span>}
        subtitle="项目预算执行（自上而下）· WBS 任务预算明细（自下而上）"
        action={finance
          ? <Tag tone={over ? 'red' : 'green'}>{over ? '超支' : `执行 ${executionRate(finance)}%`}</Tag>
          : <Tag tone="gray">未设置项目预算</Tag>}
      />
      <CardBody>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* 1. 项目预算（自上而下） */}
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
                  <span className="flex items-center gap-1"><i className="w-2 h-2 rounded-sm bg-brand-600 inline-block" />已花费 {fmt(finance.spent)}</span>
                  <span className="flex items-center gap-1"><i className="w-2 h-2 rounded-sm bg-amber-400 inline-block" />已承诺 {fmt(finance.committed)}</span>
                  <span className="flex items-center gap-1"><i className="w-2 h-2 rounded-sm bg-emerald-400 inline-block" />剩余 {fmt(finance.totalBudget - finance.spent - finance.committed)}</span>
                </div>
                {over && (
                  <div className="mt-2 text-[11px] text-red-600 flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3" /> 已花费+已承诺超出总预算
                  </div>
                )}
              </>
            ) : (
              <div className="mt-2 text-xs text-ink-400 leading-relaxed">
                尚未设置项目级预算。<br />新建项目时会按模板预算估算并写入；示例项目的预算见首页「组合预算」。
              </div>
            )}
          </div>

          {/* 2. 成本结构 */}
          <div>
            <div className="text-xs text-ink-500 mb-2">成本结构（按类别）</div>
            {cats.length > 0 ? (
              <div className="space-y-1.5">
                {cats.map(({ cat, val }) => {
                  const pct = finance && finance.spent ? Math.round((val / finance.spent) * 100) : 0
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
              <div className="text-xs text-ink-400">—</div>
            )}
          </div>

          {/* 3. WBS 任务预算（自下而上） */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-ink-500 flex items-center gap-1"><Coins className="w-3.5 h-3.5 text-amber-500" />WBS 任务预算合计</span>
              <span className="text-sm font-semibold text-ink-900">{fmt(taskTotal)}</span>
            </div>
            {bySub.length > 0 ? (
              <div className="space-y-1.5">
                {bySub.map(({ sub, total }) => {
                  const pct = taskTotal ? Math.round((total / taskTotal) * 100) : 0
                  return (
                    <div key={sub.id} className="flex items-center gap-2">
                      <span className="text-xs text-ink-700 w-24 shrink-0 truncate" title={sub.name}>{sub.name}</span>
                      <div className="flex-1 h-1.5 rounded-full bg-ink-100 overflow-hidden">
                        <div className="h-full bg-amber-400 rounded-full" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-[11px] text-ink-500 w-16 text-right shrink-0">{fmt(total)}</span>
                    </div>
                  )
                })}
                <div className="text-[11px] text-ink-400 pt-1">源自各任务预算（模板 costBudget），可在 WBS 行内调整</div>
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
