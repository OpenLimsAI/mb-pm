import { planningApi } from '../api/planning'
import { getWorkingCalendar, setWorkingCalendars, setWeeklyCapacities } from '../lib/workingCalendar'
import type { FullPlanSnapshot } from '../lib/fullPlanBaseline'
// 应用引导 + 数据同步 —— 连接前端与 FastAPI 后端。
//
// 启动：GET /auth/me 确认 IAM 会话（HttpOnly cookie）→ 拉取当前用户可见范围内的全量数据
//       填入 mock 运行时数组 → 渲染。未登录 / 身份不可用由 App 的路由守卫处理。
// 连不上后端（仅本地开发）：回退到内置 mock 数据（离线只读）。
//
// Mutations（创建项目 / 录入任务进展）：API 模式走后端并重新同步；mock 模式本地更新。

import { api, USE_API, asAPIError } from '../api/client'
import * as projectsApi from '../api/projects'
import * as subProjectsApi from '../api/subProjects'
import * as tasksApi from '../api/tasks'
import * as taskDependenciesApi from '../api/taskDependencies'
import * as templatesApi from '../api/templates'
import * as usersApi from '../api/users'
import * as financesApi from '../api/finances'
import * as baselinesApi from '../api/baselines'
import { projects } from '../mock/projects'
import { subProjects, tasks, taskDependencies } from '../mock/tasks'
import { users } from '../mock/users'
import { projectFinances, type ProjectFinance } from '../mock/finance'
import { projectBaselines } from '../mock/baselines'
import { useTemplatesStore } from '../store/templates'
import { useAuth } from '../store/auth'
import { useDataStore } from '../store/data'
import { hydrateCreatedIntoMock, useProjectsStore, type ProjectBundle } from '../store/projects'
import { deriveRollup } from '../lib/instantiate'
import { calculateProgress } from '../lib/progress'
import { diffPredecessors } from '../lib/dependency-utils'
import { TODAY, getProjectSpan } from '../mock'
import { includeAssignees, teamIds } from '../lib/projectTeam'
import type { Priority, ProductType, Project, ProjectBaseline, SubProject, Task, TaskDependency, TaskStatus, Template, TemplateNode, TemplateVersion, User } from '../types'

function replaceArray<T>(target: T[], items: T[]): void {
  target.length = 0
  for (const it of items) target.push(it)
}

/** 从后端拉取全量数据，覆盖 mock 运行时数组，并 bump 版本。 */
/** 把可能为字符串的数值字段强制转回 number。
 *  后端 Decimal 字段（estimatedEffort / actualEffort / costBudget）经 JSON 序列化
 *  会变成字符串（如 "40.00"），若直接参与求和会发生字符串拼接 → NaN。
 *  在数据入口统一归一，使 Task 的 number 类型契约成立（mock 模式本就是 number，无副作用）。 */
const toNum = (v: unknown): number | undefined => {
  if (v === null || v === undefined || v === '') return undefined
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isNaN(n) ? undefined : n
}
function normalizeApiTask(t: Task): Task {
  return {
    ...t,
    estimatedEffort: toNum(t.estimatedEffort) ?? 0,
    progressWeight: t.progressWeight == null ? null : toNum(t.progressWeight) ?? null,
    actualEffort: toNum(t.actualEffort),
    costBudget: toNum(t.costBudget),
    actualCost: toNum(t.actualCost),
  }
}

