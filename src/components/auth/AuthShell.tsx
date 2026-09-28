import type { ReactNode } from 'react'
import { Beaker } from 'lucide-react'

/** 登录 / 注册页共用的外框：居中卡片 + 系统标识。 */
export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-full bg-ink-100 flex items-center justify-center p-8">
      <div className="card p-8 w-full max-w-md">
        <div className="flex items-center gap-3 mb-8">
          <div className="w-10 h-10 rounded-lg bg-brand-600 flex items-center justify-center text-white">
            <Beaker className="w-6 h-6" />
          </div>
          <div>
            <div className="text-lg font-semibold text-ink-900 leading-tight">CMC-PMS</div>
            <div className="text-xs text-ink-500">研发项目组合 · 决策视图</div>
          </div>
        </div>
        {children}
      </div>
    </div>
  )
}
