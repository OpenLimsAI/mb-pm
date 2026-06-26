import type { HTMLAttributes } from 'react'
import { cn } from '../../lib/cn'
import type { Health, TaskStatus, Priority } from '../../types'

type Tone = 'gray' | 'blue' | 'green' | 'yellow' | 'red' | 'purple'

const toneClasses: Record<Tone, string> = {
  gray: 'bg-ink-100 text-ink-700',
  blue: 'bg-brand-50 text-brand-700',
  green: 'bg-emerald-50 text-emerald-700',
  yellow: 'bg-amber-50 text-amber-700',
  red: 'bg-red-50 text-red-700',
  purple: 'bg-purple-50 text-purple-700',
}

interface TagProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone
}

export function Tag({ tone = 'gray', className, children, ...props }: TagProps) {
  return (
    <span className={cn('tag', toneClasses[tone], className)} {...props}>
      {children}
    </span>
  )
}

const healthMap: Record<Health, { tone: Tone; label: string; dot: string }> = {
  green:  { tone: 'green',  label: '健康', dot: 'bg-emerald-500' },
  yellow: { tone: 'yellow', label: '关注', dot: 'bg-amber-500' },
  red:    { tone: 'red',    label: '风险', dot: 'bg-red-500' },
}

export function HealthTag({ health }: { health: Health }) {
  const m = healthMap[health]
  return (
    <Tag tone={m.tone} className="gap-1">
      <span className={cn('w-1.5 h-1.5 rounded-full', m.dot)} />
      {m.label}
    </Tag>
  )
}

const statusMap: Record<TaskStatus, Tone> = {
  '未开始': 'gray',
  '进行中': 'blue',
  '阻塞': 'purple',
  '延迟': 'red',
  '已完成': 'green',
  '已验证': 'green',
}

export function StatusTag({ status }: { status: TaskStatus }) {
  return <Tag tone={statusMap[status]}>{status}</Tag>
}

const priorityMap: Record<Priority, Tone> = { '高': 'red', '中': 'yellow', '低': 'gray' }

export function PriorityTag({ priority }: { priority: Priority }) {
  return <Tag tone={priorityMap[priority]}>{priority}</Tag>
}
