// 人员负荷全景图（FR-SW-001 / FR-SW-002 / FR-SW-003）
// 8 周热力图（负荷率 = 已分配工时 / 可用工时）+ 未来 4 周过载预警 + 推荐负责人（可直接改派真实任务）。

import { useState, useMemo } from 'react'
import { Users, Sparkles, AlertTriangle, ListChecks, X, Filter, RefreshCw, Eye, UserCog, Gauge } from 'lucide-react'
import { addDays, format, parseISO } from 'date-fns'
import { Card, CardHeader, CardBody, Button, Tag, Avatar } from '../components/ui'
import { computeUserHeatmaps, findOverloadAlerts, getUserWeekTasks, type WeekCell } from '../lib/workload'
import { specialtyGroups } from '../mock/dictionaries'
import { findSubProject, findProject, findTask, TODAY } from '../mock'
import { TaskDrawer } from '../components/task/TaskDrawer'
import { RecommendModal } from '../components/workload/RecommendModal'
import type { SpecialtyGroup, Task, User } from '../types'
import { useAuth } from '../store/auth'
import { useDataStore } from '../store/data'
import { isTaskDone } from '../lib/schedule'
import { getScope, scopeLabel } from '../lib/scope'
import { cn } from '../lib/cn'

type Filters = {
  group: SpecialtyGroup | 'all'
  weeks: 4 | 8 | 12
  hideEmpty: boolean
}

