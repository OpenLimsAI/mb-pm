export type ApplicationDataSource = 'projects' | 'knowledge'

const sourceOrder: ApplicationDataSource[] = ['projects', 'knowledge']
const sourceNames: Record<ApplicationDataSource, string> = { projects: '项目管理', knowledge: '知识库' }

export function normalizeDataSources(value: unknown): ApplicationDataSource[] {
  return Array.isArray(value) ? sourceOrder.filter(source => value.includes(source)) : []
}

export function readDataSources(storage: Storage, key: string): ApplicationDataSource[] {
  try {
    const saved: unknown = JSON.parse(storage.getItem(key) || 'null')
    if (saved && typeof saved === 'object' && !Array.isArray(saved) && 'version' in saved && saved.version === 2 && 'sources' in saved) return normalizeDataSources(saved.sources)
    // The old project option was retired. Restoring the feature must not restore
    // an old permission silently; only the still-supported knowledge choice migrates.
    return Array.isArray(saved) && saved.includes('knowledge') ? ['knowledge'] : []
  } catch { return [] }
}

export function writeDataSources(storage: Storage, key: string, sources: readonly ApplicationDataSource[]) {
  storage.setItem(key, JSON.stringify({ version: 2, sources: normalizeDataSources(sources) }))
}

export function dataSourceLabel(sources: readonly ApplicationDataSource[]) {
  return sources.length ? normalizeDataSources(sources).map(source => sourceNames[source]).join('、') : '未启用'
}
