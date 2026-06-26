import type { ReactNode } from 'react'
import { Inbox } from 'lucide-react'

export function EmptyState({
  icon = <Inbox className="w-10 h-10 text-ink-300" />,
  title = '暂无数据',
  description,
  action,
}: {
  icon?: ReactNode
  title?: ReactNode
  description?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
      <div className="mb-3">{icon}</div>
      <h4 className="text-base font-medium text-ink-700">{title}</h4>
      {description && <p className="text-sm text-ink-500 mt-1">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}
