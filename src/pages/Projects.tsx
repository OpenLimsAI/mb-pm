import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { LayoutGrid, Rows3, GitBranch, Plus, Database, Server, FileText, Copy, PanelRight } from 'lucide-react'
import { useAuth } from '../store/auth'
import { can } from '../lib/permissions'
import { projects } from '../mock'
import { useDataStore } from '../store/data'
import { Button, EmptyState } from '../components/ui'
import { ProjectFilters } from '../components/projects/ProjectFilters'
import { initialFilters, type FilterState } from '../lib/projectFilters'
import { ProjectCard } from '../components/projects/ProjectCard'
import { ProjectTable } from '../components/projects/ProjectTable'
import { ProjectWorkspace } from '../components/projects/ProjectWorkspace'
import { PortfolioMatrix } from '../components/projects/PortfolioMatrix'
import { CopyProjectDialog } from '../components/projects/CopyProjectDialog'
import { cn } from '../lib/cn'

type View = 'workspace' | 'cards' | 'table' | 'matrix'

export default function Projects() {
  const role = useAuth((s) => s.currentUser?.role)
  const navigate = useNavigate()
  const [filters, setFilters] = useState<FilterState>(initialFilters)
  const [view, setView] = useState<View>('workspace')
  const [searchParams, setSearchParams] = useSearchParams()
  const query = searchParams.get('q')
  const [copying, setCopying] = useState(false)
  // 统一从运行时数据层读取（已由 bootstrap 从后端填充）；订阅版本号以在创建/编辑后刷新
  const version = useDataStore((s) => s.version)
  const mode = useDataStore((s) => s.mode)

  const filtered = useMemo(() => {
    const kw = (query ?? filters.keyword).trim().toLowerCase()
    return projects.filter((p) => {
      if (kw && !`${p.code} ${p.name} ${p.description || ''}`.toLowerCase().includes(kw)) return false
      if (filters.health !== 'all' && p.health !== filters.health) return false
      if (filters.status !== 'all' && p.status !== filters.status) return false
      if (filters.productType !== 'all' && p.productType !== filters.productType) return false
      if (filters.stage !== 'all' && p.currentStage !== filters.stage) return false
      if (filters.ownerId !== 'all' && p.ownerId !== filters.ownerId) return false
      return true
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, query, version])

  const total = projects.length
  const changeFilters = (next: FilterState) => {
    setFilters(next)
    if (query !== null) {
      const nextParams = new URLSearchParams(searchParams)
      nextParams.delete('q')
      setSearchParams(nextParams, { replace: true })
    }
  }

  return (
    <div className="p-6 max-w-[1600px] mx-auto">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-ink-900 flex items-center gap-2">
            项目工作台
            <DataSourceBadge mode={mode} />
          </h1>
          <p className="text-sm text-ink-500 mt-1">
            共 <span className="font-medium text-ink-700">{total}</span> 个项目
            {filtered.length !== total && (
              <> · 当前匹配 <span className="font-medium text-brand-600">{filtered.length}</span> 个</>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="secondary" icon={<FileText className="w-4 h-4" />} onClick={() => navigate('/templates')}>
            模板管理
          </Button>
          {can(role, 'project.create') && total > 0 && (
            <Button
              variant="secondary"
              icon={<Copy className="w-4 h-4" />}
              disabled={mode !== 'api'}
              title={mode === 'api' ? '选一个已有项目，生成结构与计划相同的新项目' : '离线演示模式不支持复制项目'}
              onClick={() => setCopying(true)}
            >
              复制项目
            </Button>
          )}
          {can(role, 'project.create') && (
            <Button variant="primary" icon={<Plus className="w-4 h-4" />} onClick={() => navigate('/projects/new')}>
              创建项目
            </Button>
          )}
        </div>
      </div>

      <div className="mb-4"><ViewSwitcher view={view} onChange={setView} /></div>

      <ProjectFilters
        filters={{ ...filters, keyword: query ?? filters.keyword }}
        onChange={changeFilters}
        onReset={() => changeFilters(initialFilters)}
      />

      {/* 空状态 */}
      {filtered.length === 0 ? (
        <EmptyState
          title="没有匹配的项目"
          description="试试调整筛选条件"
          action={<Button onClick={() => changeFilters(initialFilters)}>重置筛选</Button>}
        />
      ) : view === 'workspace' ? (
        <ProjectWorkspace projects={filtered} />
      ) : view === 'cards' ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-3">
          {filtered.map((p) => <ProjectCard key={p.id} project={p} />)}
        </div>
      ) : view === 'table' ? (
        <ProjectTable projects={filtered} />
      ) : (
        <PortfolioMatrix projects={filtered} />
      )}

      {copying && <CopyProjectDialog onClose={() => setCopying(false)} />}
    </div>
  )
}

function DataSourceBadge({ mode }: { mode: 'loading' | 'api' | 'mock' }) {
  const isApi = mode === 'api'
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded border',
        isApi
          ? 'bg-emerald-50 text-emerald-700 border-emerald-300'
          : 'bg-ink-100 text-ink-700 border-ink-300',
      )}
      title={isApi ? '当前从后端 API 拉取数据' : '当前为离线 mock 数据'}
    >
      {isApi ? <Server className="w-2.5 h-2.5" /> : <Database className="w-2.5 h-2.5" />}
      {isApi ? 'API' : '离线'}
    </span>
  )
}

function ViewSwitcher({ view, onChange }: { view: View; onChange: (v: View) => void }) {
  const opts: { v: View; label: string; icon: typeof LayoutGrid }[] = [
    { v: 'workspace', label: '工作台', icon: PanelRight },
    { v: 'cards', label: '卡片', icon: LayoutGrid },
    { v: 'table', label: '表格', icon: Rows3 },
    { v: 'matrix', label: '矩阵', icon: GitBranch },
  ]
  return (
    <div role="group" aria-label="项目视图" className="flex flex-wrap gap-1 border-b border-ink-300/60">
      {opts.map((o) => (
        <button
          key={o.v}
          type="button"
          aria-pressed={view === o.v}
          onClick={() => onChange(o.v)}
          className={cn(
            'inline-flex items-center gap-1.5 px-3 py-2.5 text-sm border-b-2 transition-colors',
            view === o.v ? 'border-brand-600 text-brand-700 font-medium' : 'border-transparent text-ink-500 hover:text-ink-900 hover:bg-ink-100'
          )}
        >
          <o.icon className="w-3.5 h-3.5" />
          {o.label}
        </button>
      ))}
    </div>
  )
}
