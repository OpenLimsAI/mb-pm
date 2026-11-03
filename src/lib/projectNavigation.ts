import { initialFilters, type FilterState } from './projectFilters'
import { productTypes, stages } from '../mock/dictionaries'

export type ProjectView = 'cards' | 'table' | 'matrix'
export type ProjectPage = 'projects' | 'workbench'
export type ProjectScope = 'all' | 'mine' | 'attention'
export type WorkbenchQueue = 'attention' | 'upcoming' | 'milestones'
export interface ProjectNavigation {
  page: ProjectPage
  view: ProjectView
  scope: ProjectScope
  filters: FilterState
  ownerScope: 'team' | 'mine'
  horizon: 7 | 30
  queue: WorkbenchQueue | 'auto'
}
export const defaultProjectNavigation: ProjectNavigation = {
  page: 'projects', view: 'cards', scope: 'all', filters: initialFilters,
  ownerScope: 'team', horizon: 30, queue: 'auto',
}
export const projectStorageKey = (userId: string) => `pm-project-navigation-v1:${userId}`
const recentKey = (userId: string) => `pm-recent-projects-v1:${userId}`
export function readProjectNavigation(userId: string): ProjectNavigation {
  const defaults = { ...defaultProjectNavigation, filters: { ...initialFilters } }
  try {
    const value = JSON.parse(localStorage.getItem(projectStorageKey(userId)) || 'null')
    if (!value || typeof value !== 'object') return defaults
    for (const [key, options] of Object.entries({ page: ['projects', 'workbench'], view: ['cards', 'table', 'matrix'], scope: ['all', 'mine', 'attention'], ownerScope: ['team', 'mine'], horizon: [7, 30], queue: ['auto', 'attention', 'upcoming', 'milestones'] })) {
      if (options.includes(value[key] as never)) Object.assign(defaults, { [key]: value[key] })
    }
    const filters = value.filters
    if (filters && typeof filters === 'object') {
      for (const key of ['keyword', 'ownerId'] as const) if (typeof filters[key] === 'string') defaults.filters[key] = filters[key]
      for (const [key, options] of Object.entries({ health: ['all', 'green', 'yellow', 'red'], productType: ['all', ...productTypes], stage: ['all', ...stages], status: ['all', '活跃', '暂停', '已完成', '已归档'] })) {
        if (options.includes(filters[key])) Object.assign(defaults.filters, { [key]: filters[key] })
      }
    }
  } catch { /* Storage can be unavailable or contain old settings. */ }
  return defaults
}
export function saveProjectNavigation(userId: string, state: ProjectNavigation) {
  try { localStorage.setItem(projectStorageKey(userId), JSON.stringify(state)) } catch { /* Keep navigation usable. */ }
}
export function recentProjectIds(userId: string): string[] {
  try {
    const values: unknown = JSON.parse(localStorage.getItem(recentKey(userId)) || '[]')
    return Array.isArray(values) ? [...new Set(values.filter((id): id is string => typeof id === 'string'))].slice(0, 8) : []
  } catch { return [] }
}
export function recordProjectVisit(userId: string, projectId: string) {
  try { localStorage.setItem(recentKey(userId), JSON.stringify([projectId, ...recentProjectIds(userId).filter((id) => id !== projectId)].slice(0, 8))) } catch { /* Optional shortcut history. */ }
}
