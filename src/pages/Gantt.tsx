// 全局甘特图：多项目联合视图（FR-PJ-002 / FR-PJ-003）
// 单项目模式：选定一个项目，复用 <Gantt> 组件（点击任务条打开任务抽屉，可直接录入进展）
// 多项目模式：所有活跃项目堆叠展示（紧凑视图，跨项目时间轴）
// 管理者看组合全景；执行者（rd / production / qa_qc）固定单项目视图，只见自己参与的项目。

import { useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import {
  GanttChartSquare, Flame, Diamond, Layers, FolderKanban, ExternalLink, Eye,
} from 'lucide-react'
import { addDays, differenceInCalendarDays, format, isWeekend, parseISO, startOfMonth } from 'date-fns'
import { Card, CardHeader, CardBody, Tag, HealthTag, Avatar } from '../components/ui'
import { Gantt } from '../components/project/Gantt'
import { TaskDrawer } from '../components/task/TaskDrawer'
import { useAuth } from '../store/auth'
import { useDataStore } from '../store/data'
import { getScope, filterProjects, scopeLabel } from '../lib/scope'
import {
  projects as allProjects, getProjectSubs, getSubTasks, getProjectTasks, findUser, findTask, taskDependencies, TODAY,
} from '../mock'
import { computeCPM } from '../lib/cpm'
import type { Project, Task } from '../types'
import { cn } from '../lib/cn'

type Mode = 'single' | 'multi'

export default function GanttPage() {
  const user = useAuth((s) => s.currentUser)
  // 订阅数据版本：任务在抽屉里保存后，甘特条随之刷新
  const version = useDataStore((s) => s.version)
  const userScope = useMemo(() => getScope(user), [user])
  const isOwnTaskOnly = userScope.isOwnTaskOnly

  // 可见项目集合：admin/cmc_lead 全部活跃；其他角色按可见范围
  const activeProjects = useMemo(
    () => filterProjects(allProjects, userScope).filter((p) => p.status === '活跃'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [userScope, version]
  )

  // 执行者强制单项目（看本人参与），其他角色可切换
  const [mode, setMode] = useState<Mode>(isOwnTaskOnly ? 'single' : 'multi')
  const [singleId, setSingleId] = useState<string>('')
  const [openTaskId, setOpenTaskId] = useState<string | null>(null)
  // 所选项目不可见 / 已删除时回落到第一个
  const single = activeProjects.find((p) => p.id === singleId) ?? activeProjects[0]

  return (
    <div className="p-6 max-w-[1600px] mx-auto">
      <div className="mb-4 flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-ink-900 flex items-center gap-2">
            <GanttChartSquare className="w-6 h-6 text-brand-600" />
            甘特图
          </h1>
          <p className="text-sm text-ink-500 mt-1">
            任务排期可视化与关键路径（FR-PJ-002 / FR-PJ-003）·
            {mode === 'multi' ? '多项目联合视图，便于跨项目对比时间' : '单项目详细视图（与项目详情页同款）'}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {!isOwnTaskOnly && (
            <div className="inline-flex rounded-md border border-ink-300 bg-white p-0.5">
              <button
                onClick={() => setMode('multi')}
                className={cn(
                  'inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs transition-colors',
                  mode === 'multi' ? 'bg-brand-50 text-brand-700 font-medium' : 'text-ink-700 hover:bg-ink-100'
                )}
              >
                <Layers className="w-3.5 h-3.5" />
                多项目视图
              </button>
              <button
                onClick={() => setMode('single')}
                className={cn(
                  'inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs transition-colors',
                  mode === 'single' ? 'bg-brand-50 text-brand-700 font-medium' : 'text-ink-700 hover:bg-ink-100'
                )}
              >
                <FolderKanban className="w-3.5 h-3.5" />
                单项目视图
              </button>
            </div>
          )}

          {mode === 'single' && (
            <select
              value={single?.id ?? ''}
              onChange={(e) => setSingleId(e.target.value)}
              className="input"
            >
              {activeProjects.map((p) => <option key={p.id} value={p.id}>{p.code} - {p.name}</option>)}
            </select>
          )}
        </div>
      </div>

      {/* 范围提示条 */}
      {!userScope.isAll && (
        <div className="mb-3 px-3 py-2 rounded-md bg-amber-50 border border-amber-200 text-amber-800 text-xs flex items-center gap-2">
          <Eye className="w-3.5 h-3.5" />
          数据范围：<span className="font-medium">{scopeLabel(userScope)}</span>
          <span className="text-amber-600">（按 IAM 角色自动过滤可见项目）</span>
        </div>
      )}

      {activeProjects.length === 0 ? (
        <Card>
          <CardBody className="p-12 text-center">
            <GanttChartSquare className="w-10 h-10 mx-auto text-ink-300 mb-3" />
            <div className="text-sm text-ink-700 font-medium">没有可见的项目</div>
            <div className="text-xs text-ink-500 mt-1">
              当前角色 {user?.displayName} 暂无任何参与/负责的活跃项目
            </div>
          </CardBody>
        </Card>
      ) : mode === 'single' && single ? (
        <div className="space-y-3">
          <Gantt project={single} selectedTaskId={openTaskId ?? undefined} onSelectTask={setOpenTaskId} />
          <Link
            to={`/projects/${single.id}`}
            className="inline-flex items-center gap-1.5 text-xs text-brand-600 hover:underline"
          >
            进入项目详情 <ExternalLink className="w-3 h-3" />
          </Link>
        </div>
      ) : (
        <MultiProjectGantt projects={activeProjects} version={version} />
      )}

      <TaskDrawer task={openTaskId ? findTask(openTaskId) || null : null} onClose={() => setOpenTaskId(null)} />
    </div>
  )
}

// ====== 多项目联合甘特图 ======

const DAY_WIDTH = 8
const ROW_H = 22
const HEADER_H = 48
const LABEL_W = 280
const PROJECT_HEADER_H = 32

function MultiProjectGantt({ projects, version }: { projects: Project[]; version: number }) {
  // 全局时间范围
  const range = useMemo(() => {
    const allTasks = projects.flatMap((p) => getProjectTasks(p.id))
    if (allTasks.length === 0) return { start: TODAY, end: addDays(TODAY, 60), totalDays: 60 }
    const starts = allTasks.map((t) => parseISO(t.plannedStart).getTime())
    const ends = allTasks.map((t) => parseISO(t.plannedEnd).getTime())
    const start = addDays(new Date(Math.min(...starts)), -7)
    const end = addDays(new Date(Math.max(...ends)), 7)
    return { start, end, totalDays: differenceInCalendarDays(end, start) + 1 }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, version])

  // 行结构：项目头 + 每个 sub 的所有 task
  type Row = { type: 'project'; project: Project } | { type: 'task'; task: Task; project: Project }
  const rows = useMemo(() => {
    const r: Row[] = []
    projects.forEach((p) => {
      r.push({ type: 'project', project: p })
      const subs = getProjectSubs(p.id).sort((a, b) => a.sortOrder - b.sortOrder)
      subs.forEach((s) => {
        getSubTasks(s.id).forEach((t) => {
          r.push({ type: 'task', task: t, project: p })
        })
      })
    })
    return r
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, version])

  // 各项目的 CPM
  const cpmByProject = useMemo(() => {
    const map = new Map<string, ReturnType<typeof computeCPM>>()
    projects.forEach((p) => {
      const ts = getProjectTasks(p.id)
      map.set(p.id, computeCPM(ts, taskDependencies))
    })
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, version])

  const totalWidth = range.totalDays * DAY_WIDTH
  const todayX = differenceInCalendarDays(TODAY, range.start) * DAY_WIDTH
  const xOf = (d: Date | string) => {
    const dd = typeof d === 'string' ? parseISO(d) : d
    return differenceInCalendarDays(dd, range.start) * DAY_WIDTH
  }

  // 月份带
  const months = useMemo(() => {
    const m: { label: string; x: number }[] = []
    let cur = startOfMonth(range.start)
    while (cur <= range.end) {
      m.push({ label: format(cur, 'yyyy-MM'), x: differenceInCalendarDays(cur, range.start) * DAY_WIDTH })
      cur = startOfMonth(addDays(cur, 32))
    }
    return m
  }, [range.start, range.end])

  // 计算每行 y 偏移（项目头比 task 高一些）
  let yCursor = 0
  const rowYs: number[] = rows.map((r) => {
    const start = yCursor
    yCursor += r.type === 'project' ? PROJECT_HEADER_H : ROW_H
    return start
  })
  const totalH = yCursor

  // 总览 KPI
  const totalTasks = rows.filter((r) => r.type === 'task').length
  const totalCritical = Array.from(cpmByProject.values()).reduce((s, c) => s + c.criticalPathIds.size, 0)
  const totalMs = rows.filter((r) => r.type === 'task' && r.task.isMilestone).length

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <Layers className="w-4 h-4 text-brand-600" />
            多项目联合甘特图
            <Tag tone="blue">{projects.length} 项目</Tag>
            <Tag tone="gray">{totalTasks} 任务</Tag>
            <Tag tone="red" className="gap-1"><Flame className="w-3 h-3" />关键路径 {totalCritical}</Tag>
            <Tag tone="yellow" className="gap-1"><Diamond className="w-3 h-3" />里程碑 {totalMs}</Tag>
          </span>
        }
        subtitle={`${format(range.start, 'yyyy-MM-dd')} ~ ${format(range.end, 'yyyy-MM-dd')} · 共 ${range.totalDays} 天`}
      />
      <CardBody className="p-0">
        <div className="flex border-t border-ink-300/40">
          {/* 左：项目 / 任务标签列 */}
          <div className="shrink-0 border-r border-ink-300/40 bg-white" style={{ width: LABEL_W }}>
            <div className="bg-ink-100 sticky top-0 z-10 px-3 flex items-center text-xs font-medium" style={{ height: HEADER_H }}>
              项目 / 任务
            </div>
            <div style={{ height: totalH, position: 'relative' }}>
              {rows.map((r, i) => {
                const top = rowYs[i]
                if (r.type === 'project') {
                  return (
                    <div
                      key={`p-${r.project.id}`}
                      className="absolute left-0 right-0 px-3 flex items-center gap-2 bg-brand-50/60 border-b border-brand-200"
                      style={{ top, height: PROJECT_HEADER_H }}
                    >
                      <Link
                        to={`/projects/${r.project.id}`}
                        className="flex items-center gap-2 truncate hover:text-brand-700"
                      >
                        <span className="font-mono text-[10px] text-ink-500">{r.project.code}</span>
                        <HealthTag health={r.project.health} />
                        <span className="text-sm font-medium truncate">{r.project.name}</span>
                      </Link>
                    </div>
                  )
                }
                const owner = findUser(r.task.ownerId)
                const isCritical = cpmByProject.get(r.project.id)?.criticalPathIds.has(r.task.id) || false
                return (
                  <div
                    key={r.task.id}
                    className="absolute left-0 right-0 pl-6 pr-3 flex items-center gap-1.5 border-b border-ink-300/30 text-xs"
                    style={{ top, height: ROW_H }}
                  >
                    {r.task.isMilestone && <Diamond className="w-3 h-3 text-amber-600 shrink-0" />}
                    {isCritical && <Flame className="w-3 h-3 text-red-500 shrink-0" />}
                    <span className="font-mono text-[10px] text-ink-500 shrink-0">{r.task.code}</span>
                    <span className={cn('truncate flex-1', r.task.isMilestone && 'font-semibold')}>{r.task.name}</span>
                    {owner && <Avatar user={owner} size="sm" />}
                  </div>
                )
              })}
            </div>
          </div>

          {/* 右：时间轴 + 条形 */}
          <div className="flex-1 overflow-x-auto relative">
            <div style={{ width: totalWidth, position: 'relative' }}>
              {/* 头部 */}
              <div className="bg-ink-100 sticky top-0 z-10 border-b border-ink-300/40" style={{ height: HEADER_H }}>
                <div className="absolute inset-x-0 top-0 h-6">
                  {months.map((m) => (
                    <div
                      key={m.label}
                      className="absolute top-0 h-full text-xs flex items-center px-1.5 text-ink-700 font-medium border-r border-ink-300/60 bg-ink-100"
                      style={{ left: m.x }}
                    >
                      {m.label}
                    </div>
                  ))}
                </div>
                <div className="absolute inset-x-0 bottom-0 h-6 border-t border-ink-300/40">
                  {Array.from({ length: range.totalDays }).map((_, i) => {
                    const d = addDays(range.start, i)
                    const x = i * DAY_WIDTH
                    if (d.getDate() !== 1 && d.getDay() !== 1) return null
                    return (
                      <div
                        key={i}
                        className="absolute top-0 h-full text-[9px] text-ink-500 px-0.5 leading-none pt-1.5 border-l border-ink-300/40"
                        style={{ left: x }}
                      >
                        {d.getDate() === 1 ? format(d, 'M月') : format(d, 'd')}
                      </div>
                    )
                  })}
                </div>
              </div>

              {/* 主体 */}
              <div className="relative" style={{ height: totalH }}>
                {/* 周末背景 */}
                {Array.from({ length: range.totalDays }).map((_, i) => {
                  const d = addDays(range.start, i)
                  if (!isWeekend(d)) return null
                  return (
                    <div
                      key={i}
                      className="absolute top-0 bottom-0 bg-amber-50/30"
                      style={{ left: i * DAY_WIDTH, width: DAY_WIDTH }}
                    />
                  )
                })}

                {/* 月份分隔线 */}
                {months.map((m) => (
                  <div
                    key={m.label}
                    className="absolute top-0 bottom-0 border-l border-ink-300/30"
                    style={{ left: m.x }}
                  />
                ))}

                {/* 今日竖线 */}
                {todayX >= 0 && todayX <= totalWidth && (
                  <div
                    className="absolute top-0 bottom-0 w-px bg-red-500/70 z-10"
                    style={{ left: todayX }}
                  />
                )}

                {/* 项目分隔色块 + 任务条 */}
                {rows.map((r, i) => {
                  const top = rowYs[i]
                  if (r.type === 'project') {
                    return (
                      <div
                        key={`pb-${r.project.id}`}
                        className="absolute left-0 right-0 bg-brand-50/40 border-b border-brand-200"
                        style={{ top, height: PROJECT_HEADER_H }}
                      />
                    )
                  }
                  const t = r.task
                  const left = xOf(t.plannedStart)
                  const w = Math.max(t.isMilestone ? 14 : 4, differenceInCalendarDays(parseISO(t.plannedEnd), parseISO(t.plannedStart)) * DAY_WIDTH)
                  const barTop = top + (ROW_H - 12) / 2
                  const isCritical = cpmByProject.get(r.project.id)?.criticalPathIds.has(t.id) || false
                  if (t.isMilestone) {
                    return (
                      <div
                        key={t.id}
                        className="absolute z-10"
                        style={{ left: left - 6, top: top + 5, width: 12, height: 12 }}
                        title={`${t.name} · ${t.plannedEnd}`}
                      >
                        <div className={cn(
                          'w-full h-full rotate-45 border-2',
                          isCritical ? 'bg-red-500 border-red-700' : 'bg-amber-500 border-amber-700'
                        )} />
                      </div>
                    )
                  }
                  return (
                    <div
                      key={t.id}
                      className={cn(
                        'absolute rounded h-3 border z-10',
                        isCritical
                          ? 'bg-red-500 border-red-700'
                          : t.status === '已完成' || t.status === '已验证'
                          ? 'bg-emerald-500 border-emerald-700'
                          : t.status === '延迟' || t.status === '阻塞'
                          ? 'bg-amber-500 border-amber-700'
                          : 'bg-brand-500 border-brand-700'
                      )}
                      style={{ left, top: barTop, width: w }}
                      title={`${t.name}\n${t.plannedStart} ~ ${t.plannedEnd}\n${t.estimatedEffort} 人天`}
                    >
                      <div
                        className="h-full bg-white/30"
                        style={{ width: `${t.progress}%` }}
                      />
                    </div>
                  )
                })}

                {/* 行分隔 */}
                {rows.map((_, i) => (
                  <div
                    key={`sep-${i}`}
                    className="absolute left-0 right-0 border-b border-ink-300/30"
                    style={{ top: rowYs[i] + (rows[i].type === 'project' ? PROJECT_HEADER_H : ROW_H) }}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* 图例 */}
        <div className="px-4 py-2 border-t border-ink-300/40 text-[11px] text-ink-700 flex items-center gap-4 flex-wrap">
          <span className="flex items-center gap-1.5"><span className="w-3 h-2 rounded bg-brand-500" />进行中</span>
          <span className="flex items-center gap-1.5"><span className="w-3 h-2 rounded bg-emerald-500" />已完成</span>
          <span className="flex items-center gap-1.5"><span className="w-3 h-2 rounded bg-amber-500" />延迟/阻塞</span>
          <span className="flex items-center gap-1.5"><span className="w-3 h-2 rounded bg-red-500" /><Flame className="w-3 h-3 text-red-500" />关键路径</span>
          <span className="flex items-center gap-1.5"><Diamond className="w-3 h-3 text-amber-600" />里程碑</span>
          <span className="flex items-center gap-1.5"><span className="w-px h-3 bg-red-500" />今日</span>
          <span className="ml-auto text-ink-500">点击左侧项目名跳转项目详情 · 切换「单项目视图」可看完整依赖连线</span>
        </div>
      </CardBody>
    </Card>
  )
}

