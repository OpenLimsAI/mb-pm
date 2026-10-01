// CPM（关键路径方法）算法
// 处理 FS / SS / FF / SF 四种依赖 + 延迟天数（lagDays）

import { differenceInCalendarDays, parseISO, addDays, format } from 'date-fns'
import type { Task, TaskDependency, DependencyType } from '../types'

export interface CPMTask extends Task {
  durationDays: number
  esDay: number  // Earliest Start (天数偏移，相对项目最早开始)
  efDay: number  // Earliest Finish
  lsDay: number  // Latest Start
  lfDay: number  // Latest Finish
  slackDays: number
  isOnCriticalPath: boolean
  // 转回日期方便渲染
  earliestStart: string
  earliestFinish: string
  latestStart: string
  latestFinish: string
}

export interface CPMResult {
  tasks: CPMTask[]
  byId: Map<string, CPMTask>
  projectStart: Date
  projectEnd: Date
  totalDays: number
  criticalPathIds: Set<string>
}

const taskDuration = (t: Task): number => {
  if (t.isMilestone) return 0
  const start = parseISO(t.plannedStart)
  const end = parseISO(t.plannedEnd)
  return Math.max(0, differenceInCalendarDays(end, start))
}

export function computeCPM(tasks: Task[], deps: TaskDependency[]): CPMResult {
  if (tasks.length === 0) {
    return {
      tasks: [],
      byId: new Map(),
      projectStart: new Date(),
      projectEnd: new Date(),
      totalDays: 0,
      criticalPathIds: new Set(),
    }
  }

  // 项目最早起点
  const allStarts = tasks.map((t) => parseISO(t.plannedStart).getTime())
  const projectStart = new Date(Math.min(...allStarts))
  const startDay = (iso: string) => differenceInCalendarDays(parseISO(iso), projectStart)

  // 邻接表
  const taskMap = new Map<string, Task>(tasks.map((t) => [t.id, t]))
  const inEdges = new Map<string, { id: string; type: DependencyType; lag: number }[]>()
  const outEdges = new Map<string, { id: string; type: DependencyType; lag: number }[]>()
  tasks.forEach((t) => {
    inEdges.set(t.id, [])
    outEdges.set(t.id, [])
  })
  deps.forEach((d) => {
    if (!taskMap.has(d.predecessorId) || !taskMap.has(d.successorId)) return
    inEdges.get(d.successorId)!.push({ id: d.predecessorId, type: d.type, lag: d.lagDays })
    outEdges.get(d.predecessorId)!.push({ id: d.successorId, type: d.type, lag: d.lagDays })
  })

  // 拓扑排序（Kahn）
  const inDeg = new Map<string, number>()
  tasks.forEach((t) => inDeg.set(t.id, inEdges.get(t.id)!.length))
  const queue: string[] = []
  inDeg.forEach((d, id) => { if (d === 0) queue.push(id) })
  const order: string[] = []
  while (queue.length) {
    const u = queue.shift()!
    order.push(u)
    outEdges.get(u)!.forEach((s) => {
      inDeg.set(s.id, inDeg.get(s.id)! - 1)
      if (inDeg.get(s.id)! === 0) queue.push(s.id)
    })
  }
  // 若有环，按原顺序兜底
  if (order.length < tasks.length) {
    tasks.forEach((t) => { if (!order.includes(t.id)) order.push(t.id) })
  }

  // Forward pass
  const es = new Map<string, number>()
  const ef = new Map<string, number>()
  const dur = (id: string) => taskDuration(taskMap.get(id)!)

  for (const id of order) {
    const t = taskMap.get(id)!
    let earliestStart = startDay(t.plannedStart)
    for (const p of inEdges.get(id)!) {
      const pES = es.get(p.id) ?? 0
      const pEF = ef.get(p.id) ?? 0
      const tDur = dur(id)
      let cs = earliestStart
      switch (p.type) {
        case 'FS': cs = pEF + p.lag; break
        case 'SS': cs = pES + p.lag; break
        case 'FF': cs = pEF + p.lag - tDur; break
        case 'SF': cs = pES + p.lag - tDur; break
      }
      if (cs > earliestStart) earliestStart = cs
    }
    es.set(id, earliestStart)
    ef.set(id, earliestStart + dur(id))
  }

  const projectEndDay = Math.max(...Array.from(ef.values()))

  // Backward pass
  const ls = new Map<string, number>()
  const lf = new Map<string, number>()
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i]
    const tDur = dur(id)
    const succs = outEdges.get(id)!
    let latestFinish: number
    if (succs.length === 0) {
      latestFinish = projectEndDay
    } else {
      latestFinish = projectEndDay
      for (const s of succs) {
        const sLS = ls.get(s.id)!
        const sLF = lf.get(s.id)!
        let cf: number
        switch (s.type) {
          case 'FS': cf = sLS - s.lag; break
          case 'SS': cf = sLS - s.lag + tDur; break
          case 'FF': cf = sLF - s.lag; break
          case 'SF': cf = sLF - s.lag + tDur; break
        }
        if (cf < latestFinish) latestFinish = cf
      }
    }
    lf.set(id, latestFinish)
    ls.set(id, latestFinish - tDur)
  }

  // 组装结果
  const enriched: CPMTask[] = tasks.map((t) => {
    const tEs = es.get(t.id)!
    const tEf = ef.get(t.id)!
    const tLs = ls.get(t.id)!
    const tLf = lf.get(t.id)!
    const slack = Math.max(0, tLs - tEs)
    return {
      ...t,
      durationDays: taskDuration(t),
      esDay: tEs,
      efDay: tEf,
      lsDay: tLs,
      lfDay: tLf,
      slackDays: slack,
      isOnCriticalPath: slack === 0,
      earliestStart: format(addDays(projectStart, tEs), 'yyyy-MM-dd'),
      earliestFinish: format(addDays(projectStart, tEf), 'yyyy-MM-dd'),
      latestStart: format(addDays(projectStart, tLs), 'yyyy-MM-dd'),
      latestFinish: format(addDays(projectStart, tLf), 'yyyy-MM-dd'),
    }
  })

  const byId = new Map(enriched.map((t) => [t.id, t]))
  const criticalPathIds = new Set(enriched.filter((t) => t.isOnCriticalPath).map((t) => t.id))
  return {
    tasks: enriched,
    byId,
    projectStart,
    projectEnd: addDays(projectStart, projectEndDay),
    totalDays: projectEndDay,
    criticalPathIds,
  }
}

