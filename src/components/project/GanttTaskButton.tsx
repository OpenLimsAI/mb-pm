import type { CSSProperties, ReactNode } from 'react'
import type { Task } from '../../types'
import { cn } from '../../lib/cn'

interface Props {
  task: Task
  ownerName?: string
  onSelectTask?: (id: string) => void
  className?: string
  style?: CSSProperties
  compact?: boolean
  children?: ReactNode
}

/** Shared task interaction for project and portfolio timelines. */
export function GanttTaskButton({ task, ownerName, onSelectTask, className, style, compact = false, children }: Props) {
  const owner = ownerName?.trim() || '未分配'
  const width = typeof style?.width === 'number'
    ? style.width
    : typeof style?.width === 'string' && /^\d+(?:\.\d+)?px$/.test(style.width)
      ? parseFloat(style.width)
      : 0
  const details = [
    task.name,
    `任务编号：${task.code}`,
    `负责人：${owner}`,
    `计划开始：${task.plannedStart}`,
    `计划结束：${task.plannedEnd}`,
    `状态：${task.status}`,
    `进度：${task.progress}%`,
  ]

  return (
    <button
      type="button"
      className={cn(
        'appearance-none p-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-300 focus-visible:ring-offset-1 focus-visible:z-10',
        className,
      )}
      style={style}
      title={details.join('\n')}
      aria-label={details.join('，')}
      onClick={() => onSelectTask?.(task.id)}
    >
      {children}
      {!task.isMilestone && width >= 48 && (
        <span className={cn(
          'gantt-task-name pointer-events-none relative block truncate px-1.5 text-[12px] font-bold text-slate-950',
          compact ? 'leading-[18px]' : 'leading-[20px]',
        )}>
          {task.name}
        </span>
      )}
    </button>
  )
}
