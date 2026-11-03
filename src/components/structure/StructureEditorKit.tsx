// 结构编辑器的公共界面 —— 模板结构编辑与项目「编辑模式」共用，保证两处增删改的用法完全一致：
//   子项目卡片（名称 / 模块 / 阶段 / 删除）→ 任务行（悬停出现拖动手柄、上沿「＋」插入、编辑、删除）
//   →「添加任务 / 里程碑」，右侧抽屉表单，底部固定的「变更说明 · 取消 · 保存」条。
// 任务行与子项目卡片都可插入（上沿「＋」）和拖动调整顺序（任务可跨子项目；子项目连同其任务一起移动；
// 选中手柄后可用 ↑ ↓ 键移动）。
// 只负责展示与交互；草稿数据与保存逻辑由各自页面提供。

import { useEffect, useState, type DragEvent, type ReactNode } from 'react'
import {
  AlertTriangle, ChevronDown, ChevronRight, Diamond, GripVertical, ListChecks, Loader2, PencilLine, Plus, Save, Trash2, X,
} from 'lucide-react'
import { Button, Card, Tag } from '../ui'
import { modules, stages } from '../../mock'
import type { Module, Stage } from '../../types'
import { cn } from '../../lib/cn'

// ============= 拖动排序 =============

const DND_TYPE = 'application/x-mbpm-structure-task'
const SUB_DND_TYPE = 'application/x-mbpm-structure-sub'
const carriesTask = (e: DragEvent) => Array.from(e.dataTransfer.types).includes(DND_TYPE)
const carriesSub = (e: DragEvent) => Array.from(e.dataTransfer.types).includes(SUB_DND_TYPE)
/** 指针在行的上半部 → 放在本行之前，下半部 → 之后 */
const dropSide = (e: DragEvent<HTMLElement>) => {
  const r = e.currentTarget.getBoundingClientRect()
  return e.clientY < r.top + r.height / 2 ? 'before' : 'after'
}

/** 任务行的拖动排序：id 为被拖动时携带的标识；onDrop 收到被拖任务与放在本行之前 / 之后；onMove 用于键盘 ↑ ↓。 */
export interface RowDnd {
  id: string
  onDrop: (draggedId: string, where: 'before' | 'after') => void
  onMove?: (delta: -1 | 1) => void
}