let refreshGeneration = 0
export async function refreshAllData(): Promise<void> {
  const generation = ++refreshGeneration
  useDataStore.setState({ syncing: true, syncError: null })
  try {
    const [projPage, subs, taskPage, deps, tmpls, usrs, fins, bls, calendars, capacities, context] = await Promise.all([
      projectsApi.listProjects({ pageSize: 500 }),
      subProjectsApi.listSubProjects({}),
      tasksApi.listTasks({ pageSize: 5000 }),
      taskDependenciesApi.listTaskDependencies({}),
      templatesApi.listTemplates({}),
      usersApi.listUsers({}),
      financesApi.listFinances(),
      baselinesApi.listBaselines(),
      planningApi.calendars(),
      ['admin', 'cmc_lead', 'project_lead'].includes(useAuth.getState().currentUser?.role ?? '') ? planningApi.capacities() : Promise.resolve([]),
      api.get<{ businessDate: string; timezone: string }>('/pm/context').then(r => r.data),
    ])
    if (generation !== refreshGeneration) return
    TODAY.setTime(new Date(`${context.businessDate}T00:00:00`).getTime())
    useDataStore.setState({ businessDate: context.businessDate, businessTimezone: context.timezone })
    setWorkingCalendars(calendars)
    setWeeklyCapacities(capacities)
    replaceArray(projects, projPage.items as unknown as Project[])
    replaceArray(subProjects, subs as unknown as SubProject[])
    replaceArray(tasks, (taskPage.items as unknown as Task[]).map(normalizeApiTask))
    replaceArray(taskDependencies, deps as unknown as TaskDependency[])
    replaceArray(users, usrs as unknown as User[])
    replaceArray(projectFinances, fins as unknown as ProjectFinance[])
    replaceArray(projectBaselines, bls as unknown as ProjectBaseline[])
    useTemplatesStore.setState({ templates: tmpls as unknown as Template[] })
    useDataStore.getState().bump()
    useDataStore.setState({ lastSyncedAt: new Date().toISOString() })
  } catch (e) { if (generation === refreshGeneration) useDataStore.setState({ syncError: asAPIError(e).detail }); throw e }
  finally { if (generation === refreshGeneration) useDataStore.setState({ syncing: false }) }
}

let _started = false
/** 当前运行时数据是按哪个身份（id:role）加载的 —— 身份变化时须整页重载。 */
let _loadedFor: string | null = null

const identityKey = (u: User | null) => (u ? `${u.id}:${u.role}` : null)

/** 离线演示：以郭主任（CMC 负责人 / 全局视图）身份浏览内置 mock 数据，无需登录。 */
function enterOfflineMode(notice: string | null): void {
  hydrateCreatedIntoMock() // 离线：复用本地持久化的新建项目
  syncOfflineSpent() // 与后端同一规则：已花费 = 任务实际花费合计
  includeAssignees(projects) // 与后端同一规则：有任务的人在项目团队中
  const cto = users.find((u) => u.id === 'u2') ?? users[0]
  useAuth.setState({ currentUser: cto, status: 'offline', error: null })
  const ds = useDataStore.getState()
  ds.setMode('mock')
  ds.setNotice(notice)
  ds.setReady(true)
}

/** 应用首屏引导（幂等，StrictMode 双调用安全）。 */
export async function bootstrap(): Promise<void> {
  if (_started) return
  _started = true

  if (!USE_API) {
    enterOfflineMode(null)
    return
  }

  // 鉴权门：先向后端确认 IAM 会话，未登录不拉任何业务数据。
  await useAuth.getState().refresh()
  const { status, currentUser } = useAuth.getState()
  if (status === 'offline') {
    console.warn('[bootstrap] 后端不可用，回退到离线 mock 数据')
    enterOfflineMode('后端未连接 —— 当前为离线只读演示数据。启动后端后刷新即可持久化。')
    return
  }
  if (status !== 'ready' || useAuth.getState().mustChangePassword) {
    // 未登录（守卫跳 /login）、身份不可用（守卫展示原因）或须先改临时密码（守卫显示改密页）：
    // 不拉业务数据，允许之后重新引导。
    _started = false
    return
  }

  try {
    await refreshAllData()
    _loadedFor = identityKey(currentUser)
    const ds = useDataStore.getState()
    ds.setMode('api')
    ds.setReady(true)
  } catch (e) {
    _started = false
    const { status: code, detail } = asAPIError(e)
    // 401 已由拦截器转为未登录态；其他错误交给守卫展示。
    if (code !== 401) useAuth.setState({ status: 'error', error: `数据加载失败：${detail}` })
  }
}

/**
 * 窗口重新获得焦点时复核 IAM 会话：过期 → 未登录态（守卫跳登录页）；
 * 已换成别的账号 / 角色 → 整页重载，避免残留上一身份可见范围内的数据。返回取消监听函数。
 */
