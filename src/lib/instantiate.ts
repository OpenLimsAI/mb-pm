// 模板实例化引擎 — 把一个 TemplateNode 模板树展开成「子项目 + 任务 + 依赖」。
//
// 这是从 mock/tasks.ts 的内部 instantiateTemplate() 提炼出的可复用版本，
// 供「根据模板创建项目」流程调用，使新建项目与内置示例项目（p1/p2/p3）
// 走完全一致的排期 / 状态 / 进度派生逻辑。
//
// 算法（5 趟）：
//   Pass 1  模板 L2 子项目 → SubProject
//   Pass 2  拓扑排序 + 计算任务日期（本地前驱链 + 阶段下限）
//   Pass 3  生成 Task（按计划日期 vs today 自动派生状态/进度）
//   Pass 4  生成 TaskDependency
//   Pass 5  由任务派生子项目进度/状态
// 最后 deriveRollup() 汇总出项目级 progress / health / currentStage。

import type {
  Health, Stage, SubProject, Task, TaskDependency, TaskStatus, TemplateNode,
} from '../types'

const DAY_MS = 86400000
const formatDate = (d: Date): string => d.toISOString().slice(0, 10)
const addDays = (d: Date, days: number): Date => new Date(d.getTime() + days * DAY_MS)
// 任务日期都对齐到 UTC 零点；比较用的「今天」也必须对齐到 UTC 零点，
// 否则本地时区（尤其 UTC 以西）会导致状态/进度按日错位。
const floorUTCDate = (d: Date): Date => new Date(`${d.toISOString().slice(0, 10)}T00:00:00Z`)

// 阶段 → 项目启动后第几天可以最早开始
// （补偿「跨模块前驱不在本模板 33 任务里」的问题：让后期阶段任务自然落到项目后期。）
const STAGE_EARLIEST_DAY: Record<Stage, number> = {
  '临床前': 0,
  'IND': 360,
  'Ph1/2': 540,
  'Ph3': 720,
  'BLA': 900,
  '商业化': 1080,
  '上市后': 1260,
}

export interface InstantiationOptions {
  projectId: string
  projectCode: string
  /** 项目计划开始日期 YYYY-MM-DD，作为所有任务日期推算的基准 */
  projectStartDate: string
  /** 默认负责角色（'上游'/'下游'…）→ 用户 ID 的映射 */
  ownerByRole: Record<string, string>
  /** 兜底负责人 ID */
  fallbackOwnerId: string
  /** 派生任务状态/进度的「今天」，默认运行时当前日期 */
  today?: Date
}

export interface InstantiationResult {
  subProjects: SubProject[]
  tasks: Task[]
  dependencies: TaskDependency[]
}

