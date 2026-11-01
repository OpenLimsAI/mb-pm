import { AlertTriangle, Loader2, LogOut, RotateCw } from 'lucide-react'
import { Button } from '../ui/Button'

export function BootSplash({ message = '正在加载 CMC-PMS 数据 …' }: { message?: string }) {
  return (
    <div className="h-full min-h-64 flex flex-col items-center justify-center gap-4 text-ink-500">
      <img className="w-14 h-14 rounded bg-white object-contain" src="/brand/maibo-pharma-logo.png" alt="迈博药业" />
      <div className="flex items-center gap-2 text-sm" role="status">
        <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> {message}
      </div>
    </div>
  )
}

export function IdentityProblem({ message, onLogout }: { message: string | null; onLogout: () => void }) {
  return (
    <div className="h-full flex items-center justify-center p-8">
      <div className="card p-6 w-full max-w-md">
        <div className="flex items-center gap-2 text-amber-600 mb-3">
          <AlertTriangle className="w-5 h-5" />
          <h1 className="text-base font-semibold text-ink-900">无法确认登录身份</h1>
        </div>
        <p role="alert" className="text-sm text-ink-700">{message || '身份验证失败，请稍后重试。'}</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button icon={<LogOut className="w-4 h-4" />} onClick={onLogout}>切换账号</Button>
          <Button variant="primary" icon={<RotateCw className="w-4 h-4" />} onClick={() => window.location.reload()}>
            重试
          </Button>
        </div>
      </div>
    </div>
  )
}

/** Recoverable status belongs beside the editor, never in place of it. */
export function IdentityRetryNotice({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <div role="status" className="relative z-50 flex flex-wrap items-center justify-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900"><AlertTriangle size={16} aria-hidden="true" /><span>{message}</span><Button size="sm" icon={<RotateCw size={14} />} onClick={onRetry}>重试身份验证</Button></div>
}
