import type { ReactNode } from 'react'
import { Sparkles } from 'lucide-react'

export function PMAssistantSurface({ standalone, open, onToggle, children }: {
  standalone: boolean
  open: boolean
  onToggle: (open: boolean) => void
  children: ReactNode
}) {
  const className = 'rounded-xl border border-brand-200 bg-white p-4'
  if (standalone) return <section aria-label="助手工作区" className={className}>{children}</section>
  return <details className={className} open={open} onToggle={event => onToggle(event.currentTarget.open)}>
    <summary className="cursor-pointer text-sm font-semibold text-brand-700">
      <Sparkles className="mr-2 inline h-4 w-4" />项目 AI 助手
    </summary>
    {children}
  </details>
}
