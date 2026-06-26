// 模板预览（FR-TE-004）
// 模拟生成完整的甘特图视图，展示项目从假定的开始日期出发会形成的任务排期、关键路径、里程碑分布

import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Eye, Calendar, Diamond, Flame } from 'lucide-react'
import { addDays, differenceInCalendarDays, format, parseISO, startOfMonth, isWeekend } from 'date-fns'
import type { TemplateNode, Task, TaskDependency, DependencyType } from '../types'
import { Card, CardHeader, CardBody, Tag, EmptyState, Button } from '../components/ui'
import { computeCPM } from '../lib/cpm'
import { computeStats } from '../lib/template'
import { useTemplatesStore } from '../store/templates'
import { cn } from '../lib/cn'

const DAY_W = 14
const ROW_H = 32
const HEADER_H = 56
const LABEL_W = 320

export default function TemplatePreview() {
  const { id } = useParams<{ id: string }>()
  const templates = useTemplatesStore((s) => s.templates)
  const template = templates.find((t) => t.id === id)
  const version = template?.versions.find((v) => v.isCurrent)
  const [startDate, setStartDate] = useState(() => format(new Date(), 'yyyy-MM-dd'))

  // 把模板节点转成 Task / TaskDependency 模型，使用假定起始日期 + 模板默认 duration 计算
  const { tasks, deps, totalDays, projectStart } = useMemo(() => {
    if (!version) return { tasks: [] as Task[], deps: [] as TaskDependency[], totalDays: 0, projectStart: new Date() }
    return generateTasksFromTemplate(version.structureJson, startDate)
  }, [version, startDate])

  const cpm = useMemo(() => computeCPM(tasks, deps), [tasks, deps])

  if (!template || !version) {
    return (
      <div className="p-6">
        <EmptyState title="模板不存在" action={<Link to="/templates" className="text-brand-600 hover:underline">返回模板列表</Link>} />
      </div>
    )
  }

  const stats = computeStats(version.structureJson)

  // 渲染：sub 行 + task 行（同 Gantt 组件思路简化版）
  type Row = { type: 'sub'; sub: TemplateNode } | { type: 'task'; task: Task }
  const rows: Row[] = []
  version.structureJson.children?.forEach((sub) => {
    rows.push({ type: 'sub', sub })
    sub.children?.forEach((tNode) => {
      const task = tasks.find((t) => t.id === tNode.id)
      if (task) rows.push({ type: 'task', task })
    })
  })

  const totalWidth = totalDays * DAY_W
  const months = useMemo(() => {
    const m: { date: Date; label: string; x: number }[] = []
    let cur = startOfMonth(projectStart)
    const end = addDays(projectStart, totalDays)
    while (cur <= end) {
      const x = differenceInCalendarDays(cur, projectStart) * DAY_W
      m.push({ date: cur, label: format(cur, 'yyyy-MM'), x })
      cur = startOfMonth(addDays(cur, 32))
    }
    return m
  }, [projectStart, totalDays])

  const xOf = (d: Date) => differenceInCalendarDays(d, projectStart) * DAY_W

  return (
    <div className="p-6 max-w-[1600px] mx-auto">
      <Link to="/templates" className="inline-flex items-center gap-1 text-xs text-ink-500 hover:text-ink-900 mb-3">
        <ArrowLeft className="w-3 h-3" /> 返回模板列表
      </Link>

      <div className="mb-4 flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-ink-900 flex items-center gap-2">
            <Eye className="w-5 h-5 text-brand-600" />
            模板预览
            <Tag tone="blue">{template.name}</Tag>
            <Tag tone="gray">{version.versionNumber}</Tag>
          </h1>
          <p className="text-sm text-ink-500 mt-1">
            模拟项目排期 · 假定起始日期生成完整甘特图，便于验证模板调整的合理性（FR-TE-004）
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-ink-700 inline-flex items-center gap-2">
            <Calendar className="w-3.5 h-3.5" />
            假定开始日期
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="input"
            />
          </label>
          <Button variant="primary" onClick={() => window.location.assign(`/templates/${template.id}/edit`)}>继续编辑</Button>
        </div>
      </div>

      {/* 概览 */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
        <KpiBlock label="子项目" value={stats.subProjects} />
        <KpiBlock label="任务" value={stats.tasks} />
        <KpiBlock label="里程碑" value={stats.milestones} icon={<Diamond className="w-3.5 h-3.5" />} />
        <KpiBlock label="关键路径任务" value={cpm.criticalPathIds.size} icon={<Flame className="w-3.5 h-3.5" />} />
        <KpiBlock label="项目总跨度" value={`${totalDays} 天`} />
      </div>

      <Card className="overflow-hidden">
        <CardHeader title="模拟甘特图" subtitle={`${format(projectStart, 'yyyy-MM-dd')} → ${format(addDays(projectStart, totalDays), 'yyyy-MM-dd')}`} />
        <CardBody className="p-0">
          {tasks.length === 0 ? (
            <EmptyState title="模板为空" description="请先在编辑器中添加任务" />
          ) : (
            <div className="flex border-t border-ink-300/40">
              {/* 任务列 */}
              <div className="shrink-0 border-r border-ink-300/40 bg-white" style={{ width: LABEL_W }}>
                <div className="bg-ink-100 sticky top-0 z-10 px-3 flex items-center text-xs font-medium" style={{ height: HEADER_H }}>
                  任务（{tasks.length}）
                </div>
                {rows.map((r, i) => (
                  <div
                    key={i}
                    className={cn(
                      'flex items-center px-3 border-b border-ink-300/40 text-xs',
                      r.type === 'sub' ? 'bg-purple-50 font-medium' : ''
                    )}
                    style={{ height: ROW_H }}
                  >
                    {r.type === 'sub' ? (
                      <span className="truncate">{r.sub.name}</span>
                    ) : (
                      <span className="flex items-center gap-1.5 truncate w-full">
                        {r.task.isMilestone && <Diamond className="w-3 h-3 text-amber-600 shrink-0" />}
                        {cpm.criticalPathIds.has(r.task.id) && <Flame className="w-3 h-3 text-red-500 shrink-0" />}
                        <span className="font-mono text-[10px] text-ink-500">{r.task.code}</span>
                        <span className="truncate">{r.task.name}</span>
                      </span>
                    )}
                  </div>
                ))}
              </div>

              {/* 时间轴 + bars */}
              <div className="flex-1 overflow-x-auto relative">
                <div style={{ width: totalWidth, position: 'relative' }}>
                  <div className="bg-ink-100 sticky top-0 z-10 border-b border-ink-300/40" style={{ height: HEADER_H }}>
                    <div className="absolute inset-x-0 top-0 h-6">
                      {months.map((m) => (
                        <div key={m.label} className="absolute top-0 h-full text-xs flex items-center px-1.5 text-ink-700 font-medium border-r border-ink-300/60 bg-ink-100" style={{ left: m.x }}>
                          {m.label}
                        </div>
                      ))}
                    </div>
                    <div className="absolute inset-x-0 bottom-0 h-7 border-t border-ink-300/40">
                      {Array.from({ length: totalDays }).map((_, i) => {
                        const d = addDays(projectStart, i)
                        const x = i * DAY_W
                        const isWE = isWeekend(d)
                        return (
                          <div key={i} className={cn('absolute top-0 h-full', isWE && 'bg-amber-50/50')} style={{ left: x, width: DAY_W }}>
                            {d.getDay() === 1 && (
                              <div className="text-[10px] text-ink-500 px-0.5 leading-none pt-1.5 border-l border-ink-300/40 h-full">
                                {format(d, 'M/d')}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>

                  <div className="relative" style={{ height: rows.length * ROW_H }}>
                    {/* 周末背景 */}
                    {Array.from({ length: totalDays }).map((_, i) => {
                      const d = addDays(projectStart, i)
                      if (!isWeekend(d)) return null
                      return <div key={i} className="absolute top-0 bottom-0 bg-amber-50/30" style={{ left: i * DAY_W, width: DAY_W }} />
                    })}

                    {/* 行分隔 */}
                    {rows.map((_, i) => (
                      <div key={i} className="absolute left-0 right-0 border-b border-ink-300/30" style={{ top: (i + 1) * ROW_H }} />
                    ))}

                    {/* bars */}
                    {rows.map((r, i) => {
                      if (r.type !== 'task') return null
                      const t = r.task
                      const left = xOf(parseISO(t.plannedStart))
                      const w = Math.max(t.isMilestone ? 16 : 6, differenceInCalendarDays(parseISO(t.plannedEnd), parseISO(t.plannedStart)) * DAY_W)
                      const top = i * ROW_H + (ROW_H - 18) / 2
                      const isCritical = cpm.criticalPathIds.has(t.id)

                      if (t.isMilestone) {
                        return (
                          <div
                            key={t.id}
                            className="absolute"
                            style={{ left: left - 8, top: top, width: 16, height: 16 }}
                            title={t.name}
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
                            'absolute rounded h-[18px] border',
                            isCritical
                              ? 'bg-red-500 border-red-700'
                              : 'bg-brand-500 border-brand-700'
                          )}
                          style={{ left, top, width: w }}
                          title={`${t.name}\n${t.plannedStart} ~ ${t.plannedEnd}\n${t.estimatedEffort} 人天`}
                        >
                          <div className="px-1.5 text-[10px] text-white whitespace-nowrap leading-[18px]">{t.code}</div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>
            </div>
          )}
        </CardBody>
      </Card>

      <div className="mt-3 px-3 py-2 rounded-md bg-amber-50 text-amber-700 text-xs flex items-start gap-2">
        <Eye className="w-3.5 h-3.5 mt-0.5" />
        <span>预览基于模板默认工期与依赖关系生成，仅供模板调整时验证合理性。真实创建项目时还会综合人员负荷、资源日历等因素。</span>
      </div>
    </div>
  )
}

function KpiBlock({ label, value, icon }: { label: string; value: number | string; icon?: React.ReactNode }) {
  return (
    <div className="card p-3 text-center">
      <div className="text-2xl font-semibold text-ink-900 leading-none">{value}</div>
      <div className="text-xs text-ink-500 mt-1 inline-flex items-center gap-1 justify-center">{icon}{label}</div>
    </div>
  )
}

// === 把模板节点转换为 Task / Dependency 序列 ===
function generateTasksFromTemplate(root: TemplateNode, startDateIso: string): {
  tasks: Task[]
  deps: TaskDependency[]
  totalDays: number
  projectStart: Date
} {
  const projectStart = parseISO(startDateIso)
  const taskCodeToId = new Map<string, string>()
  const tasks: Task[] = []
  const deps: TaskDependency[] = []

  // 第一遍：收集所有任务并分配 id（计算 plannedStart 暂时填默认）
  const flatTaskNodes: TemplateNode[] = []
  root.children?.forEach((sub) => {
    sub.children?.forEach((t) => {
      flatTaskNodes.push(t)
      if (t.taskCode) taskCodeToId.set(t.taskCode, t.id)
    })
  })

  // 用 BFS / 拓扑顺序计算每个任务的 plannedStart（从 projectStart 起，默认串行 + 依赖）
  // 简化算法：以 taskCode 顺序为基础，通过依赖回查
  const startMap = new Map<string, number>()  // 每个任务的 ES 天数偏移
  const endMap = new Map<string, number>()

  // 初始化所有任务的预设位置：按出现顺序累加（fallback）
  let cursor = 0
  flatTaskNodes.forEach((t) => {
    if (t.isMilestone) {
      startMap.set(t.id, cursor)
      endMap.set(t.id, cursor)
    } else {
      const dur = t.defaultDuration || 1
      startMap.set(t.id, cursor)
      endMap.set(t.id, cursor + dur)
      cursor += dur
    }
  })

  // 多轮迭代：根据依赖更新
  for (let iter = 0; iter < 10; iter++) {
    let changed = false
    flatTaskNodes.forEach((t) => {
      if (!t.predecessors || t.predecessors.length === 0) {
        // 没有依赖，从 0 开始
        if ((startMap.get(t.id) || 0) !== 0) {
          startMap.set(t.id, 0)
          endMap.set(t.id, t.isMilestone ? 0 : (t.defaultDuration || 1))
          changed = true
        }
        return
      }
      let earliestStart = 0
      const dur = t.isMilestone ? 0 : (t.defaultDuration || 1)
      for (const p of t.predecessors) {
        const pId = taskCodeToId.get(p.taskCode)
        if (!pId) continue
        const pStart = startMap.get(pId) || 0
        const pEnd = endMap.get(pId) || 0
        let cs = 0
        switch (p.type) {
          case 'FS': cs = pEnd + p.lagDays; break
          case 'SS': cs = pStart + p.lagDays; break
          case 'FF': cs = pEnd + p.lagDays - dur; break
          case 'SF': cs = pStart + p.lagDays - dur; break
        }
        if (cs > earliestStart) earliestStart = cs
      }
      if (Math.abs((startMap.get(t.id) || 0) - earliestStart) > 0.01) {
        startMap.set(t.id, earliestStart)
        endMap.set(t.id, earliestStart + dur)
        changed = true
      }
    })
    if (!changed) break
  }

  let maxEnd = 0
  flatTaskNodes.forEach((t) => {
    const s = startMap.get(t.id) || 0
    const e = endMap.get(t.id) || 0
    if (e > maxEnd) maxEnd = e
    const sub = root.children?.find((ss) => ss.children?.some((c) => c.id === t.id))
    tasks.push({
      id: t.id,
      code: t.taskCode || t.id.slice(0, 6),
      name: t.name,
      subProjectId: sub?.id || 'unknown',
      ownerId: 'u1',
      status: '未开始',
      priority: '中',
      plannedStart: format(addDays(projectStart, s), 'yyyy-MM-dd'),
      plannedEnd: format(addDays(projectStart, e), 'yyyy-MM-dd'),
      estimatedEffort: t.defaultEffort || 0,
      progress: 0,
      isMilestone: !!t.isMilestone,
      isCriticalPath: false,
    })

    t.predecessors?.forEach((p) => {
      const pId = taskCodeToId.get(p.taskCode)
      if (pId) deps.push({ id: `${pId}-${t.id}`, predecessorId: pId, successorId: t.id, type: p.type as DependencyType, lagDays: p.lagDays })
    })
  })

  return { tasks, deps, totalDays: Math.max(maxEnd + 5, 10), projectStart }
}