export function instantiateTemplate(
  template: TemplateNode,
  opts: InstantiationOptions,
): InstantiationResult {
  const {
    projectId, projectCode, projectStartDate, ownerByRole, fallbackOwnerId,
    today = new Date(),
  } = opts
  const nowUTC = floorUTCDate(today)

  const subProjects: SubProject[] = []
  const tasks: Task[] = []
  const dependencies: TaskDependency[] = []

  // 收集模板里所有 leaf（任务）
  const allLeaves: Array<{ leaf: TemplateNode; subProjectIdx: number }> = []
  template.children?.forEach((sp, spIdx) => {
    sp.children?.forEach((leaf) => {
      allLeaves.push({ leaf, subProjectIdx: spIdx })
    })
  })

  const taskIdOf = (taskCode: string) => `${projectId}-${taskCode}`
  const subProjectIdOf = (templateSubProjectId: string) => `${projectId}-${templateSubProjectId}`

  // —— Pass 1：创建子项目 —— //
  template.children?.forEach((sp, spIdx) => {
    subProjects.push({
      id: subProjectIdOf(sp.id),
      name: sp.name,
      projectId,
      stage: sp.stage || '临床前',
      module: sp.module || '其他',
      ownerId: ownerByRole[sp.module === 'USP' ? '上游' : sp.module === 'DSP' ? '下游' : ''] || fallbackOwnerId,
      status: '未开始',
      progress: 0,
      sortOrder: spIdx + 1,
    })
  })

  // —— Pass 2：拓扑排序 + 计算任务日期 —— //
  const taskDates: Record<string, { start: Date; end: Date }> = {}
  const projectStart = new Date(`${projectStartDate}T00:00:00Z`)
  const knownTaskCodes = new Set(allLeaves.map((x) => x.leaf.taskCode!).filter(Boolean))
  const localPreds = (leaf: TemplateNode) =>
    (leaf.predecessors || []).filter((p) => knownTaskCodes.has(p.taskCode))

  const remaining = new Set(knownTaskCodes)
  let safety = 0
  while (remaining.size > 0 && safety < 100) {
    safety++
    const ready = allLeaves.filter(({ leaf }) => {
      if (!leaf.taskCode || !remaining.has(leaf.taskCode)) return false
      return localPreds(leaf).every((p) => taskDates[p.taskCode])
    })
    if (ready.length === 0) {
      console.error('Cycle or unresolvable predecessor in template')
      break
    }
    ready.forEach(({ leaf }) => {
      const preds = localPreds(leaf)
      let earliestStart = projectStart
      preds.forEach((p) => {
        const d = taskDates[p.taskCode]
        const candidate = addDays(d.end, p.lagDays || 0)
        if (candidate > earliestStart) earliestStart = candidate
      })
      const stageOffset = STAGE_EARLIEST_DAY[leaf.stage as Stage] ?? 0
      const stageEarliest = addDays(projectStart, stageOffset)
      if (stageEarliest > earliestStart) earliestStart = stageEarliest

      const durDays = leaf.isMilestone ? 0 : (leaf.defaultDuration || 0)
      const end = addDays(earliestStart, Math.max(durDays, 0))
      taskDates[leaf.taskCode!] = { start: earliestStart, end }
      remaining.delete(leaf.taskCode!)
    })
  }

  // —— Pass 3：从模板生成 Task 实例 —— //
  const ownerOfLeaf = (leaf: TemplateNode): string => {
    if (leaf.defaultRole && ownerByRole[leaf.defaultRole]) return ownerByRole[leaf.defaultRole]
    return fallbackOwnerId
  }

  const statusFor = (start: Date, end: Date, isMilestone: boolean): TaskStatus => {
    if (isMilestone) {
      if (end < nowUTC) return '已验证'
      return '未开始'
    }
    if (end < nowUTC) return '已完成'
    if (start <= nowUTC && end >= nowUTC) return '进行中'
    return '未开始'
  }

  const progressFor = (status: TaskStatus, start: Date, end: Date): number => {
    if (status === '已完成' || status === '已验证') return 100
    if (status === '进行中') {
      const total = Math.max(1, end.getTime() - start.getTime())
      const past = nowUTC.getTime() - start.getTime()
      return Math.max(0, Math.min(99, Math.round((past / total) * 100)))
    }
    return 0
  }

  allLeaves.forEach(({ leaf, subProjectIdx }) => {
    const dates = taskDates[leaf.taskCode!] || { start: projectStart, end: projectStart }
    const status = statusFor(dates.start, dates.end, !!leaf.isMilestone)
    const sp = template.children![subProjectIdx]
    const prog = progressFor(status, dates.start, dates.end)
    // 演示用：实际花费按进度比例从成本预算推算（已开始的任务才计花费）
    const actualCost = leaf.costBudget != null && prog > 0
      ? Math.round(leaf.costBudget * prog / 100) : undefined

    const t: Task = {
      id: taskIdOf(leaf.taskCode!),
      code: `${projectCode}-${leaf.taskCode}`,
      name: leaf.name,
      subProjectId: subProjectIdOf(sp.id),
      ownerId: ownerOfLeaf(leaf),
      status,
      priority: leaf.isCriticalPath ? '高' : '中',
      plannedStart: formatDate(dates.start),
      plannedEnd: formatDate(dates.end),
      estimatedEffort: leaf.defaultEffort || 0,
      costBudget: leaf.costBudget,
      actualCost,
      progress: prog,
      isMilestone: !!leaf.isMilestone,
      isCriticalPath: !!leaf.isCriticalPath,
      notes: [
        leaf.description ? `描述：${leaf.description}` : null,
        leaf.ctdSection ? `CTD：${leaf.ctdSection}` : null,
        leaf.regulatoryRef ? `监管：${leaf.regulatoryRef}` : null,
        leaf.output ? `输出物：${leaf.output}` : null,
        leaf.milestoneLabel ? `里程碑：${leaf.milestoneLabel}` : null,
      ].filter(Boolean).join(' · ') || undefined,
    }
    if (status === '已完成' || status === '已验证') {
      t.actualStart = formatDate(dates.start)
      t.actualEnd = formatDate(dates.end)
      t.actualEffort = leaf.defaultEffort || 0
    } else if (status === '进行中') {
      t.actualStart = formatDate(dates.start)
    }
    tasks.push(t)
  })

  // —— Pass 4：生成依赖 —— //
  let depCounter = 0
  allLeaves.forEach(({ leaf }) => {
    localPreds(leaf).forEach((pred) => {
      depCounter++
      dependencies.push({
        id: `${projectId}-dep-${depCounter}`,
        predecessorId: taskIdOf(pred.taskCode),
        successorId: taskIdOf(leaf.taskCode!),
        type: pred.type,
        lagDays: pred.lagDays || 0,
      })
    })
  })

  // —— Pass 5：根据任务派生子项目进度 —— //
  subProjects.forEach((sp) => {
    const myTasks = tasks.filter((t) => t.subProjectId === sp.id)
    if (myTasks.length === 0) return
    const avgProgress = Math.round(myTasks.reduce((s, t) => s + t.progress, 0) / myTasks.length)
    sp.progress = avgProgress
    if (avgProgress >= 100) sp.status = '已完成'
    else if (avgProgress > 0) sp.status = '进行中'
    else sp.status = '未开始'
  })

  return { subProjects, tasks, dependencies }
}

