// 三级模板树编辑器（FR-TE-001）
// - 折叠/展开 Lv2
// - 上下移动 / 删除 / 增加子节点 / 增加任务
// - 选中节点（用于属性面板编辑）
// - 强约束：Lv3 不能加子节点

import { useState } from 'react'
import {
  ChevronDown, ChevronRight, Plus, ArrowUp, ArrowDown, Trash2, Diamond, Edit3, FolderPlus,
} from 'lucide-react'
import type { TemplateNode } from '../../types'
import { Tag } from '../ui'
import { cn } from '../../lib/cn'

interface Props {
  root: TemplateNode
  selectedId?: string
  onSelect: (id: string) => void
  onMove: (id: string, dir: 'up' | 'down') => void
  onDelete: (id: string) => void
  onAddTask: (subId: string) => void
  onAddSubProject: () => void
  readOnly?: boolean
}

export function TemplateTree({
  root, selectedId, onSelect, onMove, onDelete, onAddTask, onAddSubProject, readOnly,
}: Props) {
  return (
    <div>
      <div className="flex items-center justify-between px-3 py-2 bg-ink-100 border-b border-ink-300/40 sticky top-0 z-10">
        <div className="text-xs font-medium text-ink-700">模板结构</div>
        {!readOnly && (
          <button
            onClick={onAddSubProject}
            className="inline-flex items-center gap-1 text-xs text-brand-700 hover:bg-brand-50 px-2 py-1 rounded"
          >
            <FolderPlus className="w-3.5 h-3.5" />
            新增子项目（Lv2）
          </button>
        )}
      </div>

      <ul className="divide-y divide-ink-300/40">
        {root.children?.map((sub, idx, arr) => (
          <SubProjectNode
            key={sub.id}
            sub={sub}
            index={idx}
            siblingCount={arr.length}
            selectedId={selectedId}
            onSelect={onSelect}
            onMove={onMove}
            onDelete={onDelete}
            onAddTask={onAddTask}
            readOnly={readOnly}
          />
        ))}
      </ul>

      {(!root.children || root.children.length === 0) && (
        <div className="text-center py-12 text-sm text-ink-500">
          模板为空。
          {!readOnly && <button onClick={onAddSubProject} className="text-brand-600 ml-1 hover:underline">新增子项目</button>}
        </div>
      )}
    </div>
  )
}