export function watchIdentity(): () => void {
  const onFocus = () => {
    if (useDataStore.getState().mode !== 'api') return
    void useAuth.getState().refresh().then(() => {
      const { status, currentUser } = useAuth.getState()
      if (status === 'ready' && identityKey(currentUser) !== _loadedFor) window.location.reload()
      else if (status === 'ready' && !useDataStore.getState().syncing && !document.hidden) void refreshAllData().catch(() => { /* syncError remains visible */ })
    })
  }
  window.addEventListener('focus', onFocus)
  const timer = window.setInterval(() => {
    if (!document.hidden && useDataStore.getState().mode === 'api' && !useDataStore.getState().syncing && useAuth.getState().status === 'ready') void refreshAllData().catch(() => {})
  }, 60_000)
  return () => { window.removeEventListener('focus', onFocus); window.clearInterval(timer) }
}

// ============= Mutations =============

/**
 * 删除项目（仅 API 模式，后端限 admin / cmc_lead）：后端级联删除子项目 / 任务 / 依赖 /
 * 团队关联 / 财务 / 基线，随后整体重新同步。离线演示数据不支持删除。
 */
export async function deleteProjectEntry(projectId: string): Promise<void> {
  if (useDataStore.getState().mode !== 'api') throw new Error('离线演示数据不支持删除项目')
  await projectsApi.deleteProject(projectId)
  await refreshAllData()
}

/** 创建项目（API：整包写后端 + 重新同步；mock：本地持久化）。返回新项目 id。 */
export async function createProjectBundle(bundle: ProjectBundle): Promise<string> {
  if (useDataStore.getState().mode === 'api') {
    const dto = await projectsApi.importProject({
      project: { ...bundle.project, memberIds: bundle.project.memberIds ?? [] } as never,
      subProjects: bundle.subProjects as never,
      tasks: bundle.tasks as never,
      dependencies: bundle.dependencies as never,
      finance: bundle.finance as never,
    })
    await refreshAllData()
    return dto.id
  }
  useProjectsStore.getState().createProject(bundle)
  syncOfflineSpent(bundle.project.id)
  useDataStore.getState().bump()
  return bundle.project.id
}

/**
 * 设置 / 修改项目预算（admin / cmc_lead）：总预算、已承诺、成本结构、财年、备注。
 * 已花费不在此维护 —— 始终是任务实际花费合计。API：PUT 后重新同步；离线：改运行时数组。
 */
export async function updateProjectFinanceEntry(projectId: string, input: financesApi.ProjectFinanceInput): Promise<void> {
  if (useDataStore.getState().mode === 'api') {
    await financesApi.updateFinance(projectId, input)
    await refreshAllData()
    return
  }
  const entry: ProjectFinance = {
    projectId,
    totalBudget: input.totalBudget,
    spent: 0,
    committed: input.committed,
    breakdown: input.breakdown as ProjectFinance['breakdown'],
    fiscalYear: input.fiscalYear,
    notes: input.notes,
  }
  const index = projectFinances.findIndex((f) => f.projectId === projectId)
  if (index >= 0) projectFinances[index] = entry
  else projectFinances.push(entry)
  syncOfflineSpent(projectId)
  useDataStore.getState().bump()
}

/** 离线演示：按运行时任务重算项目的已花费 / 任务预算合计（API 模式由后端汇总，不走这里）。 */
function syncOfflineSpent(projectId?: string): void {
  for (const f of projectFinances) {
    if (projectId && f.projectId !== projectId) continue
    const subIds = new Set(subProjects.filter((s) => s.projectId === f.projectId).map((s) => s.id))
    const projTasks = tasks.filter((t) => subIds.has(t.subProjectId))
    f.spent = Math.round(projTasks.reduce((a, t) => a + (t.actualCost ?? 0), 0) * 100) / 100
    f.taskBudget = Math.round(projTasks.reduce((a, t) => a + (t.costBudget ?? 0), 0) * 100) / 100
  }
}

