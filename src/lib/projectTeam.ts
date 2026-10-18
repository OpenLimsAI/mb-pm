// 项目团队 = 负责人 + 团队成员（Project.memberIds）。
// 任务只能派给团队里的人：负责人下拉、编辑模式任务表单、推荐负责人都只能选团队成员，
// 其他人先在项目「团队」页加入。仍负责或协作本项目任务的人不能移出团队。后端同一规则（backend/app/services/team.py）。

import type { Project } from '../types'
import { getProjectTasks } from '../mock'

export const ADD_TO_TEAM_HINT = '只能选项目团队成员，其他人请先在「团队」页加入'

export function teamIds(project: Pick<Project, 'ownerId' | 'memberIds'>): Set<string> {
  return new Set([project.ownerId, ...(project.memberIds ?? [])])
}

/** 本项目各人负责 / 协作的任务数（不含项目负责人）。 */
export function taskLoadOf(project: Pick<Project, 'id' | 'ownerId'>): Map<string, { owned: number; assisted: number }> {
  const load = new Map<string, { owned: number; assisted: number }>()
  const add = (id: string, key: 'owned' | 'assisted') => {
    if (id === project.ownerId) return
    const entry = load.get(id) ?? { owned: 0, assisted: 0 }
    entry[key] += 1
    load.set(id, entry)
  }
  for (const t of getProjectTasks(project.id)) {
    add(t.ownerId, 'owned')
    t.collaboratorIds?.forEach((id) => { if (id !== t.ownerId) add(id, 'assisted') })
  }
  return load
}

/** 离线演示数据：有任务的人补入团队名单（与后端启动补齐一致）。 */
export function includeAssignees(projects: Project[]): void {
  for (const p of projects) {
    const team = teamIds(p)
    const missing = [...taskLoadOf(p).keys()].filter((id) => !team.has(id))
    if (missing.length) p.memberIds = [...(p.memberIds ?? []), ...missing]
  }
}
