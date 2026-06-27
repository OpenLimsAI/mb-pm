// 应用引导 + 数据同步 —— 连接前端与 FastAPI 后端。
//
// 启动：以 CTO（郭主任）身份登录后端拿 JWT → 拉取全量数据填入 mock 运行时数组 → 渲染。
// 失败：回退到内置 mock 数据（离线只读）。
//
// Mutations（创建项目 / 录入任务进展）：API 模式走后端并重新同步；mock 模式本地更新。

import { USE_API, setToken } from '../api/client'
import * as authApi from '../api/auth'
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
import { diffPredecessors } from '../lib/dependency-utils'
import { TODAY } from '../mock'
import type { BaselineSnapshot, Priority, ProductType, Project, ProjectBaseline, Role, SpecialtyGroup, SubProject, Task, TaskDependency, TaskStatus, Template, TemplateNode, TemplateVersion, User } from '../types'

const CTO_USERNAME = 'guo.cmc'

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
    actualEffort: toNum(t.actualEffort),
    costBudget: toNum(t.costBudget),
  }
}

export async function refreshAllData(): Promise<void> {
  const [projPage, subs, taskPage, deps, tmpls, usrs, fins, bls] = await Promise.all([
    projectsApi.listProjects({ pageSize: 500 }),
    subProjectsApi.listSubProjects({}),
    tasksApi.listTasks({ pageSize: 5000 }),
    taskDependenciesApi.listTaskDependencies({}),
    templatesApi.listTemplates({}),
    usersApi.listUsers({}),
    financesApi.listFinances(),
    baselinesApi.listBaselines(),
  ])
  replaceArray(projects, projPage.items as unknown as Project[])
  replaceArray(subProjects, subs as unknown as SubProject[])
  replaceArray(tasks, (taskPage.items as unknown as Task[]).map(normalizeApiTask))
  replaceArray(taskDependencies, deps as unknown as TaskDependency[])
  replaceArray(users, usrs as unknown as User[])
  replaceArray(projectFinances, fins as unknown as ProjectFinance[])
  replaceArray(projectBaselines, bls as unknown as ProjectBaseline[])
  useTemplatesStore.setState({ templates: tmpls as unknown as Template[] })
  useDataStore.getState().bump()
}

let _started = false

/** 应用首屏引导（幂等，StrictMode 双调用安全）。 */
export async function bootstrap(): Promise<void> {
  if (_started) return
  _started = true
  const ds = useDataStore.getState()

  if (!USE_API) {
    hydrateCreatedIntoMock() // 离线：复用本地持久化的新建项目
    ds.setMode('mock')
    ds.setReady(true)
    return
  }

  try {
    const tok = await authApi.login({ username: CTO_USERNAME })
    setToken(tok.accessToken)
    useAuth.setState({ currentUser: tok.user as unknown as User })
    await refreshAllData()
    ds.setMode('api')
    ds.setReady(true)
  } catch (e) {
    console.warn('[bootstrap] 后端不可用，回退到离线 mock 数据：', e)
    hydrateCreatedIntoMock()
    ds.setMode('mock')
    ds.setNotice('后端未连接 —— 当前为离线只读演示数据。启动后端后刷新即可持久化。')
    ds.setReady(true)
  }
}

// ============= Mutations =============

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
  useDataStore.getState().bump()
  return bundle.project.id
}

export interface TaskProgressPatch {
  status?: TaskStatus
  progress?: number
  ownerId?: string
  costBudget?: number | null
  plannedStart?: string
  plannedEnd?: string
  actualStart?: string | null
  actualEnd?: string | null
  actualEffort?: number | null
}

/** 录入任务进展（API：PATCH + 后端汇总 + 重新同步；mock：本地更新 + 客户端汇总）。 */
export async function updateTaskProgress(taskId: string, patch: TaskProgressPatch): Promise<void> {
  if (useDataStore.getState().mode === 'api') {
    await tasksApi.updateTask(taskId, patch as never)
    await refreshAllData()
    return
  }
  applyLocalTaskUpdate(taskId, patch)
  useDataStore.getState().bump()
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
  const subTasks = tasks.filter((x) => x.subProjectId === sub.id)
  sub.progress = subTasks.length
    ? Math.round(subTasks.reduce((a, x) => a + x.progress, 0) / subTasks.length)
    : 0
  sub.status = sub.progress >= 100 ? '已完成' : sub.progress > 0 ? '进行中' : '未开始'

  const proj = projects.find((p) => p.id === sub.projectId)
  if (!proj) return
  const projSubIds = new Set(subProjects.filter((s) => s.projectId === proj.id).map((s) => s.id))
  const projTasks = tasks.filter((x) => projSubIds.has(x.subProjectId))
  proj.progress = projTasks.length
    ? Math.round(projTasks.reduce((a, x) => a + x.progress, 0) / projTasks.length)
    : 0
  proj.health = deriveRollup(projTasks, TODAY).health
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
  const ownerId = sub?.ownerId || proj?.ownerId || ''
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
      await tasksApi.updateTask(milestoneId, basicsPatch as never)
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

// ============= 组织成员（用户）=============

const AVATAR_PALETTE = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#a855f7', '#ec4899', '#14b8a6', '#84cc16', '#f97316']
function pickAvatarColor(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length]
}