export interface TaskProgressPatch {
  expectedRevision?: number
  progressNote?: string
  status?: TaskStatus
  progress?: number
  ownerId?: string
  costBudget?: number | null
  actualCost?: number | null
  plannedStart?: string
  plannedEnd?: string
  actualStart?: string | null
  actualEnd?: string | null
  actualEffort?: number | null
}

/** 录入任务进展（API：PATCH + 后端汇总 + 重新同步；mock：本地更新 + 客户端汇总）。 */
export async function updateTaskProgress(taskId: string, patch: TaskProgressPatch): Promise<void> {
  if (useDataStore.getState().mode === 'api') {
    await tasksApi.updateTask(taskId, { ...patch, expectedRevision: patch.expectedRevision ?? tasks.find(t => t.id === taskId)?.revision } as never)
    await refreshAllData()
    return
  }
  applyLocalTaskUpdate(taskId, patch)
  useDataStore.getState().bump()
}

export interface BatchUpdateResult {
  updated: number
  failed: { taskId: string; detail: string }[]
}

/**
 * 批量更新任务（全局任务页的批量改状态 / 改负责人）。
 * API：逐条 PATCH（每条都会在后端汇总项目进度，串行避免并发汇总互相覆盖），单条失败不中断，
 * 全部完成后统一重新同步一次；mock：本地更新 + 汇总。
 */
export async function updateTasksBatch(taskIds: string[], patch: TaskProgressPatch): Promise<BatchUpdateResult> {
  const failed: BatchUpdateResult['failed'] = []
  if (useDataStore.getState().mode === 'api') {
    for (const id of taskIds) {
      try {
        await tasksApi.updateTask(id, { ...patch, expectedRevision: tasks.find(t => t.id === id)?.revision } as never)
      } catch (e) {
        failed.push({ taskId: id, detail: asAPIError(e).detail })
      }
    }
    await refreshAllData()
  } else {
    for (const id of taskIds) applyLocalTaskUpdate(id, patch)
    useDataStore.getState().bump()
  }
  return { updated: taskIds.length - failed.length, failed }
}

/** 离线 mock 模式：本地更新任务并向上汇总子项目 + 项目进度。 */
function applyLocalTaskUpdate(taskId: string, patch: TaskProgressPatch): void {
  const t = tasks.find((x) => x.id === taskId)
  if (!t) return
  Object.assign(t, patch)
  recomputeRollupForSub(t.subProjectId)
}

/** 离线 mock 模式：重算某子项目进度/状态，并上卷到项目进度/健康度。 */
function recomputeRollupForSub(subProjectId: string): void {
  const sub = subProjects.find((s) => s.id === subProjectId)
  if (!sub) return
  const proj = projects.find((p) => p.id === sub.projectId)
  const subTasks = tasks.filter((x) => x.subProjectId === sub.id)
  sub.progress = calculateProgress(subTasks, proj?.progressMethod)
  sub.status = sub.progress >= 100 ? '已完成' : sub.progress > 0 ? '进行中' : '未开始'

  if (!proj) return
  const projSubIds = new Set(subProjects.filter((s) => s.projectId === proj.id).map((s) => s.id))
  const projTasks = tasks.filter((x) => projSubIds.has(x.subProjectId))
  proj.progress = calculateProgress(projTasks, proj.progressMethod)
  proj.health = deriveRollup(projTasks, TODAY, proj.progressMethod).health
  syncOfflineSpent(proj.id)
}

// ============= 里程碑设置（新建 / 编辑 / 删除 + 关联任务） =============
//
// 里程碑 = Task(isMilestone)；「达成条件任务」= 以该里程碑为 successor 的 FS 依赖前驱。
// 三个编排函数同时支持 API 模式（调后端 + refreshAllData）与离线 mock 模式（改运行时数组 + 汇总 + bump）。

export interface MilestoneBasics {
  name: string
  /** 计划达成日（里程碑工期=0，plannedStart 同步为此值）。 */
  plannedEnd: string
  priority?: Priority
  notes?: string | null
}

