// 行级数据可见范围（URS 5.2 中的"(本项目)" / "(本人)"标记）
//
// 规则总览（按 URS 5.2 + 5.1 QA/QC 职责 + 6.x 团队扩展）：
//   admin / cmc_lead   → 看全部数据
//   project_lead       → 自己负责（ownerId）+ 作为团队成员（memberIds）的项目，及其下子项目/任务/资源
//   rd / production    → 任务级仅本人；项目级 = 有任务的项目 ∪ 作为团队成员的项目（导航需要）
//   qa_qc              → 本人任务 + 跨项目所有"分析方法 / 稳定性"任务（cross-cutting，URS "分析任务跟踪"）
//
// 设计：返回一个 Scope 对象，所有需要"按可见范围筛选"的页面都从这里取，
// 而不是各自硬编码 role === 'xxx' 判断。

import { projects, subProjects, tasks } from '../mock'
import type { User, Project, SubProject, Task } from '../types'

export interface Scope {
  /** 当前用户角色（无登录时为 undefined） */
  user: User | null | undefined
  /** 是否能看全部（admin / cmc_lead） */
  isAll: boolean
  /** 是否仅"本人任务"模式（rd / production） */
  isOwnTaskOnly: boolean
  /** 可见的项目 ID 集合 */
  projectIds: Set<string>
  /** 可见的子项目 ID 集合 */
  subProjectIds: Set<string>
  /** 可见的任务 ID 集合 */
  taskIds: Set<string>
  /** 可见范围内涉及的"人员"ID 集合（用于人员负荷过滤） */
  userIds: Set<string>
}

/**
 * 计算当前用户的数据可见范围。
 * 调用一次后，把 scope 传给各个 widget 用同一份引用，避免重复计算。
 */
