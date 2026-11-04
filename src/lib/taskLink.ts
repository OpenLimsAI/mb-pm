import type { Task, SubProject } from '../types'

export function taskLink(task: Pick<Task, 'id' | 'subProjectId'>, subs: Pick<SubProject, 'id' | 'projectId'>[]): string {
  const projectId = subs.find(s => s.id === task.subProjectId)?.projectId
  return projectId ? `/projects/${encodeURIComponent(projectId)}?tab=wbs&task=${encodeURIComponent(task.id)}` : '/tasks'
}