/** 在项目内生成下一个里程碑编号：{项目code}-MIL-NN。 */
function nextMilestoneCode(projectId: string): string {
  const proj = projects.find((p) => p.id === projectId)
  const prefix = `${proj?.code ?? 'PRJ'}-MIL-`
  const subIds = new Set(subProjects.filter((s) => s.projectId === projectId).map((s) => s.id))
  const nums = tasks
    .filter((t) => subIds.has(t.subProjectId) && t.code.startsWith(prefix))
    .map((t) => parseInt(t.code.slice(prefix.length), 10))
    .filter((n) => !Number.isNaN(n))
  const next = (nums.length ? Math.max(...nums) : 0) + 1
  return `${prefix}${String(next).padStart(2, '0')}`
}

/** 新建里程碑并建立其前驱依赖（达成条件任务）。返回新里程碑 id。 */
export async function createMilestoneWithDeps(input: {
  projectId: string
  subProjectId: string
  basics: MilestoneBasics
  predecessorIds: string[]
}): Promise<string> {
  const { projectId, subProjectId, basics, predecessorIds } = input
  const proj = projects.find((p) => p.id === projectId)
  const sub = subProjects.find((s) => s.id === subProjectId)
  // 任务只能派给项目团队成员：子项目负责人不在团队时由项目负责人承担
  const ownerId = (sub?.ownerId && proj && teamIds(proj).has(sub.ownerId) ? sub.ownerId : proj?.ownerId) || ''
  const code = nextMilestoneCode(projectId)

  const draft = {
    code,
    name: basics.name,
    subProjectId,
    ownerId,
    collaboratorIds: null,
    status: '未开始' as TaskStatus,
    priority: basics.priority ?? '中',
    plannedStart: basics.plannedEnd,
    plannedEnd: basics.plannedEnd,
    actualStart: null,
    actualEnd: null,
    estimatedEffort: 0,
    actualEffort: null,
    progress: 0,
    isMilestone: true,
    isCriticalPath: false,
    notes: basics.notes ?? null,
    tags: null,
  }

  if (useDataStore.getState().mode === 'api') {
    const dto = await tasksApi.createTask(draft as never)
    for (const predId of predecessorIds) {
      await taskDependenciesApi.createTaskDependency({ predecessorId: predId, successorId: dto.id })
    }
    await refreshAllData()
    return dto.id
  }

  const id = `tk-${Math.round(progressNonce())}`
  tasks.push({ id, ...draft } as unknown as Task)
  for (const predId of predecessorIds) {
    taskDependencies.push({
      id: `dep-${Math.round(progressNonce())}`,
      predecessorId: predId,
      successorId: id,
      type: 'FS',
      lagDays: 0,
    })
  }
  recomputeRollupForSub(subProjectId)
  useDataStore.getState().bump()
  return id
}

/** 编辑里程碑基本信息 + 调整其前驱依赖（增删差异）。 */
export async function updateMilestoneWithDeps(
  milestoneId: string,
  basics: Partial<MilestoneBasics>,
  predecessorIds: string[],
): Promise<void> {
  const current = taskDependencies.filter((d) => d.successorId === milestoneId)
  const { addedIds, removedDepIds } = diffPredecessors(current, predecessorIds)

  // 里程碑工期=0：plannedEnd 变更时同步 plannedStart
  const basicsPatch: Record<string, unknown> = { ...basics }
  if (basics.plannedEnd) basicsPatch.plannedStart = basics.plannedEnd

  if (useDataStore.getState().mode === 'api') {
    if (Object.keys(basicsPatch).length > 0) {
      await tasksApi.updateTask(milestoneId, { ...basicsPatch, expectedRevision: tasks.find(t => t.id === milestoneId)?.revision } as never)
    }
    for (const depId of removedDepIds) await taskDependenciesApi.deleteTaskDependency(depId)
    for (const predId of addedIds) {
      await taskDependenciesApi.createTaskDependency({ predecessorId: predId, successorId: milestoneId })
    }
    await refreshAllData()
    return
  }

  const ms = tasks.find((t) => t.id === milestoneId)
  if (ms) Object.assign(ms, basicsPatch)
  // 删除差异依赖
  for (const depId of removedDepIds) {
    const idx = taskDependencies.findIndex((d) => d.id === depId)
    if (idx >= 0) taskDependencies.splice(idx, 1)
  }
  // 新增依赖
  for (const predId of addedIds) {
    taskDependencies.push({
      id: `dep-${Math.round(progressNonce())}`,
      predecessorId: predId,
      successorId: milestoneId,
      type: 'FS',
      lagDays: 0,
    })
  }
  if (ms) recomputeRollupForSub(ms.subProjectId)
  useDataStore.getState().bump()
}

