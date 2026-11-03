import { useCallback, useMemo, useState, useRef, useEffect, useLayoutEffect } from 'react'
import {
  GanttChartSquare, Flame, Diamond, ChevronDown, ChevronRight, GitBranch,
} from 'lucide-react'
import { addDays, addMonths, addYears, differenceInCalendarDays, format, parseISO, startOfMonth, startOfYear, isWeekend } from 'date-fns'
import type { Project, SubProject, Task } from '../../types'
import { Card, CardHeader, CardBody, Tag, Avatar } from '../ui'
import { findUser, getProjectSubs, getSubTasks, taskDependencies, TODAY } from '../../mock'
import { computeCPM } from '../../lib/cpm'
import { useDataStore } from '../../store/data'
import { cn } from '../../lib/cn'
import { dayWidthForZoom, scaleForDayWidth } from '../../lib/ganttZoom'
import { TimelineZoomControl } from './TimelineZoomControl'
import { GanttTaskButton } from './GanttTaskButton'
import { GanttViewport } from './GanttViewport'
import { restoreTimelineCenter, visibleTimelineWidth } from '../../lib/ganttViewport'

const ROW_H = 34
const BAR_H = 22
const HEADER_H = 56
const LABEL_W = 320

interface Props {
  project: Project
  selectedTaskId?: string
  onSelectTask?: (id: string) => void
  fillHeight?: boolean
}

