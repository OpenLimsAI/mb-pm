import type { User } from '../../types'
import { cn } from '../../lib/cn'

export function Avatar({ user, size = 'md' }: { user: User; size?: 'sm' | 'md' | 'lg' }) {
  const sizeClasses = {
    sm: 'w-6 h-6 text-[10px]',
    md: 'w-8 h-8 text-xs',
    lg: 'w-10 h-10 text-sm',
  }
  // 防御：单个用户缺 displayName 不应让整页崩溃（无错误边界时 render 抛错会清空整棵树）。
  const label = user?.displayName ?? user?.username ?? '?'
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full text-white font-medium select-none',
        sizeClasses[size]
      )}
      style={{ background: user?.avatarColor ?? '#94a3b8' }}
      title={label}
    >
      {label.slice(0, 2)}
    </span>
  )
}
