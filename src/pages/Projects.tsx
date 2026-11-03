import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { LayoutGrid, Rows3, GitBranch, Plus, FileText, Copy, PanelsTopLeft, FolderOpen } from 'lucide-react'
import { useAuth } from '../store/auth'
import { can } from '../lib/permissions'
import { findUser, projects, subProjects, tasks } from '../mock'
import { useDataStore } from '../store/data'
import { Button, EmptyState } from '../components/ui'
import { ProjectFilters } from '../components/projects/ProjectFilters'
import { initialFilters, type FilterState } from '../lib/projectFilters'
import { ProjectCard } from '../components/projects/ProjectCard'
import { ProjectTable } from '../components/projects/ProjectTable'
import { ProjectWorkspace } from '../components/projects/ProjectWorkspace'
import { PortfolioMatrix } from '../components/projects/PortfolioMatrix'
import { CopyProjectDialog } from '../components/projects/CopyProjectDialog'
import { TaskDrawer } from '../components/task/TaskDrawer'
import { projectItems } from '../lib/projectWorkbench'
import { projectStorageKey, readProjectNavigation, saveProjectNavigation, type ProjectNavigation, type ProjectScope, type ProjectView } from '../lib/projectNavigation'
import './projects.css'

export default function Projects() {
  const userId = useAuth((s) => s.currentUser?.id) ?? 'offline'
  // Reinitialize preferences on account changes; never inherit another user's task scope.
  return <ProjectsContent key={userId} userId={userId} />
}