/** 放置区（子项目末尾）：拖到这里即移到该子项目最后。 */
function useDropZone(onDrop?: (draggedId: string) => void) {
  const [over, setOver] = useState(false)
  if (!onDrop) return { over: false, handlers: {} }
  return {
    over,
    handlers: {
      onDragOver: (e: DragEvent) => {
        if (!carriesTask(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setOver(true)
      },
      onDragLeave: () => setOver(false),
      onDrop: (e: DragEvent) => {
        const id = e.dataTransfer.getData(DND_TYPE)
        setOver(false)
        if (!id) return
        e.preventDefault()
        onDrop(id)
      },
    },
  }
}

export interface SubFieldsValue {
  name: string
  module?: Module
  stage?: Stage
}

// ============= 子项目卡片 =============

export function SubCard({
  value, taskCount, onChange, onDelete, deleteBlockedReason, onAddTask, onDropAtEnd, onInsertBefore, dnd, children,
}: {
  value: SubFieldsValue
  taskCount: number
  onChange: (f: SubFieldsValue) => void
  onDelete: () => void
  /** 不能删除时的原因（如：含已开始的任务）；有值时删除按钮置灰 */
  deleteBlockedReason?: string | null
  onAddTask: () => void
  /** 任务拖到本子项目末尾（含空子项目） */
  onDropAtEnd?: (draggedId: string) => void
  /** 在本子项目之前插入新子项目（悬停头部时上沿出现「＋ 子项目」） */
  onInsertBefore?: () => void
  /** 拖动调整子项目顺序（其下任务一起移动） */
  dnd?: RowDnd
  children: ReactNode
}) {
  const [open, setOpen] = useState(true)
  const [confirmDel, setConfirmDel] = useState(false)
  const [dropAt, setDropAt] = useState<'before' | 'after' | null>(null)
  const drop = useDropZone(onDropAtEnd)

  return (
    <Card
      data-sub-card=""
      className="overflow-visible relative"
      onDragOver={dnd ? (e) => {
        if (!carriesSub(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setDropAt(dropSide(e))
      } : undefined}
      onDragLeave={dnd ? (e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropAt(null) } : undefined}
      onDrop={dnd ? (e) => {
        if (!carriesSub(e)) return
        const id = e.dataTransfer.getData(SUB_DND_TYPE)
        setDropAt(null)
        if (!id) return
        e.preventDefault()
        if (id !== dnd.id) dnd.onDrop(id, dropSide(e))
      } : undefined}
    >
      {dropAt && <span className={cn('pointer-events-none absolute left-0 right-0 h-1 rounded bg-brand-500 z-10', dropAt === 'before' ? '-top-2' : '-bottom-2')} />}
      {/* 头部：可编辑名称 / 模块 / 阶段 */}
      <div className="relative group/subhead px-3 py-2 bg-purple-50/70 border-b border-purple-200/60 flex items-center gap-2 flex-wrap">
        {onInsertBefore && (
          <button
            type="button"
            onClick={onInsertBefore}
            className="absolute left-8 -top-3 z-10 h-5 px-1.5 rounded-full border border-purple-300 bg-white text-purple-700 text-[10px] inline-flex items-center gap-0.5 opacity-0 group-hover/subhead:opacity-100 focus-visible:opacity-100 hover:bg-purple-600 hover:text-white transition-opacity"
            title="在此插入子项目"
            aria-label={`在「${value.name}」之前插入子项目`}
          >
            <Plus className="w-3 h-3" /> 子项目
          </button>
        )}
        {dnd && (
          <button
            type="button"
            draggable
            data-sub-drag-handle={dnd.id}
            onDragStart={(e) => {
              e.dataTransfer.setData(SUB_DND_TYPE, dnd.id)
              e.dataTransfer.effectAllowed = 'move'
              const card = e.currentTarget.closest('[data-sub-card]')
              if (card) e.dataTransfer.setDragImage(card, 24, 16)
            }}
            onKeyDown={dnd.onMove ? (e) => {
              if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
              e.preventDefault()
              dnd.onMove!(e.key === 'ArrowUp' ? -1 : 1)
              requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-sub-drag-handle="${CSS.escape(dnd.id)}"]`)?.focus())
            } : undefined}
            className="-ml-1 p-0.5 rounded text-ink-400 cursor-grab active:cursor-grabbing opacity-40 group-hover/subhead:opacity-100 focus-visible:opacity-100 hover:text-ink-700 shrink-0"
            title="拖动调整子项目顺序，其下任务一起移动（选中后可用 ↑ ↓ 键移动）"
            aria-label={`拖动「${value.name}」调整顺序`}
          >
            <GripVertical className="w-3.5 h-3.5" />
          </button>
        )}
        <button onClick={() => setOpen((v) => !v)} className="text-ink-500 shrink-0" aria-label={open ? '收起' : '展开'}>
          {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </button>
        <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-purple-200 text-purple-800 shrink-0">Lv2</span>
        <input
          className="text-sm font-semibold bg-transparent border border-transparent hover:border-ink-300 focus:border-brand-400 focus:bg-white rounded px-1.5 py-0.5 min-w-[160px] flex-1 focus:outline-none"
          value={value.name}
          onChange={(e) => onChange({ ...value, name: e.target.value })}
          placeholder="子项目名称"
        />
        <select
          className="h-7 text-xs rounded border border-ink-300 bg-white px-1.5 focus:border-brand-400 focus:outline-none"
          value={value.module ?? ''} onChange={(e) => onChange({ ...value, module: (e.target.value || undefined) as Module | undefined })}
          aria-label="模块"
        >
          <option value="">模块…</option>
          {modules.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <select
          className="h-7 text-xs rounded border border-ink-300 bg-white px-1.5 focus:border-brand-400 focus:outline-none"
          value={value.stage ?? ''} onChange={(e) => onChange({ ...value, stage: (e.target.value || undefined) as Stage | undefined })}
          aria-label="阶段"
        >
          <option value="">阶段…</option>
          {stages.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <span className="text-[11px] text-ink-500">{taskCount} 任务</span>
        <div className="flex-1" />
        {confirmDel ? (
          <span className="inline-flex items-center gap-1.5 text-xs">
            <span className="text-red-600">删除「{value.name}」及其 {taskCount} 个任务？</span>
            <button className="text-red-600 font-medium hover:underline" onClick={onDelete}>确认</button>
            <button className="text-ink-500 hover:underline" onClick={() => setConfirmDel(false)}>取消</button>
          </span>
        ) : (
          <button
            onClick={() => setConfirmDel(true)}
            disabled={!!deleteBlockedReason}
            className="p-1 rounded hover:bg-red-50 text-ink-400 hover:text-red-600 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-400 disabled:cursor-not-allowed"
            title={deleteBlockedReason || '删除子项目'}
            aria-label="删除子项目"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {open && (
        <ul className="divide-y divide-ink-200/60">
          {children}
          {taskCount === 0 && <li className="px-3 py-2.5 text-xs text-ink-400 italic">暂无任务，点击下方「添加任务」</li>}
          <li className={cn('px-2 py-1.5 relative', drop.over && 'bg-brand-50/60')} {...drop.handlers}>
            {drop.over && <span className="pointer-events-none absolute left-2 right-2 -top-px h-0.5 rounded bg-brand-500" />}
            <button onClick={onAddTask} className="inline-flex items-center gap-1 text-xs text-brand-600 hover:bg-brand-50 px-2 py-1 rounded">
              <Plus className="w-3.5 h-3.5" /> 添加任务 / 里程碑
            </button>
          </li>
        </ul>
      )}
    </Card>
  )
}

// ============= 任务行 =============

export function TaskRow({
  code, name, isMilestone, tag, durationDays, effort, predecessorCodes, onEdit, onDelete,
  deleteBlockedReason, warning, extra, codeClassName = 'w-16', onInsertBefore, dnd,
}: {
  code?: string
  name: string
  isMilestone: boolean
  /** 负责组（模板）/ 负责人（项目） */
  tag?: string | null
  durationDays?: number | null
  effort?: number | null
  predecessorCodes: string[]
  onEdit: () => void
  onDelete: () => void
  deleteBlockedReason?: string | null
  /** 行内提示（如日期与前置冲突） */
  warning?: string | null
  /** 额外信息（如项目任务的当前状态） */
  extra?: ReactNode
  codeClassName?: string
  /** 在本行之前插入（悬停时行上沿出现「＋」） */
  onInsertBefore?: () => void
  /** 拖动调整顺序 */
  dnd?: RowDnd
}) {
  const [dropAt, setDropAt] = useState<'before' | 'after' | null>(null)
  const gutter = !!(onInsertBefore || dnd)
  return (
    <li
      className={cn('relative flex items-center gap-2 pr-3 py-1.5 group hover:bg-ink-100/40', gutter ? 'pl-7' : 'pl-3')}
      onDragOver={dnd ? (e) => {
        if (!carriesTask(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setDropAt(dropSide(e))
      } : undefined}
      onDragLeave={dnd ? (e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropAt(null) } : undefined}
      onDrop={dnd ? (e) => {
        const id = e.dataTransfer.getData(DND_TYPE)
        setDropAt(null)
        if (!id) return
        e.preventDefault()
        if (id !== dnd.id) dnd.onDrop(id, dropSide(e))
      } : undefined}
    >
      {dropAt && <span className={cn('pointer-events-none absolute left-2 right-2 h-0.5 rounded bg-brand-500', dropAt === 'before' ? '-top-px' : '-bottom-px')} />}
      {onInsertBefore && (
        <button
          type="button"
          onClick={onInsertBefore}
          className="absolute left-1.5 -top-2 z-10 w-4 h-4 rounded-full border border-brand-400 bg-white text-brand-600 flex items-center justify-center opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-brand-600 hover:text-white transition-opacity"
          title="在此插入任务 / 里程碑"
          aria-label={`在「${name}」之前插入任务`}
        >
          <Plus className="w-3 h-3" />
        </button>
      )}
      {dnd && (
        <button
          type="button"
          draggable
          data-drag-handle={dnd.id}
          onDragStart={(e) => {
            e.dataTransfer.setData(DND_TYPE, dnd.id)
            e.dataTransfer.effectAllowed = 'move'
            const row = e.currentTarget.closest('li')
            if (row) e.dataTransfer.setDragImage(row, 16, 12)
          }}
          onKeyDown={dnd.onMove ? (e) => {
            if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
            e.preventDefault()
            dnd.onMove!(e.key === 'ArrowUp' ? -1 : 1)
            // 移动后行会重新排列，焦点留在原手柄上，便于连续移动
            requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-drag-handle="${CSS.escape(dnd.id)}"]`)?.focus())
          } : undefined}
          className="absolute left-1 top-1/2 -translate-y-1/2 p-0.5 rounded text-ink-400 cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-ink-700"
          title="拖动调整顺序（选中后可用 ↑ ↓ 键移动）"
          aria-label={`拖动「${name}」调整顺序`}
        >
          <GripVertical className="w-3.5 h-3.5" />
        </button>
      )}
      {isMilestone
        ? <Diamond className="w-3.5 h-3.5 text-amber-600 shrink-0" />
        : <span className="text-[9px] font-mono px-1 rounded bg-emerald-100 text-emerald-800 shrink-0">L3</span>}
      <span className={cn('text-[10px] font-mono text-ink-400 shrink-0 truncate', codeClassName)} title={code}>{code}</span>
      <button onClick={onEdit} title={name} className={cn('text-sm min-w-0 flex-1 truncate text-left hover:text-brand-700 hover:underline', isMilestone && 'font-semibold')}>
        {name}
      </button>
      {warning && (
        <span className="text-[10px] text-red-600 inline-flex items-center gap-0.5 shrink-0 max-w-[220px] truncate" title={warning}>
          <AlertTriangle className="w-3 h-3 shrink-0" />{warning}
        </span>
      )}
      {extra}
      {tag && <Tag tone="gray">{tag}</Tag>}
      {!isMilestone && durationDays != null && <span className="text-[10px] text-ink-500 shrink-0">{durationDays}d</span>}
      {!isMilestone && effort != null && <span className="text-[10px] text-ink-500 shrink-0">{effort}人天</span>}
      {predecessorCodes.length > 0 && (
        <span className="text-[10px] text-ink-400 shrink-0 max-w-[260px] truncate" title={predecessorCodes.join(', ')}>← {predecessorCodes.join(', ')}</span>
      )}
      <button onClick={onEdit} className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-ink-100 text-ink-400 hover:text-brand-600 transition-opacity shrink-0" title="编辑" aria-label={`编辑「${name}」`}>
        <PencilLine className="w-3.5 h-3.5" />
      </button>
      <button
        onClick={onDelete}
        disabled={!!deleteBlockedReason}
        className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-red-50 text-ink-400 hover:text-red-600 transition-opacity shrink-0 disabled:opacity-0 disabled:group-hover:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-400 disabled:cursor-not-allowed"
        title={deleteBlockedReason ? `${deleteBlockedReason}，不能删除` : '删除'}
        aria-label={`删除「${name}」`}
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </li>
  )
}

// ============= 添加子项目 =============

export function AddSubButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full py-2.5 rounded-md border border-dashed border-ink-300 text-sm text-ink-500 hover:border-brand-400 hover:text-brand-600 hover:bg-brand-50/40 transition-colors inline-flex items-center justify-center gap-1.5"
    >
      <Plus className="w-4 h-4" /> 添加子项目
    </button>
  )
}