function SubProjectNode({
  sub, index, siblingCount, selectedId, onSelect, onMove, onDelete, onAddTask, readOnly,
}: {
  sub: TemplateNode
  index: number
  siblingCount: number
  selectedId?: string
  onSelect: (id: string) => void
  onMove: (id: string, dir: 'up' | 'down') => void
  onDelete: (id: string) => void
  onAddTask: (id: string) => void
  readOnly?: boolean
}) {
  const [open, setOpen] = useState(true)
  const tasks = sub.children || []
  const isSelected = selectedId === sub.id

  return (
    <li>
      {/* Lv2 行 */}
      <div
        className={cn(
          'flex items-center gap-2 px-3 py-2 cursor-pointer group',
          isSelected ? 'bg-brand-50 border-l-2 border-brand-600' : 'hover:bg-ink-100/40'
        )}
        onClick={() => onSelect(sub.id)}
      >
        <button onClick={(e) => { e.stopPropagation(); setOpen((v) => !v) }} className="text-ink-500">
          {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </button>
        <span className="tag bg-purple-100 text-purple-800 font-mono shrink-0">Lv2</span>
        <span className="text-sm font-medium text-ink-900 min-w-0 truncate flex-1" title={sub.name}>{sub.name}</span>
        {sub.module && <Tag tone="gray">{sub.module}</Tag>}
        {sub.stage && <Tag tone="blue">{sub.stage}</Tag>}
        <span className="text-xs text-ink-500 shrink-0">{tasks.length} 任务</span>

        {!readOnly && (
          <div className="flex items-center opacity-0 group-hover:opacity-100" onClick={(e) => e.stopPropagation()}>
            <IconBtn title="新增任务" onClick={() => { onAddTask(sub.id); setOpen(true) }}>
              <Plus className="w-3.5 h-3.5" />
            </IconBtn>
            <IconBtn title="上移" onClick={() => onMove(sub.id, 'up')} disabled={index === 0}>
              <ArrowUp className="w-3.5 h-3.5" />
            </IconBtn>
            <IconBtn title="下移" onClick={() => onMove(sub.id, 'down')} disabled={index === siblingCount - 1}>
              <ArrowDown className="w-3.5 h-3.5" />
            </IconBtn>
            <IconBtn title="删除" onClick={() => onDelete(sub.id)} danger>
              <Trash2 className="w-3.5 h-3.5" />
            </IconBtn>
          </div>
        )}
      </div>

      {/* Lv3 任务列表 */}
      {open && (
        <ul className="bg-ink-100/30">
          {tasks.map((t, i) => (
            <TaskNode
              key={t.id}
              task={t}
              index={i}
              siblingCount={tasks.length}
              selectedId={selectedId}
              onSelect={onSelect}
              onMove={onMove}
              onDelete={onDelete}
              readOnly={readOnly}
            />
          ))}
          {tasks.length === 0 && (
            <li className="pl-12 pr-3 py-1.5 text-xs text-ink-500 italic">
              该子项目下暂无任务
              {!readOnly && (
                <button onClick={() => onAddTask(sub.id)} className="ml-2 text-brand-600 hover:underline">+ 新增任务</button>
              )}
            </li>
          )}
        </ul>
      )}
    </li>
  )
}

function TaskNode({
  task, index, siblingCount, selectedId, onSelect, onMove, onDelete, readOnly,
}: {
  task: TemplateNode
  index: number
  siblingCount: number
  selectedId?: string
  onSelect: (id: string) => void
  onMove: (id: string, dir: 'up' | 'down') => void
  onDelete: (id: string) => void
  readOnly?: boolean
}) {
  const isSelected = selectedId === task.id
  return (
    <li
      className={cn(
        'flex items-center gap-2 pl-12 pr-3 py-1.5 cursor-pointer group',
        isSelected ? 'bg-brand-50 border-l-2 border-brand-600' : 'hover:bg-white'
      )}
      onClick={() => onSelect(task.id)}
    >
      <span className="tag bg-emerald-100 text-emerald-800 font-mono shrink-0">Lv3</span>
      {task.isMilestone && <Diamond className="w-3 h-3 text-amber-600 shrink-0" />}
      {task.taskCode && <span className="font-mono text-[10px] text-ink-500 shrink-0">{task.taskCode}</span>}
      <span className={cn('text-sm min-w-0 flex-1 truncate', task.isMilestone ? 'font-semibold' : 'text-ink-900')} title={task.name}>
        {task.name}
      </span>
      {task.module && <Tag tone="gray">{task.module}</Tag>}
      {!task.isMilestone && task.defaultDuration !== undefined && (
        <span className="text-[11px] text-ink-500 font-mono shrink-0">{task.defaultDuration}d</span>
      )}
      {!task.isMilestone && task.defaultEffort !== undefined && (
        <span className="text-[11px] text-ink-500 font-mono shrink-0">{task.defaultEffort}人天</span>
      )}
      {task.predecessors && task.predecessors.length > 0 && (
        <span className="text-[10px] text-ink-500 shrink-0" title={task.predecessors.map((p) => p.taskCode).join(', ')}>
          ←{task.predecessors.length}
        </span>
      )}

      {!readOnly && (
        <div className="flex items-center opacity-0 group-hover:opacity-100 shrink-0" onClick={(e) => e.stopPropagation()}>
          <IconBtn title="编辑" onClick={() => onSelect(task.id)}>
            <Edit3 className="w-3.5 h-3.5" />
          </IconBtn>
          <IconBtn title="上移" onClick={() => onMove(task.id, 'up')} disabled={index === 0}>
            <ArrowUp className="w-3.5 h-3.5" />
          </IconBtn>
          <IconBtn title="下移" onClick={() => onMove(task.id, 'down')} disabled={index === siblingCount - 1}>
            <ArrowDown className="w-3.5 h-3.5" />
          </IconBtn>
          <IconBtn title="删除" onClick={() => onDelete(task.id)} danger>
            <Trash2 className="w-3.5 h-3.5" />
          </IconBtn>
        </div>
      )}
    </li>
  )
}

function IconBtn({
  title, onClick, children, disabled, danger,
}: { title: string; onClick: () => void; children: React.ReactNode; disabled?: boolean; danger?: boolean }) {
  return (
    <button
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'p-1 rounded transition-colors',
        danger ? 'text-red-500 hover:bg-red-50' : 'text-ink-500 hover:bg-ink-100 hover:text-ink-900',
        disabled && 'opacity-30 cursor-not-allowed'
      )}
    >
      {children}
    </button>
  )
}