export interface OrgMemberInput {
  username: string
  displayName: string
  email: string
  role: Role
  specialtyGroup?: SpecialtyGroup | null
  weeklyAvailableHours?: number
}

/** 新增组织成员（API：POST /users + 重新同步；离线 mock：本地新增）。返回新成员 id。 */
export async function createOrgMember(input: OrgMemberInput): Promise<string> {
  const avatarColor = pickAvatarColor(input.username || input.displayName)
  if (useDataStore.getState().mode === 'api') {
    const dto = await usersApi.createUser({ ...input, isActive: true, avatarColor })
    await refreshAllData()
    return dto.id
  }
  if (users.some((u) => u.username === input.username)) throw new Error(`用户名 ${input.username} 已存在`)
  if (users.some((u) => u.email === input.email)) throw new Error(`邮箱 ${input.email} 已存在`)
  const id = `u-${Math.round(progressNonce())}`
  users.push({
    id,
    username: input.username,
    displayName: input.displayName,
    email: input.email,
    role: input.role,
    specialtyGroup: input.specialtyGroup ?? undefined,
    weeklyAvailableHours: input.weeklyAvailableHours ?? 40,
    isActive: true,
    avatarColor,
  })
  useDataStore.getState().bump()
  return id
}

/** 更新组织成员（停用/启用、角色、专业组、工时等）。 */
export async function updateOrgMember(id: string, patch: usersApi.UserUpdateRequest): Promise<void> {
  if (useDataStore.getState().mode === 'api') {
    await usersApi.updateUser(id, patch)
    await refreshAllData()
    return
  }
  const u = users.find((x) => x.id === id)
  if (u) Object.assign(u, patch)
  useDataStore.getState().bump()
}

/** 删除组织成员（引用守卫：仍负责项目/任务则拒绝，建议先停用）。 */
export async function deleteOrgMember(id: string): Promise<void> {
  if (useDataStore.getState().mode === 'api') {
    await usersApi.deleteUser(id)
    await refreshAllData()
    return
  }
  if (useAuth.getState().currentUser?.id === id) throw new Error('不能删除当前登录用户')
  const referenced =
    projects.some((p) => p.ownerId === id) ||
    subProjects.some((s) => s.ownerId === id) ||
    tasks.some((t) => t.ownerId === id || (t.collaboratorIds?.includes(id) ?? false))
  if (referenced) throw new Error('该成员仍负责项目/任务，请先停用或将负责人转移给他人后再删除。')
  const idx = users.findIndex((x) => x.id === id)
  if (idx >= 0) users.splice(idx, 1)
  // 镜像后端 ProjectMember 级联：从项目成员名单移除
  projects.forEach((p) => { if (p.memberIds?.includes(id)) p.memberIds = p.memberIds.filter((m) => m !== id) })
  useDataStore.getState().bump()
}

// ============= 计划基线 =============

/** 离线 mock：按当前运行时数据构建项目计划快照（与后端 _build_snapshot 同构）。 */
function buildSnapshotFromRuntime(projectId: string): BaselineSnapshot {
  const proj = projects.find((p) => p.id === projectId)
  const subIds = new Set(subProjects.filter((s) => s.projectId === projectId).map((s) => s.id))
  const projTasks = tasks.filter((t) => subIds.has(t.subProjectId))
  const fin = projectFinances.find((f) => f.projectId === projectId)
  const milestones = projTasks
    .filter((t) => t.isMilestone)
    .map((t) => ({
      id: t.id, code: t.code, name: t.name,
      plannedStart: t.plannedStart, plannedEnd: t.plannedEnd,
      isCriticalPath: t.isCriticalPath,
    }))
    .sort((a, b) => a.plannedEnd.localeCompare(b.plannedEnd))
  return {
    projectPlannedStart: proj?.plannedStart ?? '',
    projectPlannedEnd: proj?.plannedEnd ?? '',
    progress: proj?.progress ?? 0,
    totalBudget: fin?.totalBudget ?? 0,
    taskCount: projTasks.length,
    milestoneCount: milestones.length,
    milestones,
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
