// 子项目 + 任务 + 依赖 — Lite 版
//
// 当前数据完全由 instantiateTemplate() 函数从 DMP 模板生成 —
// 这意味着每个项目的任务结构 100% 镜像模板（33 任务 + 25 依赖 + 6 里程碑 + 11 关键路径）。
//
// 项目实例化算法：
//   1. 模板根 (root)         → 项目 (Project, 在 projects.ts 中)
//   2. 模板 L2 子项目         → SubProject（每个项目 2 个：USP + DSP）
//   3. 模板 L3 任务           → Task（同样的 taskCode、name、isMilestone、isCriticalPath、defaultRole 等）
//   4. 模板 predecessors[]   → TaskDependency（FS / lag）
//   5. 任务日期：基于 projectStart + 拓扑排序的最早开始时间 + defaultDuration 计算
//   6. 任务状态：根据 plannedEnd vs today 自动派生

import type {
  Stage, SubProject, Task, TaskDependency, TaskStatus, TemplateNode,
} from '../types'
import { dmpDrugSubstanceStructure } from './templates-dmp'
import { projects } from './projects'

// 演示快照锚点：整个 Lite 应用统一以此为「今日」，保证示例数据的状态/进度/
// 风险判定确定且自洽（首页、模板实例化均复用此常量）。
export const TODAY = new Date('2026-05-10T00:00:00Z')
const DAY_MS = 86400000

const formatDate = (d: Date): string => d.toISOString().slice(0, 10)
const addDays = (d: Date, days: number): Date => new Date(d.getTime() + days * DAY_MS)

// 阶段 → 项目启动后第几天可以最早开始
// （用于补偿"跨模块前驱不在 33 任务里"的问题：例如 DSP-011 在 DMP 里依赖 PC-001，
// 但 PC 模块尚未导入；用此下限保证 Ph3 任务自然落到项目后期。）
const STAGE_EARLIEST_DAY: Record<Stage, number> = {
  '临床前': 0,
  'IND': 360,
  'Ph1/2': 540,
  'Ph3': 720,
  'BLA': 900,
  '商业化': 1080,
  '上市后': 1260,
}

// ============= 实例化函数 =============

interface InstantiationOptions {
  projectId: string
  projectCode: string
  /** 项目计划开始日期，作为所有任务日期推算的基准 */
  projectStartDate: string  // YYYY-MM-DD
  /** 默认负责角色 → 用户 ID 的映射 */
  ownerByRole: Record<string, string>
  /** 项目负责人 ID，作为兜底 */
  fallbackOwnerId: string
}

interface InstantiationResult {
  subProjects: SubProject[]
  tasks: Task[]
  dependencies: TaskDependency[]
}

function instantiateTemplate(
  template: TemplateNode,
  opts: InstantiationOptions,
): InstantiationResult {
  const { projectId, projectCode, projectStartDate, ownerByRole, fallbackOwnerId } = opts

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
      // 下限 1：本地前驱链最晚结束时间
      let earliestStart = projectStart
      preds.forEach((p) => {
        const d = taskDates[p.taskCode]
        const candidate = addDays(d.end, p.lagDays || 0)
        if (candidate > earliestStart) earliestStart = candidate
      })
      // 下限 2：阶段最早开始时间（弥补跨模块前驱缺失）
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
      if (end < TODAY) return '已验证'
      return '未开始'
    }
    if (end < TODAY) return '已完成'
    if (start <= TODAY && end >= TODAY) return '进行中'
    return '未开始'
  }

  const progressFor = (status: TaskStatus, start: Date, end: Date): number => {
    if (status === '已完成' || status === '已验证') return 100
    if (status === '进行中') {
      const total = Math.max(1, end.getTime() - start.getTime())
      const past = TODAY.getTime() - start.getTime()
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

// ============= 实例化所有项目 =============

// P1: 刘上游 / 吴下游
const inst1 = instantiateTemplate(dmpDrugSubstanceStructure, {
  projectId: 'p1',
  projectCode: 'MAB-201',
  projectStartDate: projects[0].plannedStart,
  ownerByRole: { '上游': 'u6', '下游': 'u8' },
  fallbackOwnerId: 'u3',
})

// P2: 孙上游 / 周下游
const inst2 = instantiateTemplate(dmpDrugSubstanceStructure, {
  projectId: 'p2',
  projectCode: 'MAB-202',
  projectStartDate: projects[1].plannedStart,
  ownerByRole: { '上游': 'u7', '下游': 'u9' },
  fallbackOwnerId: 'u4',
})

// P3: 刘上游 / 周下游（混合配置）
const inst3 = instantiateTemplate(dmpDrugSubstanceStructure, {
  projectId: 'p3',
  projectCode: 'MAB-203',
  projectStartDate: projects[2].plannedStart,
  ownerByRole: { '上游': 'u6', '下游': 'u9' },
  fallbackOwnerId: 'u5',
})

// ============= 导出（合并 3 个项目的实例化结果）=============

export const subProjects: SubProject[] = [
  ...inst1.subProjects,
  ...inst2.subProjects,
  ...inst3.subProjects,
]

export const tasks: Task[] = [
  ...inst1.tasks,
  ...inst2.tasks,
  ...inst3.tasks,
]

export const taskDependencies: TaskDependency[] = [
  ...inst1.dependencies,
  ...inst2.dependencies,
  ...inst3.dependencies,
]
