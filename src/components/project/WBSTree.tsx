import { useState } from 'react'
import { ChevronDown, ChevronRight, FolderTree, Diamond, Plus, MoreHorizontal, Flame } from 'lucide-react'
import type { Project, SubProject, Task } from '../../types'
import { Card, CardHeader, CardBody, Tag, StatusTag, Avatar } from '../ui'
import { findUser, getProjectSubs, getSubTasks } from '../../mock'
import { cn } from '../../lib/cn'

interface Props {
  project: Project
  onSelectTask?: (taskId: string) => void
  selectedTaskId?: string
  highlightCriticalPath?: boolean
  criticalPathIds?: Set<string>
}

export function WBSTree({ project, onSelectTask, selectedTaskId, highlightCriticalPath, criticalPathIds }: Props) {
  const subs = getProjectSubs(project.id).sort((a, b) => a.sortOrder - b.sortOrder)
  const owner = findUser(project.ownerId)

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <FolderTree className="w-4 h-4 text-brand-600" />
            三级 WBS
          </span>
        }
        subtitle={`项目（Lv1）→ 子项目（Lv2，${subs.length}）→ 任务（Lv3）· 系统不允许 Lv3 下创建子节点`}
      />
      <CardBody className="p-0">
        {/* Level 1：项目 */}
        <div className="border-b border-ink-300/40 bg-brand-50/40 px-4 py-2.5 flex items-center gap-2">
          <span className="tag bg-brand-100 text-brand-800 font-mono">Lv1</span>
          <span className="font-medium text-ink-900">{project.code}</span>
          <span className="text-sm text-ink-700 truncate flex-1" title={project.name}>{project.name}</span>
          {owner && <Avatar user={owner} size="sm" />}
          <span className="text-xs text-ink-500">{project.progress}%</span>
        </div>

        {/* Level 2 + Level 3 */}
        <ul className="divide-y divide-ink-300/40">
          {subs.map((sub) => (
            <SubProjectNode
              key={sub.id}
              sub={sub}
              onSelectTask={onSelectTask}
              selectedTaskId={selectedTaskId}
              highlightCriticalPath={highlightCriticalPath}
              criticalPathIds={criticalPathIds}
            />
          ))}
        </ul>
      </CardBody>
    </Card>
  )
}

function SubProjectNode({ sub, onSelectTask, selectedTaskId, highlightCriticalPath, criticalPathIds }: {
  sub: SubProject
  onSelectTask?: (id: string) => void
  selectedTaskId?: string
  highlightCriticalPath?: boolean
  criticalPathIds?: Set<string>
}) {
  const [open, setOpen] = useState(true)
  const tasks = getSubTasks(sub.id)
  const owner = findUser(sub.ownerId || '')

  return (
    <li>
      <div
        className="px-4 py-2 flex items-center gap-2 hover:bg-ink-100/40 cursor-pointer group"
        onClick={() => setOpen((v) => !v)}
      >
        <button className="text-ink-500">
          {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </button>
        <span className="tag bg-purple-100 text-purple-800 font-mono">Lv2</span>
        <span className="text-sm font-medium text-ink-900 truncate" title={sub.name}>{sub.name}</span>
        <Tag tone="blue">{sub.stage}</Tag>
        <Tag tone="gray">{sub.module}</Tag>
        <div className="flex-1" />
        <div className="flex items-center gap-3">
          {owner && <Avatar user={owner} size="sm" />}
          <span className="text-xs text-ink-500">{tasks.length} 任务</span>
          <ProgressMini value={sub.progress} />
          <button
            onClick={(e) => e.stopPropagation()}
            className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-ink-100 transition-opacity"
            title="创建任务（Lv3）"
          >
            <Plus className="w-3.5 h-3.5 text-ink-700" />
          </button>
        </div>
      </div>

      {open && (
        <ul className="pl-8 pr-4 pb-1 bg-ink-100/30">
          {tasks.map((t) => (
            <TaskNode
              key={t.id}
              task={t}
              selected={selectedTaskId === t.id}
              onSelect={onSelectTask}
              highlightCriticalPath={highlightCriticalPath}
              isCritical={criticalPathIds?.has(t.id)}
            />
          ))}
          {tasks.length === 0 && (
            <li className="py-2 text-xs text-ink-500 italic">暂无任务</li>
          )}
        </ul>
      )}
    </li>
  )
}

function TaskNode({
  task, selected, onSelect, highlightCriticalPath, isCritical,
}: {
  task: Task
  selected?: boolean
  onSelect?: (id: string) => void
  highlightCriticalPath?: boolean
  isCritical?: boolean
}) {
  const owner = findUser(task.ownerId)
  const Icon = task.isMilestone ? Diamond : null
  return (
    <li>
      <div
        className={cn(
          'flex items-center gap-2 py-1.5 px-2 rounded-md cursor-pointer group',
          selected ? 'bg-brand-50 border border-brand-300' : 'hover:bg-white border border-transparent',
          highlightCriticalPath && isCritical && !selected && 'ring-1 ring-red-200'
        )}
        onClick={() => onSelect?.(task.id)}
      >
        <span className="tag bg-emerald-100 text-emerald-800 font-mono">Lv3</span>
        {Icon && <Icon className="w-3.5 h-3.5 text-amber-600 shrink-0" />}
        <span className="font-mono text-[10px] text-ink-500 shrink-0">{task.code}</span>
        <span
          className={cn(
            'text-sm truncate flex-1',
            task.isMilestone ? 'font-semibold' : 'text-ink-900'
          )}
          title={task.name}
        >
          {task.name}
        </span>
        {isCritical && <Flame className="w-3 h-3 text-red-500 shrink-0" aria-label="关键路径" />}
        <StatusTag status={task.status} />
        {!task.isMilestone && <span className="text-[11px] text-ink-500 shrink-0">{task.estimatedEffort}d</span>}
        {owner && <Avatar user={owner} size="sm" />}
        <button
          onClick={(e) => e.stopPropagation()}
          className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-ink-100 transition-opacity"
          title="任务操作"
        >
          <MoreHorizontal className="w-3 h-3 text-ink-500" />
        </button>
      </div>
    </li>
  )
}

function ProgressMini({ value }: { value: number }) {
  return (
    <div className="flex items-center gap-1.5 w-24">
      <div className="flex-1 h-1.5 bg-ink-100 rounded">
        <div className="h-full bg-brand-500 rounded" style={{ width: `${value}%` }} />
      </div>
      <span className="text-[10px] text-ink-500 w-7 text-right">{value}%</span>
    </div>
  )
}