/** 删除里程碑（先级联清理其全部相关依赖，避免孤儿）。返回受影响依赖数。 */
export async function deleteMilestoneWithDeps(milestoneId: string): Promise<number> {
  const related = taskDependencies.filter(
    (d) => d.successorId === milestoneId || d.predecessorId === milestoneId,
  )
  const ms = tasks.find((t) => t.id === milestoneId)
  const subId = ms?.subProjectId

  if (useDataStore.getState().mode === 'api') {
    for (const d of related) await taskDependenciesApi.deleteTaskDependency(d.id)
    await tasksApi.deleteTask(milestoneId)
    await refreshAllData()
    return related.length
  }

  const relatedIds = new Set(related.map((d) => d.id))
  for (let i = taskDependencies.length - 1; i >= 0; i--) {
    if (relatedIds.has(taskDependencies[i].id)) taskDependencies.splice(i, 1)
  }
  const ti = tasks.findIndex((t) => t.id === milestoneId)
  if (ti >= 0) tasks.splice(ti, 1)
  if (subId) recomputeRollupForSub(subId)
  useDataStore.getState().bump()
  return related.length
}

// ============= 项目成员 =============

/** 全量替换项目团队成员（负责人由后端自动排除，不计入成员）。 */
export async function updateProjectMembers(projectId: string, memberIds: string[]): Promise<void> {
  if (useDataStore.getState().mode === 'api') {
    await projectsApi.replaceProjectMembers(projectId, memberIds)
    await refreshAllData()
    return
  }
  const proj = projects.find((p) => p.id === projectId)
  if (proj) proj.memberIds = [...new Set(memberIds)].filter((id) => id !== proj.ownerId)
  useDataStore.getState().bump()
}

// ============= 模板 =============

/** 新建研发流程模板（空白起步或复制现有结构）。返回新模板 id。 */
export async function createTemplateEntry(input: {
  name: string
  productType: ProductType
  description: string
  initialStructure: TemplateNode
}): Promise<string> {
  const createdBy = useAuth.getState().currentUser?.id ?? ''
  if (useDataStore.getState().mode === 'api') {
    const dto = await templatesApi.createTemplate({
      name: input.name,
      productType: input.productType,
      description: input.description,
      isActive: true,
      initialStructure: input.initialStructure as unknown as Record<string, unknown>,
    })
    await refreshAllData()
    return dto.id
  }
  // 离线 mock：写入模板 store（自带 persist），Templates 页订阅 store 自动刷新。
  const tmpl = useTemplatesStore.getState().createTemplate({
    name: input.name,
    productType: input.productType,
    description: input.description,
    initialStructure: input.initialStructure,
    createdBy,
  })
  return tmpl.id
}

/** 删除模板（API：DELETE + 重新同步；离线 mock：从模板 store 移除）。 */
export async function deleteTemplateEntry(id: string): Promise<void> {
  if (useDataStore.getState().mode === 'api') {
    await templatesApi.deleteTemplate(id)
    await refreshAllData()
    return
  }
  useTemplatesStore.getState().deleteTemplate(id)
}

// ============= 计划基线 =============