export function Gantt({ project, selectedTaskId, onSelectTask, fillHeight = false }: Props) {
  const [zoom, setZoom] = useState(66)
  const [showCP, setShowCP] = useState(true)
  const [showDeps, setShowDeps] = useState(true)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const version = useDataStore((state) => state.version)

  // API 同步会替换任务数组；版本变化后须一起重算范围与关键路径。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const subs = useMemo<SubProject[]>(() => getProjectSubs(project.id).sort((a, b) => a.sortOrder - b.sortOrder), [project.id, version])
  const allTasks = useMemo<Task[]>(() => subs.flatMap((s) => getSubTasks(s.id)), [subs])
  const cpm = useMemo(() => computeCPM(allTasks, taskDependencies), [allTasks])

  // 时间范围（含 padding）
  const range = useMemo(() => {
    if (allTasks.length === 0) {
      return { start: new Date(), end: addDays(new Date(), 30), totalDays: 30 }
    }
    const starts = allTasks.map((t) => parseISO(t.plannedStart).getTime())
    const ends = allTasks.map((t) => parseISO(t.plannedEnd).getTime())
    const start = addDays(new Date(Math.min(...starts)), -3)
    const end = addDays(new Date(Math.max(...ends)), 3)
    return { start, end, totalDays: differenceInCalendarDays(end, start) + 1 }
  }, [allTasks])

  const dayW = dayWidthForZoom(zoom)
  const scale = scaleForDayWidth(dayW)
  const totalWidth = range.totalDays * dayW

  // 渲染顺序：sub → tasks
  type Row = { type: 'sub'; sub: SubProject } | { type: 'task'; task: Task; sub: SubProject }
  const rows: Row[] = []
  for (const s of subs) {
    rows.push({ type: 'sub', sub: s })
    if (!collapsed.has(s.id)) {
      for (const t of getSubTasks(s.id)) rows.push({ type: 'task', task: t, sub: s })
    }
  }

  const xOf = useCallback((date: Date | string) => {
    const d = typeof date === 'string' ? parseISO(date) : date
    return differenceInCalendarDays(d, range.start) * dayW
  }, [range.start, dayW])

  // 与全局「今日」（本机当前日期）一致，保证今日线位置与逾期判定自洽。
  const today = TODAY
  const todayX = xOf(today)
  const isTodayInRange = todayX >= 0 && todayX <= totalWidth

  // 年视图使用年份带，其余视图使用月份带，首尾裁切到时间范围。
  const bands = useMemo(() => {
    const result: { label: string; left: number; width: number }[] = []
    let cur = scale === 'year' ? startOfYear(range.start) : startOfMonth(range.start)
    while (cur <= range.end) {
      const next = scale === 'year' ? addYears(cur, 1) : addMonths(cur, 1)
      const left = Math.max(0, differenceInCalendarDays(cur, range.start) * dayW)
      const right = Math.min(totalWidth, differenceInCalendarDays(next, range.start) * dayW)
      result.push({ label: format(cur, scale === 'year' ? 'yyyy' : 'yyyy-MM'), left, width: right - left })
      cur = next
    }
    return result
  }, [range.start, range.end, scale, dayW, totalWidth])
  const dates = useMemo(() => Array.from({ length: range.totalDays }, (_, i) => addDays(range.start, i)), [range.start, range.totalDays])

  // sub 的范围
  const subRange = (sub: SubProject) => {
    const ts = getSubTasks(sub.id)
    if (ts.length === 0) return null
    const s = Math.min(...ts.map((t) => parseISO(t.plannedStart).getTime()))
    const e = Math.max(...ts.map((t) => parseISO(t.plannedEnd).getTime()))
    return { left: xOf(new Date(s)), width: Math.max(2, xOf(new Date(e)) - xOf(new Date(s))) }
  }

  // 计算 task 行 y
  const rowYOf = (taskId: string) => {
    const idx = rows.findIndex((r) => r.type === 'task' && r.task.id === taskId)
    return idx === -1 ? -100 : idx * ROW_H + ROW_H / 2
  }

  // 同步水平滚动：toolbar 信息只读
  const scrollRef = useRef<HTMLDivElement>(null)
  const centerDayRef = useRef<number | null>(null)
  const changeZoom = (value: number) => {
    const el = scrollRef.current
    if (el) {
      const visibleWidth = Math.min(visibleTimelineWidth(el, LABEL_W), Math.max(0, totalWidth - el.scrollLeft))
      centerDayRef.current = (el.scrollLeft + visibleWidth / 2) / dayW
    }
    setZoom(Math.max(0, Math.min(100, value)))
  }
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el || centerDayRef.current === null) return
    restoreTimelineCenter(el, centerDayRef.current, dayW, totalWidth, LABEL_W)
    centerDayRef.current = null
  }, [dayW, totalWidth])
  const xOfRef = useRef(xOf)
  useLayoutEffect(() => { xOfRef.current = xOf }, [xOf])
  useEffect(() => {
    if (!selectedTaskId) return
    const el = scrollRef.current
    if (!el) return
    const t = cpm.byId.get(selectedTaskId)
    if (!t) return
    const tx = xOfRef.current(parseISO(t.plannedStart))
    const target = tx - 80
    if (target < el.scrollLeft || target > el.scrollLeft + visibleTimelineWidth(el, LABEL_W) - 80) {
      el.scrollTo({ left: target, behavior: 'smooth' })
    }
  }, [selectedTaskId, cpm.byId])

  return (
    <Card className={cn('gantt-card', fillHeight && 'gantt-card--fill')}>
      <CardHeader
        className="gantt-toolbar"
        title={
          <span className="flex items-center gap-2">
            <GanttChartSquare className="w-4 h-4 text-brand-600" />
            甘特图
            {cpm.criticalPathIds.size > 0 && (
              <Tag tone="red" className="ml-2 gap-1">
                <Flame className="w-3 h-3" />
                关键路径 {cpm.criticalPathIds.size} 项
              </Tag>
            )}
          </span>
        }
        subtitle={`项目周期 ${format(range.start, 'yyyy-MM-dd')} ~ ${format(range.end, 'yyyy-MM-dd')} · 共 ${range.totalDays} 天`}
        action={
          <div className="flex flex-wrap items-center justify-end gap-1">
            <ToggleButton active={showCP} onClick={() => setShowCP((v) => !v)} icon={<Flame className="w-3.5 h-3.5" />} label="关键路径" />
            <ToggleButton active={showDeps} onClick={() => setShowDeps((v) => !v)} icon={<GitBranch className="w-3.5 h-3.5" />} label="依赖" />
            <TimelineZoomControl zoom={zoom} onChange={changeZoom} />
          </div>
        }
      />
      <CardBody className="gantt-card-body">
        <GanttViewport
          scrollRef={scrollRef}
          labelWidth={LABEL_W}
          timelineWidth={totalWidth}
          headerHeight={HEADER_H}
          bodyHeight={rows.length * ROW_H}
          labelHeader={<div className="px-3 h-full flex items-center text-[13px] text-ink-900 font-semibold">任务（{allTasks.length}）</div>}
          labels={<>
            {rows.map((r, i) => (
              <div
                key={i}
                className={cn(
                  'flex items-center px-3 border-b border-ink-300/40 text-[13px] text-ink-900',
                  r.type === 'sub' ? 'bg-purple-50 font-semibold' : 'hover:bg-ink-100/40 cursor-pointer',
                  r.type === 'task' && selectedTaskId === r.task.id && 'bg-brand-50'
                )}
                style={{ height: ROW_H }}
                onClick={() => r.type === 'task' && onSelectTask?.(r.task.id)}
              >
                {r.type === 'sub' ? (
                  <button
                    className="flex items-center gap-1 truncate w-full"
                    onClick={(e) => {
                      e.stopPropagation()
                      const next = new Set(collapsed)
                      if (next.has(r.sub.id)) next.delete(r.sub.id)
                      else next.add(r.sub.id)
                      setCollapsed(next)
                    }}
                  >
                    {collapsed.has(r.sub.id) ? <ChevronRight className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                    <span className="truncate">{r.sub.name}</span>
                    <span className="ml-auto text-ink-600 text-[11px]">{getSubTasks(r.sub.id).length}</span>
                  </button>
                ) : (
                  <TaskLabel task={r.task} isCritical={cpm.criticalPathIds.has(r.task.id) && showCP} />
                )}
              </div>
            ))}
          </>}
          timeHeader={<>
                {/* 月份带 */}
                <div className="absolute inset-x-0 top-0 h-6">
                  {bands.map((band) => (
                    <div key={band.label} className="absolute top-0 h-full text-xs flex items-center px-1.5 text-ink-900 font-semibold border-r border-ink-300/60 bg-ink-100 overflow-hidden whitespace-nowrap" style={{ left: band.left, width: band.width }}>{band.label}</div>
                  ))}
                </div>
                {/* 天/周刻度 */}
                <div className="absolute inset-x-0 bottom-0 h-7 border-t border-ink-300/40">
                  {dates.map((d, i) => {
                    const show = scale === 'day' || (scale === 'week' && d.getDay() === 1) ||
                      (scale === 'month' && (d.getDate() === 1 || d.getDate() === 15)) ||
                      (scale === 'year' && d.getDate() === 1 && d.getMonth() % 3 === 0)
                    if (!show) return null
                    return <div key={i} className="absolute top-0 h-full text-[11px] font-semibold text-ink-700 px-0.5 leading-none pt-1.5 border-l border-ink-300/40" style={{ left: i * dayW }}>{scale === 'year' ? `Q${Math.floor(d.getMonth() / 3) + 1}` : scale === 'week' ? format(d, 'M/d') : format(d, 'd')}</div>
                  })}
                </div>
          </>}
        >
                {/* 周末背景 */}
                {dates.map((d, i) => {
                  if (!isWeekend(d) || scale === 'month' || scale === 'year') return null
                  return (
                    <div key={i} className="absolute top-0 bottom-0 bg-amber-50/30" style={{ left: i * dayW, width: dayW }} />
                  )
                })}

                {/* 行分隔 */}
                {rows.map((_, i) => (
                  <div key={i} className="absolute left-0 right-0 border-b border-ink-300/30" style={{ top: (i + 1) * ROW_H }} />
                ))}

                {/* 今日竖线 */}
                {isTodayInRange && (
                  <div
                    className="absolute top-0 bottom-0 w-px bg-red-500/70 z-10 pointer-events-none"
                    style={{ left: todayX }}
                  >
                    <div className="absolute -top-5 -translate-x-1/2 px-1 bg-red-500 text-white text-[10px] rounded whitespace-nowrap">
                      今日
                    </div>
                  </div>
                )}

                {/* sub 概要条 */}
                {rows.map((r, i) => {
                  if (r.type !== 'sub') return null
                  const sr = subRange(r.sub)
                  if (!sr) return null
                  return (
                    <div
                      key={`sb-${i}`}
                      className="absolute h-1.5 bg-purple-300 rounded"
                      style={{ left: sr.left, top: i * ROW_H + ROW_H / 2 - 3, width: sr.width }}
                    />
                  )
                })}

                {/* task bars */}
                {rows.map((r, i) => {
                  if (r.type !== 'task') return null
                  const t = r.task
                  const left = xOf(parseISO(t.plannedStart))
                  const w = Math.max(t.isMilestone ? 20 : 6, differenceInCalendarDays(parseISO(t.plannedEnd), parseISO(t.plannedStart)) * dayW)
                  const top = i * ROW_H + (ROW_H - BAR_H) / 2
                  const isCritical = cpm.criticalPathIds.has(t.id)
                  const isSelected = selectedTaskId === t.id

                  if (t.isMilestone) {
                    return (
                      <GanttTaskButton
                        key={t.id}
                        task={t}
                        ownerName={findUser(t.ownerId)?.displayName}
                        onSelectTask={onSelectTask}
                        className="gantt-task-bar absolute group cursor-pointer"
                        style={{ left: left - 9, top: i * ROW_H + (ROW_H - 18) / 2, width: 18, height: 18 }}
                      >
                        <div className={cn(
                          'w-full h-full rotate-45 border-2',
                          isCritical && showCP ? 'bg-red-500 border-red-700' : 'bg-amber-500 border-amber-700'
                        )} />
                      </GanttTaskButton>
                    )
                  }

                  return (
                    <GanttTaskButton
                      key={t.id}
                      task={t}
                      ownerName={findUser(t.ownerId)?.displayName}
                      onSelectTask={onSelectTask}
                      className={cn(
                        'gantt-task-bar absolute rounded cursor-pointer overflow-hidden border transition-all',
                        isCritical && showCP
                          ? 'bg-red-500 border-red-700 hover:bg-red-400'
                          : t.status === '已完成' || t.status === '已验证'
                          ? 'bg-emerald-500 border-emerald-700'
                          : t.status === '延迟' || t.status === '阻塞'
                          ? 'bg-amber-500 border-amber-700'
                          : 'bg-brand-500 border-brand-700 hover:bg-brand-400',
                        isSelected && 'ring-2 ring-brand-300 z-10'
                      )}
                      style={{ left, top, width: w, height: BAR_H }}
                    >
                      {/* 进度填充 */}
                      <div
                        className="h-full bg-white/30 absolute left-0 top-0"
                        style={{ width: `${t.progress}%` }}
                      />
                    </GanttTaskButton>
                  )
                })}

                {/* 依赖线 SVG */}
                {showDeps && (
                  <svg
                    className="absolute inset-0 pointer-events-none"
                    width={totalWidth}
                    height={rows.length * ROW_H}
                  >
                    <defs>
                      <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                        <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8" />
                      </marker>
                      <marker id="arrowCp" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                        <path d="M0,0 L10,5 L0,10 z" fill="#dc2626" />
                      </marker>
                    </defs>
                    {taskDependencies.map((d) => {
                      const pred = cpm.byId.get(d.predecessorId)
                      const succ = cpm.byId.get(d.successorId)
                      if (!pred || !succ) return null
                      const yPred = rowYOf(d.predecessorId)
                      const ySucc = rowYOf(d.successorId)
                      if (yPred < 0 || ySucc < 0) return null

                      // 起止 x 取决于依赖类型
                      const predStart = xOf(parseISO(pred.plannedStart))
                      const predEnd = xOf(parseISO(pred.plannedEnd))
                      const succStart = xOf(parseISO(succ.plannedStart))
                      const succEnd = xOf(parseISO(succ.plannedEnd))
                      let x1 = predEnd, x2 = succStart
                      if (d.type === 'SS') { x1 = predStart; x2 = succStart }
                      else if (d.type === 'FF') { x1 = predEnd; x2 = succEnd }
                      else if (d.type === 'SF') { x1 = predStart; x2 = succEnd }

                      const isCritical = cpm.criticalPathIds.has(pred.id) && cpm.criticalPathIds.has(succ.id)
                      const stroke = isCritical && showCP ? '#dc2626' : '#94a3b8'
                      const marker = isCritical && showCP ? 'url(#arrowCp)' : 'url(#arrow)'

                      // 折线
                      const midY = ySucc
                      const path = `M${x1},${yPred} L${x1 + 6},${yPred} L${x1 + 6},${midY} L${x2 - 6},${midY} L${x2},${midY}`

                      return (
                        <path
                          key={d.id}
                          d={path}
                          fill="none"
                          stroke={stroke}
                          strokeWidth="1.5"
                          strokeDasharray={d.type === 'FS' ? undefined : '3 3'}
                          markerEnd={marker}
                          opacity={0.85}
                        />
                      )
                    })}
                  </svg>
                )}
        </GanttViewport>

        {/* 图例 */}
        <div className="gantt-legend px-4 py-2 border-t border-ink-300/40 text-[11px] text-ink-700 flex items-center gap-4 flex-wrap">
          <span className="flex items-center gap-1.5"><span className="w-3 h-2 rounded bg-brand-500" />进行中</span>
          <span className="flex items-center gap-1.5"><span className="w-3 h-2 rounded bg-emerald-500" />已完成</span>
          <span className="flex items-center gap-1.5"><span className="w-3 h-2 rounded bg-amber-500" />延迟/阻塞</span>
          {showCP && <span className="flex items-center gap-1.5"><span className="w-3 h-2 rounded bg-red-500" /><Flame className="w-3 h-3 text-red-500" />关键路径</span>}
          <span className="flex items-center gap-1.5"><Diamond className="w-3 h-3 text-amber-600" />里程碑</span>
          <span className="flex items-center gap-1.5"><span className="w-px h-3 bg-red-500" />今日</span>
          {showDeps && (
            <>
              <span className="flex items-center gap-1.5 ml-auto">实线=FS</span>
              <span className="flex items-center gap-1.5">虚线=SS/FF/SF</span>
            </>
          )}
        </div>
      </CardBody>
    </Card>
  )
}

function ToggleButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs transition-colors',
        active ? 'bg-brand-50 text-brand-700' : 'text-ink-700 hover:bg-ink-100'
      )}
    >
      {icon}
      {label}
    </button>
  )
}

function TaskLabel({ task, isCritical }: { task: Task; isCritical?: boolean }) {
  const owner = findUser(task.ownerId)
  return (
    <div className="flex items-center gap-1.5 truncate">
      {task.isMilestone && <Diamond className="w-3 h-3 text-amber-600 shrink-0" />}
      {isCritical && <Flame className="w-3 h-3 text-red-500 shrink-0" />}
      <span className="truncate font-semibold">{task.name}</span>
      <span className="ml-auto pl-1 flex items-center gap-1.5">
        {owner && <Avatar user={owner} size="sm" />}
      </span>
    </div>
  )
}
