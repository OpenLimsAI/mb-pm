import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cn } from '../../lib/cn'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
type Size = 'sm' | 'md' | 'lg'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  icon?: ReactNode
}

const sizeClasses: Record<Size, string> = {
  sm: 'px-2 py-1 text-xs',
  md: 'px-3 py-1.5 text-sm',
  lg: 'px-4 py-2 text-base',
}

const variantClasses: Record<Variant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700',
  secondary: 'bg-white text-ink-700 border border-ink-300 hover:bg-ink-100',
  ghost: 'text-ink-700 hover:bg-ink-100',
  danger: 'bg-health-red text-white hover:bg-red-600',
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, className, children, ...props },
  ref
) {
  return (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
        sizeClasses[size],
        variantClasses[variant],
        className
      )}
      {...props}
    >
      {icon}
      {children}
    </button>
  )
})
