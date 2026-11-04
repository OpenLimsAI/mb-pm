import { RefreshCw } from 'lucide-react'
import { useDataStore } from '../../store/data'
import { refreshAllData } from '../../data/bootstrap'

export function SyncStatus() {
  const { mode, lastSyncedAt, syncing, syncError, businessDate, businessTimezone } = useDataStore()
  if (mode !== 'api') return null
  return <div className="relative text-xs text-ink-500"><button type="button" disabled={syncing} className="inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-ink-100" title={syncError || `业务日期 ${businessDate || '加载中'}（${businessTimezone || ''}）；每分钟自动同步`} onClick={() => void refreshAllData().catch(() => {})}>
    <RefreshCw size={13} className={syncing ? 'animate-spin' : ''} />
    <span className={syncError ? 'text-red-700' : ''}>{syncError ? '同步失败，点击重试' : syncing ? '同步中' : lastSyncedAt ? `更新于 ${new Date(lastSyncedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : '刷新数据'}</span>
  </button>{syncError && <span role="status" className="sr-only">同步失败：{syncError}，当前保留上次成功数据。</span>}</div>
}