export function getScope(user: User | null | undefined): Scope {
  if (!user) {
    return {
      user,
      isAll: false,
      isOwnTaskOnly: false,
      projectIds: new Set(),
      subProjectIds: new Set(),
      taskIds: new Set(),
      userIds: new Set(),
    }
  }

  // —— 1. admin / cmc_lead：见全 —— //
  if (user.role === 'admin' || user.role === 'cmc_lead') {
    return {
      user,
      isAll: true,
      isOwnTaskOnly: false,
      projectIds: new Set(projects.map((p) => p.id)),
      subProjectIds: new Set(subProjects.map((s) => s.id)),
      taskIds: new Set(tasks.map((t) => t.id)),
      // 全员可见
      userIds: new Set(),  // 空集合 = 不过滤（约定）
    }
  }

  // —— 2. project_lead：自己负责的项目 + 自己作为团队成员的项目 —— //
  if (user.role === 'project_lead') {
    const myProjects = projects.filter(
      (p) => p.ownerId === user.id || p.memberIds?.includes(user.id)
    )
    const projectIds = new Set(myProjects.map((p) => p.id))
    const mySubs = subProjects.filter((s) => projectIds.has(s.projectId))
    const subProjectIds = new Set(mySubs.map((s) => s.id))
    const myTasks = tasks.filter((t) => subProjectIds.has(t.subProjectId))
    const taskIds = new Set(myTasks.map((t) => t.id))
    // 项目内涉及的所有人（owner + collaborator + 子项目 owner + 项目 owner）
    const userIds = new Set<string>()
    myProjects.forEach((p) => userIds.add(p.ownerId))
    mySubs.forEach((s) => s.ownerId && userIds.add(s.ownerId))
    myTasks.forEach((t) => {
      userIds.add(t.ownerId)
      t.collaboratorIds?.forEach((c) => userIds.add(c))
    })
    return {
      user,
      isAll: false,
      isOwnTaskOnly: false,
      projectIds,
      subProjectIds,
      taskIds,
      userIds,
    }
  }

  // —— 3. rd / production：仅自己参与的任务（→ 间接可见对应项目） —— //
  // 同时：被列为项目团队成员的项目也对其可见（项目级，任务仍只看本人）
  if (user.role === 'rd' || user.role === 'production') {
    const myTasks = tasks.filter(
      (t) => t.ownerId === user.id || t.collaboratorIds?.includes(user.id)
    )
    const taskIds = new Set(myTasks.map((t) => t.id))
    const subProjectIds = new Set(myTasks.map((t) => t.subProjectId))
    // 项目可见集合 = 有任务的项目 ∪ 作为团队成员的项目
    const projectIdsFromTasks = new Set(
      subProjects.filter((s) => subProjectIds.has(s.id)).map((s) => s.projectId)
    )
    const projectIdsAsMember = projects.filter((p) => p.memberIds?.includes(user.id)).map((p) => p.id)
    const projectIds = new Set([...projectIdsFromTasks, ...projectIdsAsMember])
    return {
      user,
      isAll: false,
      isOwnTaskOnly: true,
      projectIds,
      subProjectIds,
      taskIds,
      userIds: new Set([user.id]),
    }
  }

  // —— 4. qa_qc：本人任务 + 跨项目所有"分析方法 / 稳定性"任务（URS 5.1 分析任务跟踪）—— //
  // QC_MODULES：QA/QC 跨项目可见的模块
  const QC_MODULES = new Set(['分析方法', '稳定性'])
  const qcSubIds = new Set(subProjects.filter((s) => QC_MODULES.has(s.module)).map((s) => s.id))
  const myOwnTasks = tasks.filter(
    (t) => t.ownerId === user.id || t.collaboratorIds?.includes(user.id)
  )
  const qcTasks = tasks.filter((t) => qcSubIds.has(t.subProjectId))
  const visibleTaskMap = new Map<string, Task>()
  myOwnTasks.forEach((t) => visibleTaskMap.set(t.id, t))
  qcTasks.forEach((t) => visibleTaskMap.set(t.id, t))
  const visibleTasksList = Array.from(visibleTaskMap.values())

  const taskIds = new Set(visibleTasksList.map((t) => t.id))
  const subProjectIds = new Set(visibleTasksList.map((t) => t.subProjectId))
  const projectIds = new Set(
    subProjects.filter((s) => subProjectIds.has(s.id)).map((s) => s.projectId)
  )
  // QA 看到所有相关任务的负责人（用于人员负荷的"分析"组成员）
  const userIds = new Set<string>([user.id])
  visibleTasksList.forEach((t) => {
    userIds.add(t.ownerId)
    t.collaboratorIds?.forEach((c) => userIds.add(c))
  })

  return {
    user,
    isAll: false,
    isOwnTaskOnly: false,  // QA 不是纯"本人"模式，是 cross-cutting QC 模式
    projectIds,
    subProjectIds,
    taskIds,
    userIds,
  }
}

// ============= 便捷过滤器 =============

export function filterProjects(list: Project[], scope?: Scope): Project[] {
  if (!scope || scope.isAll) return list
  return list.filter((p) => scope.projectIds.has(p.id))
}

export function filterSubProjects(list: SubProject[], scope?: Scope): SubProject[] {
  if (!scope || scope.isAll) return list
  return list.filter((s) => scope.subProjectIds.has(s.id))
}

export function filterTasks(list: Task[], scope?: Scope): Task[] {
  if (!scope || scope.isAll) return list
  return list.filter((t) => scope.taskIds.has(t.id))
}

export function filterUsers<U extends { id: string }>(list: U[], scope?: Scope): U[] {
  // 空 set = 不过滤（admin/cmc_lead 全员可见）
  if (!scope || scope.isAll || scope.userIds.size === 0) return list
  return list.filter((u) => scope.userIds.has(u.id))
}

/** 简短的范围标签（用于页面提示用户当前看到的是哪一片） */
export function scopeLabel(scope: Scope): string {
  if (!scope.user) return ''
  if (scope.isAll) return '全部数据'
  if (scope.isOwnTaskOnly) return `仅本人任务（${scope.taskIds.size} 项）`
  if (scope.user.role === 'qa_qc') return `分析任务跟踪（${scope.taskIds.size} 项 · 跨 ${scope.projectIds.size} 项目）`
  return `本人负责的 ${scope.projectIds.size} 个项目`
}
