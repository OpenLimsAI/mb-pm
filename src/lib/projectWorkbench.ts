import { getTaskSchedule, isTaskDone } from './schedule'
import type { Project, SubProject, Task } from '../types'

export interface ProjectItem {
  project: Project
  task: Task
  days: number | null
  attention: boolean
  reason: string
}

/** Join only the supplied visible projects; no orphaned or completed tasks enter the workbench. */
export function projectItems(projects: Project[], subProjects: SubProject[], tasks: Task[], today = new Date()): ProjectItem[] {
  const byId = new Map(projects.map((p) => [p.id, p]))
  const subToProject = new Map(subProjects.map((s) => [s.id, byId.get(s.projectId)]))
  return tasks.flatMap((task): ProjectItem[] => {
    const project = subToProject.get(task.subProjectId)
    if (!project || isTaskDone(task)) return []
    const schedule = getTaskSchedule(task, today)
    const days = Number.isFinite(schedule.days) ? schedule.days : null
    const reasons = [
      days !== null && days < 0 ? `逾期 ${-days} 天` : '',
      task.status === '阻塞' ? '已阻塞' : task.status === '延迟' ? '标记延迟' : '',
    ].filter(Boolean)
    return [{ project, task, days, attention: reasons.length > 0, reason: reasons.join(' · ') }]
  }).sort((a, b) => (a.days ?? Infinity) - (b.days ?? Infinity) || a.task.name.localeCompare(b.task.name) || a.task.id.localeCompare(b.task.id))
}

export function workbenchGroups(items: ProjectItem[], horizon: 7 | 30, ownerId?: string) {
  const visible = items.filter((item) => ownerId === undefined || item.task.ownerId === ownerId)
  const due = visible.filter((item) => item.days !== null && item.days >= 0 && item.days <= horizon)
  return {
    attention: visible.filter((item) => item.attention),
    upcoming: due.filter((item) => !item.task.isMilestone),
    milestones: due.filter((item) => item.task.isMilestone),
  }
}