function ProjectsContent({ userId }: { userId: string }) {
  const role = useAuth((s) => s.currentUser?.role)
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [navigation, setNavigation] = useState(() => {
    const saved = readProjectNavigation(userId)
    const query = searchParams.get('q')
    return query === null ? saved : { ...saved, page: 'projects' as const, filters: { ...saved.filters, keyword: query } }
  })
  const [copying, setCopying] = useState(false)
  const [openTaskId, setOpenTaskId] = useState<string | null>(null)
  const [today, setToday] = useState(() => new Date())
  const root = useRef<HTMLDivElement>(null)
  useDataStore((s) => s.version)
  const mode = useDataStore((s) => s.mode)
  const { view, scope } = navigation
  const query = searchParams.get('q')
  const page = query === null ? navigation.page : 'projects'
  const filters = { ...navigation.filters, keyword: query ?? navigation.filters.keyword }

  useEffect(() => {
    saveProjectNavigation(userId, query === null ? navigation : { ...navigation, page: 'projects', filters: { ...navigation.filters, keyword: query } })
  }, [userId, navigation, query])
  useEffect(() => {
    const refresh = () => setToday(new Date())
    const timer = window.setInterval(refresh, 60_000)
    document.addEventListener('visibilitychange', refresh)
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', refresh) }
  }, [])
  useLayoutEffect(() => {
    const main = root.current?.closest('main')
    if (!main) return
    const key = `${projectStorageKey(userId)}:scroll:${page}`
    let saved = 0
    try { saved = Number(sessionStorage.getItem(key)) || 0 } catch { /* Optional restoration. */ }
    main.scrollTop = saved
    const remember = () => { try { sessionStorage.setItem(key, String(main.scrollTop)) } catch { /* Optional restoration. */ } }
    main.addEventListener('scroll', remember, { passive: true })
    return () => { main.removeEventListener('scroll', remember) }
  }, [userId, page])

  const change = (patch: Partial<ProjectNavigation>) => {
    setNavigation((current) => ({ ...current, page, ...patch, filters: patch.filters ?? { ...current.filters, keyword: query ?? current.filters.keyword } }))
    if (query !== null) { const params = new URLSearchParams(searchParams); params.delete('q'); setSearchParams(params, { replace: true }) }
  }
  const changeFilters = (next: FilterState) => change({ filters: next })
  const allItems = projectItems(projects, subProjects, tasks, today)
  const attentionIds = new Set(allItems.filter((item) => item.attention).map((item) => item.project.id))
  const needsAttention = (p: typeof projects[number]) => p.health !== 'green' || attentionIds.has(p.id)
  const keyword = filters.keyword.trim().toLowerCase()
  const filtered = projects.filter((p) => {
    if (keyword && !`${p.code} ${p.name} ${p.description || ''} ${findUser(p.ownerId)?.displayName || ''}`.toLowerCase().includes(keyword)) return false
    if (filters.health !== 'all' && p.health !== filters.health) return false
    if (filters.status !== 'all' && p.status !== filters.status) return false
    if (filters.productType !== 'all' && p.productType !== filters.productType) return false
    if (filters.stage !== 'all' && p.currentStage !== filters.stage) return false
    if (filters.ownerId !== 'all' && p.ownerId !== filters.ownerId) return false
    return true
  })
  const scoped = filtered.filter((p) => scope === 'mine' ? p.ownerId === userId : scope === 'attention' ? needsAttention(p) : true)
  const active = projects.filter((p) => p.status === '活跃')
  const activeIds = new Set(active.map((p) => p.id))
  // A task saved as done remains open until the user closes it, while still checking current project visibility.
  const visibleTask = openTaskId ? tasks.find((t) => t.id === openTaskId && subProjects.some((s) => s.id === t.subProjectId && activeIds.has(s.projectId))) : undefined

  return <div className="projects-page" ref={root}>
    <div className="project-page-heading"><div><h1>项目管理</h1><p>{active.length} 个活跃项目 · 共 {projects.length} 个项目{mode === 'mock' && <span className="ml-2">离线演示</span>}</p></div><div className="project-control-row">
      <Button variant="ghost" icon={<FileText className="w-4 h-4" />} onClick={() => navigate('/templates')}>模板管理</Button>
      {can(role, 'project.create') && projects.length > 0 && <Button variant="secondary" icon={<Copy className="w-4 h-4" />} disabled={mode !== 'api'} title={mode === 'api' ? '复制已有项目的结构与计划' : '离线演示模式不支持复制项目'} onClick={() => setCopying(true)}>复制项目</Button>}
      {can(role, 'project.create') && <Button variant="primary" icon={<Plus className="w-4 h-4" />} onClick={() => navigate('/projects/new')}>创建项目</Button>}
    </div></div>
    <nav className="project-page-tabs" aria-label="项目管理导航">{([{ id: 'projects', label: '全部项目', icon: FolderOpen }, { id: 'workbench', label: '工作台', icon: PanelsTopLeft }] as const).map((tab) => <button type="button" key={tab.id} aria-pressed={page === tab.id} onClick={() => change({ page: tab.id })}><tab.icon size={16} />{tab.label}{tab.id === 'projects' && <span>{projects.length}</span>}</button>)}</nav>
    {page === 'projects' ? <section aria-label="全部项目">
      <ProjectFilters filters={filters} onChange={changeFilters} onReset={() => change({ filters: initialFilters, scope: 'all' })} viewControl={<ViewSwitcher view={view} onChange={(next) => change({ view: next })} />} />
      <div className="project-scope-row"><div role="group" aria-label="项目范围">{([{ id: 'all', label: '全部项目' }, { id: 'mine', label: '我负责的' }, { id: 'attention', label: `需关注 ${filtered.filter(needsAttention).length}` }] as { id: ProjectScope; label: string }[]).map((option) => <button type="button" key={option.id} aria-pressed={scope === option.id} onClick={() => change({ scope: option.id })}>{option.label}</button>)}</div><span aria-live="polite">{scoped.length} / {projects.length} 个项目</span></div>
      {!scoped.length ? <EmptyState title="没有匹配的项目" description="试试调整搜索、项目范围或筛选条件" action={<Button onClick={() => change({ filters: initialFilters, scope: 'all' })}>重置筛选</Button>} /> : view === 'cards' ? <div className="project-card-grid">{scoped.map((p) => <ProjectCard key={p.id} project={p} items={allItems.filter((item) => item.project.id === p.id)} />)}</div> : view === 'table' ? <ProjectTable projects={scoped} /> : <PortfolioMatrix projects={scoped} />}
    </section> : <ProjectWorkspace projects={active} items={allItems.filter((item) => activeIds.has(item.project.id))} userId={userId} navigation={navigation} onChange={change} onOpenTask={setOpenTaskId} />}
    <TaskDrawer task={visibleTask ?? null} onClose={() => setOpenTaskId(null)} />
    {copying && <CopyProjectDialog onClose={() => setCopying(false)} />}
  </div>
}

function ViewSwitcher({ view, onChange }: { view: ProjectView; onChange: (view: ProjectView) => void }) {
  return <div className="project-view-switcher" role="group" aria-label="项目视图">{([{ id: 'cards', label: '卡片', icon: LayoutGrid }, { id: 'table', label: '表格', icon: Rows3 }, { id: 'matrix', label: '矩阵', icon: GitBranch }] as const).map((option) => <button type="button" key={option.id} aria-pressed={view === option.id} onClick={() => onChange(option.id)}><option.icon size={14} />{option.label}</button>)}</div>
}