export function AddSubForm({ onSubmit, onCancel, requireModuleStage }: {
  onSubmit: (f: SubFieldsValue) => void
  onCancel: () => void
  /** 项目子项目必须选模块和阶段 */
  requireModuleStage?: boolean
}) {
  const [name, setName] = useState('')
  const [module, setModule] = useState<Module | ''>('')
  const [stage, setStage] = useState<Stage | ''>('')
  const valid = name.trim().length > 0 && (!requireModuleStage || (module !== '' && stage !== ''))
  return (
    <div className="flex items-end gap-2 flex-wrap">
      <label className="block">
        <span className="text-[11px] text-ink-500">子项目名称 *</span>
        <input autoFocus className="input mt-1 w-56" value={name} onChange={(e) => setName(e.target.value)} placeholder="如：上游工艺开发 (USP)" />
      </label>
      <label className="block">
        <span className="text-[11px] text-ink-500">模块{requireModuleStage && ' *'}</span>
        <select className="input mt-1" value={module} onChange={(e) => setModule(e.target.value as Module | '')}>
          <option value="">—</option>
          {modules.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </label>
      <label className="block">
        <span className="text-[11px] text-ink-500">阶段{requireModuleStage && ' *'}</span>
        <select className="input mt-1" value={stage} onChange={(e) => setStage(e.target.value as Stage | '')}>
          <option value="">—</option>
          {stages.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </label>
      <div className="flex-1" />
      <Button variant="secondary" size="sm" onClick={onCancel}>取消</Button>
      <Button variant="primary" size="sm" disabled={!valid} icon={<Plus className="w-3.5 h-3.5" />}
        onClick={() => onSubmit({ name: name.trim(), module: module || undefined, stage: stage || undefined })}>
        添加
      </Button>
    </div>
  )
}

// ============= 计数 =============

export function StructureCounts({ subProjects, tasks, milestones }: { subProjects: number; tasks: number; milestones: number }) {
  return (
    <div className="flex items-center gap-3 text-xs text-ink-500 shrink-0">
      <span><b className="text-ink-800">{subProjects}</b> 子项目</span>
      <span><b className="text-ink-800">{tasks}</b> 任务</span>
      <span className="inline-flex items-center gap-0.5"><Diamond className="w-3 h-3 text-amber-600" /><b className="text-ink-800">{milestones}</b> 里程碑</span>
    </div>
  )
}

// ============= 底部保存条 =============

export function SaveBar({ summary, onSummary, error, saving, saveLabel, saveDisabled, onCancel, onSave, children }: {
  summary: string
  onSummary: (v: string) => void
  error?: ReactNode
  saving: boolean
  saveLabel: string
  saveDisabled?: boolean
  onCancel: () => void
  onSave: () => void
  /** 保存条左侧的额外提示（如未保存修改数） */
  children?: ReactNode
}) {
  return (
    <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-ink-300/50 shadow-[0_-2px_8px_rgba(0,0,0,0.04)] z-30">
      <div className="max-w-[1200px] mx-auto px-6 py-3 flex items-center gap-3">
        <input
          className="input flex-1 max-w-md" value={summary} onChange={(e) => onSummary(e.target.value)} maxLength={200}
          placeholder="变更说明（可选，如：新增 HCP 方法开发任务）"
        />
        {children}
        {error && <span className="text-xs text-red-600 inline-flex items-center gap-1 min-w-0"><AlertTriangle className="w-3.5 h-3.5 shrink-0" /><span className="min-w-0">{error}</span></span>}
        <div className="flex-1" />
        <Button variant="secondary" disabled={saving} onClick={onCancel}>取消</Button>
        <Button
          variant="primary" disabled={saving || saveDisabled}
          icon={saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          onClick={onSave}
        >
          {saving ? '保存中…' : saveLabel}
        </Button>
      </div>
    </div>
  )
}

// ============= 右侧抽屉 =============

export function EditorDrawer({ title, code, onClose, onSubmit, submitLabel, submitDisabled, children }: {
  title: string
  code?: string
  onClose: () => void
  onSubmit: () => void
  submitLabel: string
  submitDisabled?: boolean
  children: ReactNode
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative ml-auto w-full max-w-[520px] bg-white shadow-2xl overflow-y-auto flex flex-col">
        <div className="flex items-center gap-2 px-5 py-4 border-b border-ink-300/40 sticky top-0 bg-white z-10">
          <h2 className="text-lg font-semibold text-ink-900 flex-1">{title}</h2>
          {code && <Tag tone="gray">{code}</Tag>}
          <button onClick={onClose} className="p-1.5 rounded-md hover:bg-ink-100 text-ink-500" aria-label="关闭"><X className="w-4 h-4" /></button>
        </div>
        <div className="flex-1 px-5 py-4 space-y-3.5">{children}</div>
        <div className="px-5 py-3 border-t border-ink-300/40 sticky bottom-0 bg-white flex items-center justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>取消</Button>
          <Button variant="primary" size="sm" disabled={submitDisabled} icon={<Save className="w-3.5 h-3.5" />} onClick={onSubmit}>
            {submitLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}

/** 插入位置说明：「插入在 A 与 B 之间」 */
export function InsertHint({ sub, index, dated }: { sub: { name: string }[]; index: number; dated?: boolean }) {
  const before = sub[index - 1]
  const after = sub[index]
  return (
    <p className="text-xs rounded-md bg-brand-50 text-brand-800 p-2.5">
      {before && after ? <>插入在「{before.name}」与「{after.name}」之间</> : after ? <>插入在「{after.name}」之前（最前面）</> : <>添加在末尾</>}
      {before && dated ? '，开始日期默认接在上一个任务之后。' : '。'}
    </p>
  )
}

// ============= 前置依赖选择 =============

export interface PredecessorCandidate {
  id: string
  code: string
  name: string
  subName?: string
  /** 不可选的原因（如：会形成循环依赖） */
  disabledReason?: string | null
}

export function PredecessorPicker({ candidates, selected, onToggle }: {
  candidates: PredecessorCandidate[]
  selected: string[]
  onToggle: (id: string) => void
}) {
  const [open, setOpen] = useState(true)
  return (
    <div>
      <button type="button" onClick={() => setOpen((v) => !v)} className="w-full flex items-center gap-1.5 text-[11px] text-ink-500 uppercase tracking-wider">
        <ListChecks className="w-3.5 h-3.5" /> 前置依赖
        <Tag tone="gray">{selected.length}</Tag>
        {open ? <ChevronDown className="w-3.5 h-3.5 ml-auto" /> : <ChevronRight className="w-3.5 h-3.5 ml-auto" />}
      </button>
      {open && (
        <div className="mt-2 border border-ink-300/60 rounded-md max-h-[200px] overflow-y-auto divide-y divide-ink-200/60">
          {candidates.length === 0 ? (
            <div className="p-3 text-center text-xs text-ink-400">暂无其它任务可作为前置</div>
          ) : candidates.map((c) => {
            const checked = selected.includes(c.id)
            const disabled = !checked && !!c.disabledReason
            return (
              <label
                key={c.id}
                title={[c.name, disabled ? c.disabledReason : undefined].filter(Boolean).join(' · ')}
                className={cn('flex items-center gap-2 px-3 py-1.5', disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:bg-brand-50/40', checked && 'bg-brand-50/60')}
              >
                <input type="checkbox" checked={checked} disabled={disabled} onChange={() => onToggle(c.id)} className="accent-brand-600" />
                <span className="font-mono text-[10px] text-ink-400 w-24 shrink-0 truncate" title={c.code}>{c.code}</span>
                <span className="text-xs min-w-0 truncate flex-1">{c.name}</span>
                <span className="text-[10px] text-ink-400 shrink-0">{c.subName}</span>
              </label>
            )
          })}
        </div>
      )}
    </div>
  )
}