// 延迟影响推演：给定任务 ID 和延迟天数，递归找出所有受影响的下游任务
export interface DelayImpact {
  taskId: string
  taskName: string
  taskCode: string
  shiftDays: number
  affectsCritical: boolean
  affectsMilestone: boolean
  newPlannedEnd: string
  hops: number
}

export function simulateDelay(
  cpm: CPMResult,
  deps: TaskDependency[],
  startTaskId: string,
  delayDays: number
): DelayImpact[] {
  const result: DelayImpact[] = []
  const seen = new Map<string, number>() // id -> max shift

  // 邻接（出边）
  const out = new Map<string, { id: string; type: DependencyType; lag: number }[]>()
  cpm.tasks.forEach((t) => out.set(t.id, []))
  deps.forEach((d) => {
    if (!out.has(d.predecessorId) || !cpm.byId.has(d.successorId)) return
    out.get(d.predecessorId)!.push({ id: d.successorId, type: d.type, lag: d.lagDays })
  })

  // BFS 推演
  type Frame = { id: string; shift: number; hops: number }
  const queue: Frame[] = [{ id: startTaskId, shift: delayDays, hops: 0 }]
  while (queue.length) {
    const f = queue.shift()!
    const prevShift = seen.get(f.id) ?? -Infinity
    if (f.shift <= prevShift) continue
    seen.set(f.id, f.shift)

    if (f.hops > 0) {
      const t = cpm.byId.get(f.id)!
      result.push({
        taskId: t.id,
        taskName: t.name,
        taskCode: t.code,
        shiftDays: f.shift,
        affectsCritical: t.isOnCriticalPath,
        affectsMilestone: t.isMilestone,
        newPlannedEnd: format(addDays(parseISO(t.plannedEnd), f.shift), 'yyyy-MM-dd'),
        hops: f.hops,
      })
    }

    // 推到下游：FS/SS 通常会传递起点，FF/SF 通常会传递终点
    for (const s of out.get(f.id) || []) {
      // 简化模型：所有依赖都将 shift 完整传递（保守估计）
      queue.push({ id: s.id, shift: f.shift, hops: f.hops + 1 })
    }
  }

  return result.sort((a, b) => a.hops - b.hops || b.shiftDays - a.shiftDays)
}
