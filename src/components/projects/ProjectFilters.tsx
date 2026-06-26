import { Search, X } from 'lucide-react'
import { productTypes, stages } from '../../mock/dictionaries'
import { users } from '../../mock/users'
import type { Health, ProductType, Stage, ProjectStatus } from '../../types'
import { cn } from '../../lib/cn'

export interface FilterState {
  keyword: string
  productType: ProductType | 'all'
  stage: Stage | 'all'
  health: Health | 'all'
  ownerId: string | 'all'
  status: ProjectStatus | 'all'
}

export const initialFilters: FilterState = {
  keyword: '',
  productType: 'all',
  stage: 'all',
  health: 'all',
  ownerId: 'all',
  status: '活跃',
}

export function ProjectFilters({
  filters,
  onChange,
  onReset,
}: {
  filters: FilterState
  onChange: (next: FilterState) => void
  onReset: () => void
}) {
  const owners = users.filter((u) => u.role === 'project_lead' || u.role === 'cmc_lead')
  const isModified = JSON.stringify(filters) !== JSON.stringify(initialFilters)

  return (
    <div className="bg-white rounded-card shadow-card border border-ink-300/40 p-3 mb-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-500" />
          <input
            value={filters.keyword}
            onChange={(e) => onChange({ ...filters, keyword: e.target.value })}
            placeholder="搜索项目编号、名称、描述…"
            className="w-full pl-8 pr-3 py-1.5 rounded-md bg-ink-100 text-sm border border-transparent focus:outline-none focus:bg-white focus:border-brand-500"
          />
        </div>

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
          label="负责人"
          value={filters.ownerId}
          onChange={(v) => onChange({ ...filters, ownerId: v })}
          options={[{ v: 'all', l: '全部' }, ...owners.map((u) => ({ v: u.id, l: u.displayName }))]}
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