export default function Workload() {
  const user = useAuth((s) => s.currentUser)
  // 订阅数据版本：改派 / 进展录入后热力图随之重算
  const version = useDataStore((s) => s.version)
  const scope = useMemo(() => getScope(user), [user])
  const scopedUserIds = scope.isAll ? undefined : scope.userIds

  const [filters, setFilters] = useState<Filters>({ group: 'all', weeks: 8, hideEmpty: false })
  // 推荐弹窗：taskId 为空表示「仅试算」；key 用于每次打开都重置弹窗内状态
  const [recommend, setRecommend] = useState<{ key: number; taskId?: string } | null>(null)
  const [drillCell, setDrillCell] = useState<{ user: User; cell: WeekCell } | null>(null)
  const [drawerTaskId, setDrawerTaskId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const heatmaps = useMemo(
    () => computeUserHeatmaps({ weeks: filters.weeks, userIds: scopedUserIds }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filters.weeks, scopedUserIds, version]
  )
  const filtered = useMemo(() => {
    let r = heatmaps
    if (filters.group !== 'all') r = r.filter((h) => h.user.specialtyGroup === filters.group)
    if (filters.hideEmpty) r = r.filter((h) => h.peakRate > 0)
    return r
  }, [heatmaps, filters])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const overloadAlerts = useMemo(() => findOverloadAlerts(4, scopedUserIds), [scopedUserIds, version])

  // 「调整任务」：打开该成员第一个过载周的任务清单（单独计算，不受热力图时间范围筛选影响）
  const openOverloadWeek = (u: User, weekKey: string) => {
    const cell = computeUserHeatmaps({ weeks: 6, userIds: new Set([u.id]) })[0]?.cells.find((c) => c.weekKey === weekKey)
    if (cell) setDrillCell({ user: u, cell })
  }
  const openRecommend = (taskId?: string) => setRecommend({ key: Date.now(), taskId })

  // 横向时间轴（取第一行的 cells 作为参考）
  const weekHeaders = filtered[0]?.cells || heatmaps[0]?.cells || []

  // 统计
  const totalHigh = filtered.filter((h) => h.hasOverload).length
  const totalUsers = filtered.length
  const avgRate = filtered.length > 0 ? Math.round(filtered.reduce((s, h) => s + h.avgRate, 0) / filtered.length) : 0

  return (
    <div className="p-6 max-w-[1600px] mx-auto">
      <div className="mb-4 flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-ink-900 flex items-center gap-2">
            <Gauge className="w-6 h-6 text-brand-600" />
            人员负荷全景图
          </h1>
          <p className="text-sm text-ink-500 mt-1">
            按周统计每位成员负荷率（已分配工时 / 可用工时）· 颜色编码：
            <span className="inline-flex items-center gap-1 mx-1"><span className="w-2 h-2 rounded-full bg-emerald-500" />≤70% 正常</span>
            <span className="inline-flex items-center gap-1 mx-1"><span className="w-2 h-2 rounded-full bg-amber-500" />70-90% 接近</span>
            <span className="inline-flex items-center gap-1 mx-1"><span className="w-2 h-2 rounded-full bg-red-500" />&gt;90% 过载</span>
          </p>
        </div>
        <Button variant="primary" icon={<Sparkles className="w-4 h-4" />} onClick={() => openRecommend()}>
          推荐负责人
        </Button>
      </div>

      {/* 范围提示条：项目负责人/执行者只看本人项目内的人员 */}
      {!scope.isAll && (
        <div className="mb-4 px-3 py-2 rounded-md bg-amber-50 border border-amber-200 text-amber-800 text-xs flex items-center gap-2">
          <Eye className="w-3.5 h-3.5" />
          数据范围：<span className="font-medium">{scopeLabel(scope)}</span>
          <span className="text-amber-600">（按 IAM 角色自动过滤涉及成员）</span>
        </div>
      )}

      {notice && (
        <div role="status" className="mb-4 px-3 py-2 rounded-md bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs flex items-center gap-2">
          <span className="flex-1">{notice}</span>
          <button onClick={() => setNotice(null)} aria-label="关闭提示" className="p-0.5 rounded hover:bg-black/5"><X className="w-3.5 h-3.5" /></button>
        </div>
      )}

      {/* 概览 KPI */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <Kpi label="可见人数" value={totalUsers} icon={<Users className="w-5 h-5" />} tone="blue" />
        <Kpi label="平均负荷率" value={`${avgRate}%`} icon={<ListChecks className="w-5 h-5" />} tone={avgRate > 80 ? 'amber' : 'green'} />
        <Kpi label="存在过载" value={totalHigh} icon={<AlertTriangle className="w-5 h-5" />} tone={totalHigh > 0 ? 'red' : 'gray'} />
        <Kpi label="未来 4 周过载预警" value={overloadAlerts.length} icon={<AlertTriangle className="w-5 h-5" />} tone={overloadAlerts.length > 0 ? 'amber' : 'gray'} />
      </div>

      {/* 过载预警面板 */}
      {overloadAlerts.length > 0 && (
        <Card className="mb-4 border-red-200">
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-red-500" />
                过载预警（FR-SW-003）
              </span>
            }
            subtitle={`未来 4 周内有 ${overloadAlerts.length} 位成员负荷率超过 90%，建议立即调配`}
          />
          <CardBody className="p-0">
            <ul className="divide-y divide-ink-300/40">
              {overloadAlerts.map((a) => (
                <li key={a.user.id} className="px-4 py-2.5 flex items-center gap-3">
                  <Avatar user={a.user} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm text-ink-900">{a.user.displayName}</span>
                      {a.user.specialtyGroup && <Tag tone="gray">{a.user.specialtyGroup}</Tag>}
                      <Tag tone="red">峰值 {a.peakRate}%</Tag>
                    </div>
                    <div className="text-[11px] text-ink-500 mt-0.5">
                      过载周：{a.weeks.map((w) => `${w.weekLabel}（${w.rate}%）`).join('、')}
                    </div>
                  </div>
                  <Button variant="secondary" size="sm" onClick={() => openOverloadWeek(a.user, a.weeks[0].weekKey)}>
                    调整任务
                  </Button>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}

      {/* 筛选条 */}
      <Card className="mb-3">
        <CardBody className="p-3 flex flex-wrap items-center gap-3">
          <div className="text-xs text-ink-700 inline-flex items-center gap-1.5"><Filter className="w-3.5 h-3.5" />筛选</div>
          <Sel
            label="专业组"
            value={filters.group}
            onChange={(v) => setFilters({ ...filters, group: v as SpecialtyGroup | 'all' })}
            opts={[
              { v: 'all', l: '全部' },
              ...specialtyGroups.map((g) => ({ v: g, l: g })),
            ]}
          />
          <Sel
            label="时间范围"
            value={String(filters.weeks)}
            onChange={(v) => setFilters({ ...filters, weeks: parseInt(v) as 4 | 8 | 12 })}
            opts={[
              { v: '4', l: '近 4 周' },
              { v: '8', l: '近 8 周' },
              { v: '12', l: '近 12 周' },
            ]}
          />
          <label className="text-xs inline-flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={filters.hideEmpty}
              onChange={(e) => setFilters({ ...filters, hideEmpty: e.target.checked })}
              className="accent-brand-600"
            />
            隐藏全期 0% 的成员
          </label>
          <button
            onClick={() => setFilters({ group: 'all', weeks: 8, hideEmpty: false })}
            className="ml-auto inline-flex items-center gap-1 text-xs text-ink-700 hover:text-ink-900 px-2 py-1 rounded hover:bg-ink-100"
          >
            <RefreshCw className="w-3 h-3" /> 重置
          </button>
        </CardBody>
      </Card>

      {/* 热力图 */}
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-ink-100 text-xs uppercase tracking-wider text-ink-700">
                <th className="text-left px-3 py-2 sticky left-0 bg-ink-100 z-10 min-w-[180px]">成员</th>
                <th className="px-3 py-2 text-center w-24">专业组</th>
                <th className="px-3 py-2 text-right w-20">平均</th>
                <th className="px-3 py-2 text-right w-20">峰值</th>
                {weekHeaders.map((c) => {
                  const today = format(TODAY, 'yyyy-MM-dd')
                  const isCurrent = today >= c.weekKey && today < format(addDays(c.weekStart, 7), 'yyyy-MM-dd')
                  return (
                    <th
                      key={c.weekKey}
                      className={cn(
                        'px-1 py-2 text-center font-normal min-w-[60px]',
                        isCurrent && 'bg-brand-50 text-brand-700 font-medium'
                      )}
                    >
                      {c.weekLabel}
                      {isCurrent && <div className="text-[9px] mt-0.5">本周</div>}
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {filtered.map((h) => (
                <tr key={h.user.id} className="border-t border-ink-300/40 hover:bg-ink-100/40">
                  <td className="px-3 py-2 sticky left-0 bg-white z-10">
                    <div className="flex items-center gap-2">
                      <Avatar user={h.user} size="sm" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-ink-900 truncate">{h.user.displayName}</div>
                        <div className="text-[10px] text-ink-500">{h.user.weeklyAvailableHours}h/周</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-center">
                    {h.user.specialtyGroup && <Tag tone="gray">{h.user.specialtyGroup}</Tag>}
                  </td>
                  <td className={cn(
                    'px-3 py-2 text-right font-mono text-sm',
                    h.avgRate > 90 ? 'text-red-600' : h.avgRate > 70 ? 'text-amber-600' : 'text-emerald-600'
                  )}>{h.avgRate}%</td>
                  <td className={cn(
                    'px-3 py-2 text-right font-mono text-sm',
                    h.peakRate > 90 ? 'text-red-600 font-medium' : h.peakRate > 70 ? 'text-amber-600' : 'text-ink-700'
                  )}>{h.peakRate}%</td>
                  {h.cells.map((c) => (
                    <td key={c.weekKey} className="p-0.5 align-middle">
                      <button
                        onClick={() => setDrillCell({ user: h.user, cell: c })}
                        className={cn(
                          'w-full h-9 rounded border text-[10px] font-mono transition-all',
                          c.level === 'high'
                            ? 'bg-red-500 border-red-700 text-white hover:bg-red-600'
                            : c.level === 'mid'
                            ? 'bg-amber-400 border-amber-600 text-amber-900 hover:bg-amber-500'
                            : c.rate > 0
                            ? 'bg-emerald-400/70 border-emerald-600 text-emerald-900 hover:bg-emerald-400'
                            : 'bg-ink-100 border-ink-300 text-ink-500 hover:bg-ink-100/80'
                        )}
                        title={`${h.user.displayName} · ${c.weekLabel} · ${c.allocatedHours}/${c.availableHours}h`}
                      >
                        {c.rate > 0 ? `${c.rate}%` : '—'}
                      </button>
                    </td>
                  ))}
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={4 + weekHeaders.length} className="text-center py-12 text-sm text-ink-500">
                    没有符合条件的成员
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Drill 弹窗：单元格详情 */}
      {drillCell && (
        <DrillModal
          user={drillCell.user}
          cell={drillCell.cell}
          version={version}
          onClose={() => setDrillCell(null)}
          onOpenTask={(id) => { setDrawerTaskId(id); setDrillCell(null) }}
          onRecommend={(id) => { openRecommend(id); setDrillCell(null) }}
        />
      )}

      {/* 推荐负责人：指定任务时可直接改派 */}
      {recommend && (
        <RecommendModal
          key={recommend.key}
          initialTaskId={recommend.taskId}
          onClose={() => setRecommend(null)}
          onAssigned={(message) => { setNotice(message); setRecommend(null) }}
        />
      )}

      {/* 任务详情抽屉 */}
      <TaskDrawer task={drawerTaskId ? findTask(drawerTaskId) || null : null} onClose={() => setDrawerTaskId(null)} />
    </div>
  )
}

function DrillModal({ user, cell, version, onClose, onOpenTask, onRecommend }: {
  user: User
  cell: WeekCell
  version: number
  onClose: () => void
  onOpenTask: (id: string) => void
  onRecommend: (id: string) => void
}) {
  const tasks: Task[] = useMemo(
    () => getUserWeekTasks(user.id, cell.weekStart),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [user.id, cell.weekStart, version]
  )

  return (
    <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative ml-auto w-full max-w-md bg-white shadow-2xl flex flex-col">
        <div className="px-5 py-4 border-b border-ink-300/40 flex items-center gap-3">
          <Avatar user={user} size="lg" />
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-semibold">{user.displayName}</h2>
            <div className="text-xs text-ink-500 mt-0.5">
              {cell.weekLabel} 起的一周 · {cell.allocatedHours}/{cell.availableHours}h ·
              <span className={cn(
                'ml-1 font-medium',
                cell.level === 'high' ? 'text-red-600' : cell.level === 'mid' ? 'text-amber-600' : 'text-emerald-600'
              )}>
                {cell.rate}%
              </span>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-md hover:bg-ink-100 text-ink-500">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="px-5 py-3 border-b border-ink-300/40 text-sm font-medium text-ink-900">
            该周任务（{tasks.length}）<span className="ml-2 text-xs font-normal text-ink-500">点任务录入进展；「推荐改派」为其换负责人</span>
          </div>
          {tasks.length === 0 ? (
            <div className="p-8 text-center text-sm text-ink-500">该周无分配任务</div>
          ) : (
            <ul className="divide-y divide-ink-300/40">
              {tasks.map((t) => {
                const sub = findSubProject(t.subProjectId)
                const project = sub ? findProject(sub.projectId) : null
                return (
                  <li
                    key={t.id}
                    onClick={() => onOpenTask(t.id)}
                    className="px-5 py-3 hover:bg-ink-100/40 cursor-pointer"
                  >
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className="font-mono text-[10px] text-ink-500">{t.code}</span>
                      <Tag tone="gray">{sub?.module}</Tag>
                      <span className="ml-auto text-[10px] font-mono">{t.estimatedEffort}d</span>
                    </div>
                    <div className="text-sm font-medium text-ink-900">{t.name}</div>
                    <div className="text-[11px] text-ink-500 mt-0.5 flex items-center gap-2">
                      <span className="flex-1">{project?.code} · {format(parseISO(t.plannedStart), 'MM-dd')} → {format(parseISO(t.plannedEnd), 'MM-dd')}</span>
                      {!isTaskDone(t) && (
                        <button
                          onClick={(e) => { e.stopPropagation(); onRecommend(t.id) }}
                          className="inline-flex items-center gap-1 text-brand-600 hover:underline"
                        >
                          <UserCog className="w-3 h-3" /> 推荐改派
                        </button>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

function Kpi({ label, value, icon, tone }: { label: string; value: string | number; icon: React.ReactNode; tone: 'blue' | 'amber' | 'red' | 'green' | 'gray' }) {
  const map = {
    blue: { bg: 'bg-brand-50', icon: 'bg-brand-100 text-brand-600', text: 'text-brand-700' },
    amber: { bg: 'bg-amber-50', icon: 'bg-amber-100 text-amber-600', text: 'text-amber-700' },
    red: { bg: 'bg-red-50', icon: 'bg-red-100 text-red-600', text: 'text-red-700' },
    green: { bg: 'bg-emerald-50', icon: 'bg-emerald-100 text-emerald-600', text: 'text-emerald-700' },
    gray: { bg: 'bg-ink-100', icon: 'bg-white text-ink-700', text: 'text-ink-700' },
  }[tone]
  return (
    <div className={cn('card p-4 flex items-center gap-3', map.bg)}>
      <div className={cn('w-10 h-10 rounded-lg flex items-center justify-center', map.icon)}>{icon}</div>
      <div>
        <div className={cn('text-2xl font-semibold leading-none', map.text)}>{value}</div>
        <div className="text-xs text-ink-700 mt-1">{label}</div>
      </div>
    </div>
  )
}

function Sel({ label, value, onChange, opts }: { label: string; value: string; onChange: (v: string) => void; opts: { v: string; l: string }[] }) {
  return (
    <label className="inline-flex items-center gap-1.5 text-xs rounded-md px-2 py-1 border border-ink-300 bg-white">
      <span className="text-ink-500">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="bg-transparent text-ink-900 focus:outline-none cursor-pointer">
        {opts.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
      </select>
    </label>
  )
}