// ============= 项目级汇总 =============

export interface ProjectRollup {
  progress: number
  health: Health
}

/**
 * 由实例化结果派生项目级 progress / health。
 *   progress = 全部任务平均进度
 *   health   = 有逾期里程碑 → red；有逾期任务或临近(≤14d)里程碑 → yellow；否则 green
 */
export function deriveRollup(tasks: Task[], today: Date = new Date()): ProjectRollup {
  if (tasks.length === 0) return { progress: 0, health: 'green' }
  const progress = Math.round(tasks.reduce((s, t) => s + t.progress, 0) / tasks.length)
  const nowUTC = floorUTCDate(today)

  const isDone = (t: Task) => t.status === '已完成' || t.status === '已验证'
  const overdueMilestone = tasks.some(
    (t) => t.isMilestone && !isDone(t) && new Date(t.plannedEnd) < nowUTC,
  )
  const overdueTask = tasks.some(
    (t) => !t.isMilestone && !isDone(t) && t.progress < 100 && new Date(t.plannedEnd) < nowUTC,
  )
  const nearMilestone = tasks.some((t) => {
    if (!t.isMilestone || isDone(t)) return false
    const days = Math.ceil((new Date(t.plannedEnd).getTime() - nowUTC.getTime()) / DAY_MS)
    return days >= 0 && days <= 14
  })

  let health: Health = 'green'
  if (overdueMilestone) health = 'red'
  else if (overdueTask || nearMilestone) health = 'yellow'
  return { progress, health }
}