/** 离线 mock：按当前运行时数据构建项目计划快照（与后端 _build_snapshot 同构）。 */
function buildSnapshotFromRuntime(projectId: string): FullPlanSnapshot {
  const proj = projects.find((p) => p.id === projectId)
  const subIds = new Set(subProjects.filter((s) => s.projectId === projectId).map((s) => s.id))
  const projTasks = tasks.filter((t) => subIds.has(t.subProjectId))
  const taskIds = new Set(projTasks.map(t => t.id))
  const fin = projectFinances.find((f) => f.projectId === projectId)
  const milestones = projTasks
    .filter((t) => t.isMilestone)
    .map((t) => ({
      id: t.id, code: t.code, name: t.name,
      plannedStart: t.plannedStart, plannedEnd: t.plannedEnd,
      isCriticalPath: t.isCriticalPath,
    }))
    .sort((a, b) => a.plannedEnd.localeCompare(b.plannedEnd))
  const span = proj ? getProjectSpan(proj) : null  // 与后端一致：按任务实时派生
  return {
    schemaVersion: 3,
    projectPlannedStart: span?.start ?? '',
    projectPlannedEnd: span?.end ?? '',
    progress: proj?.progress ?? 0,
    progressMethod: proj?.progressMethod ?? 'equal',
    totalBudget: fin?.totalBudget ?? 0,
    taskCount: projTasks.length,
    milestoneCount: milestones.length,
    milestones,
    tasks: projTasks.map(t => ({ id: t.id, code: t.code, name: t.name, subProjectId: t.subProjectId,
      plannedStart: t.plannedStart, plannedEnd: t.plannedEnd, ownerId: t.ownerId,
      collaboratorIds: [...t.collaboratorIds ?? []], estimatedEffort: t.estimatedEffort,
      costBudget: t.costBudget, progressWeight: t.progressWeight ?? null,
      isMilestone: t.isMilestone, isCriticalPath: t.isCriticalPath })),
    dependencies: taskDependencies.filter(d => taskIds.has(d.predecessorId) && taskIds.has(d.successorId)).map(d => ({ ...d })),
    calendar: structuredClone(getWorkingCalendar(projectId)),
  }
}

/** 设立基线（API：后端按当前 DB 构建快照 + 重新同步；离线 mock：本地构建快照）。返回基线 id。 */
export async function createProjectBaseline(projectId: string, label: string, reason: string): Promise<string> {
  if (useDataStore.getState().mode === 'api') {
    const dto = await baselinesApi.createBaseline({ projectId, label, reason: reason || null })
    await refreshAllData()
    return dto.id
  }
  const id = `bl-${Math.round(progressNonce())}`
  projectBaselines.unshift({
    id, projectId, label, reason: reason || null,
    snapshot: buildSnapshotFromRuntime(projectId),
    createdBy: useAuth.getState().currentUser?.id ?? null,
    createdAt: new Date().toISOString(),
  })
  useDataStore.getState().bump()
  return id
}

/** 删除基线。 */
export async function deleteProjectBaseline(id: string): Promise<void> {
  if (useDataStore.getState().mode === 'api') {
    await baselinesApi.deleteBaseline(id)
    await refreshAllData()
    return
  }
  const idx = projectBaselines.findIndex((b) => b.id === id)
  if (idx >= 0) projectBaselines.splice(idx, 1)
  useDataStore.getState().bump()
}

/** 保存模板结构为新版本（API：POST versions + 重新同步；离线 mock：store.addVersion）。 */
export async function saveTemplateStructure(
  templateId: string,
  structure: TemplateNode,
  versionNumber: string,
  changeSummary: string,
): Promise<void> {
  if (useDataStore.getState().mode === 'api') {
    await templatesApi.addTemplateVersion(templateId, {
      versionNumber,
      structureJson: structure as unknown as Record<string, unknown>,
      changeSummary,
      changeSource: 'visual_edit',
    })
    await refreshAllData()
    return
  }
  const version: Omit<TemplateVersion, 'isCurrent'> = {
    id: `v-${Math.round(progressNonce())}`,
    templateId,
    versionNumber,
    structureJson: structure,
    changeSummary,
    changeSource: 'visual_edit',
    modifiedBy: useAuth.getState().currentUser?.id ?? '',
    modifiedAt: new Date().toISOString(),
  }
  useTemplatesStore.getState().addVersion(templateId, version)
}

// 离线 mock 模式下生成唯一 id 用的递增计数器。
let _nonce = 1
function progressNonce(): number {
  _nonce += 1
  return Date.now() + _nonce
}
