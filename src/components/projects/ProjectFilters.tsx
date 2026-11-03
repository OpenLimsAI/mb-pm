import { useState, type ReactNode } from 'react'
import { Search, X, SlidersHorizontal } from 'lucide-react'
import { productTypes, stages } from '../../mock/dictionaries'
import { users } from '../../mock/users'
import type { Health, ProductType, Stage, ProjectStatus } from '../../types'
import { initialFilters, type FilterState } from '../../lib/projectFilters'
import { cn } from '../../lib/cn'

export function ProjectFilters({
  filters,
  onChange,
  onReset,
  viewControl,
}: {
  filters: FilterState
  onChange: (next: FilterState) => void
  onReset: () => void
  viewControl?: ReactNode
}) {
  const [expanded, setExpanded] = useState(false)
  const owners = users
  const advancedCount = [filters.productType !== 'all', filters.stage !== 'all', filters.health !== 'all', filters.status !== '活跃'].filter(Boolean).length
  const isModified = JSON.stringify(filters) !== JSON.stringify(initialFilters)

  return (
    <div className="project-filter-area">
      <div className="project-filter-toolbar">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-500" />
          <input type="search"
            value={filters.keyword}
            onChange={(e) => onChange({ ...filters, keyword: e.target.value })}
            aria-label="搜索项目"
            placeholder="搜索项目名称、编号或负责人"
            className="w-full pl-8 pr-3 py-1.5 rounded-md bg-ink-100 text-sm border border-transparent focus:outline-none focus:bg-white focus:border-brand-500"
          />
        </div>

        <Select
          label="负责人"
          value={filters.ownerId}
          onChange={(v) => onChange({ ...filters, ownerId: v })}
          options={[{ v: 'all', l: '全部' }, ...owners.map((u) => ({ v: u.id, l: u.displayName }))]}
        />
        <button type="button" className="project-filter-toggle" aria-expanded={expanded} aria-controls="project-advanced-filters" onClick={() => setExpanded(!expanded)}><SlidersHorizontal size={14} />筛选{advancedCount > 0 && ` (${advancedCount})`}</button>
        {viewControl}
      </div>
      <div id="project-advanced-filters" className="project-advanced-filters" hidden={!expanded}>
        <Select
          label="产品"
          value={filters.productType}
          onChange={(v) => onChange({ ...filters, productType: v as ProductType | 'all' })}
          options={[{ v: 'all', l: '全部' }, ...productTypes.map((t) => ({ v: t, l: t }))]}
        />
        <Select
          label="阶段"
          value={filters.stage}
          onChange={(v) => onChange({ ...filters, stage: v as Stage | 'all' })}
          options={[{ v: 'all', l: '全部' }, ...stages.map((s) => ({ v: s, l: s }))]}
        />
        <Select
          label="健康度"
          value={filters.health}
          onChange={(v) => onChange({ ...filters, health: v as Health | 'all' })}
          options={[
            { v: 'all', l: '全部' },
            { v: 'red', l: '🔴 风险' },
            { v: 'yellow', l: '🟡 关注' },
            { v: 'green', l: '🟢 健康' },
          ]}
        />
        <Select
          label="状态"
          value={filters.status}
          onChange={(v) => onChange({ ...filters, status: v as ProjectStatus | 'all' })}
          options={[
            { v: 'all', l: '全部' },
            { v: '活跃', l: '活跃' },
            { v: '暂停', l: '暂停' },
            { v: '已完成', l: '已完成' },
            { v: '已归档', l: '已归档' },
          ]}
        />

        {isModified && (
          <button
            onClick={onReset}
            className="ml-auto inline-flex items-center gap-1 text-xs text-ink-700 hover:text-ink-900 px-2 py-1.5 rounded hover:bg-ink-100"
          >
            <X className="w-3 h-3" /> 重置
          </button>
        )}
      </div>
    </div>
  )
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: { v: string; l: string }[]
}) {
  const isAll = value === 'all'
  return (
    <label className={cn(
      'inline-flex items-center gap-1.5 text-xs rounded-md px-2 py-1 border transition-colors',
      isAll ? 'border-ink-300 bg-white' : 'border-brand-500 bg-brand-50'
    )}>
      <span className="text-ink-500">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-transparent text-ink-900 text-xs focus:outline-none cursor-pointer"
      >
        {options.map((o) => (
          <option key={o.v} value={o.v}>{o.l}</option>
        ))}
      </select>
    </label>
  )
}
