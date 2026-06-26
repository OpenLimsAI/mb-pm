import type { User } from '../../types'
import { cn } from '../../lib/cn'

export function Avatar({ user, size = 'md' }: { user: User; size?: 'sm' | 'md' | 'lg' }) {
  const sizeClasses = {
    sm: 'w-6 h-6 text-[10px]',
    md: 'w-8 h-8 text-xs',
    lg: 'w-10 h-10 text-sm',
  }
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center rounded-full text-white font-medium select-none',
        sizeClasses[size]
      )}
      style={{ background: user.avatarColor }}
      title={user.displayName}
    >
      {user.displayName.slice(0, 2)}
    </span>
  )
}
