import type { ReactNode, HTMLAttributes } from 'react'
import { cn } from '../../lib/cn'

export function Table({ className, ...props }: HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="overflow-auto">
      <table className={cn('w-full text-sm', className)} {...props} />
    </div>
  )
}

export function THead({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn('bg-ink-100/70 text-ink-500 text-xs', className)} {...props} />
}

export function TR({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn('border-b border-ink-300/40 hover:bg-ink-100/40', className)} {...props} />
}

export function TH({ className, children, ...props }: HTMLAttributes<HTMLTableCellElement>) {
  return <th className={cn('px-3 py-2 text-left font-medium', className)} {...props}>{children}</th>
}

export function TD({ className, children, ...props }: HTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('px-3 py-2.5', className)} {...props}>{children}</td>
}

export function EmptyRow({ colSpan, message = '暂无数据' }: { colSpan: number; message?: ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="text-center py-12 text-ink-500 text-sm">{message}</td>
    </tr>
  )
}
