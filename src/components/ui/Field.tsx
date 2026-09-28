import type { ReactNode } from 'react'

/** 表单字段：标签 + 控件 + 提示（有错误时显示错误）。 */
export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string | null; children: ReactNode }) {
  return (
    <label className="block text-sm space-y-1.5">
      <span className="font-medium text-ink-900">{label}</span>
      {children}
      {error ? <span className="block text-xs text-red-600">{error}</span> : hint && <span className="block text-xs text-ink-500">{hint}</span>}
    </label>
  )
}
