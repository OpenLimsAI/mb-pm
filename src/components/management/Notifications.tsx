import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Bell, X } from 'lucide-react'
import { useAuth } from '../../store/auth'
import { useDataStore } from '../../store/data'
import { managementError, pmManagement, type NotificationItem, type NotificationMode, type NotificationSummary } from '../../api/pmManagement'

const labels: Record<NotificationItem['kind'], string> = { assignment: '任务指派', attention: '逾期 / 阻塞', due: '即将到期', mention: '提及我的', acceptance: '等待验收' }
export function Notifications() {
  const online = useDataStore(state => state.mode) === 'api'
  const userId = useAuth(state => state.currentUser?.id)
  const version = useDataStore(state => state.version)
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<NotificationSummary | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [unreadOnly, setUnreadOnly] = useState(true)
  const [reload, setReload] = useState(0)
  const button = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!online || !userId) return
    let active = true
    async function load() {
      try { const value = await pmManagement.notifications(); if (active) { setData(value); setError('') } }
      catch (err) { if (active) setError(managementError(err)) }
    }
    void load()
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load() }, 60000)
    return () => { active = false; window.clearInterval(timer) }
  }, [online, userId, reload, version])
  useEffect(() => {
    if (!open) return
    const trigger = button.current
    dialog.current?.focus()
    return () => trigger?.focus()
  }, [open])

  async function changeMode(mode: NotificationMode) {
    setBusy(true)
    try { await pmManagement.notificationMode(mode); setReload(value => value + 1) }
    catch (err) { setError(managementError(err)) } finally { setBusy(false) }
  }
  async function update(keys: string[], action: 'read' | 'unread' | 'snooze') {
    if (busy || keys.length === 0) return
    setBusy(true)
    try { for (let index = 0; index < keys.length; index += 200) await pmManagement.notificationState(keys.slice(index, index + 200), action); setReload(value => value + 1) }
    catch (err) { setError(managementError(err)) } finally { setBusy(false) }
  }
  if (!online || !userId) return null
  const visible = (data?.items || []).filter(item => !unreadOnly || !item.read)
  const showBadge = (data?.badgeCount || 0) > 0
  return <>
    <button ref={button} type="button" className="relative inline-flex items-center gap-1 px-2 py-1.5 rounded hover:bg-ink-100 text-sm" aria-label={`通知中心${data ? `，${data.unread} 条未读` : ''}`} onClick={() => { setOpen(true); setReload(value => value + 1) }}>
      <Bell className="w-4 h-4" /><span className="hidden sm:inline">通知</span>{showBadge && <span className="bg-red-600 text-white text-[10px] min-w-4 px-1 rounded-full">{data?.mode === 'daily' ? '汇总' : Math.min(data?.unread || 0, 99)}</span>}
    </button>
    {open && <div className="fixed inset-0 z-[100] flex justify-end bg-black/20" onMouseDown={event => { if (event.target === event.currentTarget) setOpen(false) }}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-label="通知中心" tabIndex={-1} className="bg-white w-full max-w-xl h-full overflow-y-auto shadow-xl p-5 space-y-4" onKeyDown={event => {
        if (event.key === 'Escape') { event.stopPropagation(); setOpen(false) }
        if (event.key === 'Tab') {
          const focusable = dialog.current?.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),select:not([disabled]),input:not([disabled])')
          if (!focusable?.length) return
          const first = focusable[0], last = focusable[focusable.length - 1]
          if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus() }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
        }
      }}>
        <div className="flex justify-between items-center"><h2 className="text-lg font-semibold">通知中心</h2><button type="button" aria-label="关闭通知中心" className="p-2 rounded hover:bg-ink-100" onClick={() => setOpen(false)}><X className="w-4 h-4" /></button></div>
        <p className="text-xs text-ink-500">站内提醒，自动合并相同事项。暂缓后 24 小时再出现；任务完成后到期提醒自动移除。</p>
        <label className="block text-sm">提醒方式<select aria-label="提醒方式" className="input mt-1" value={data?.mode || 'immediate'} disabled={busy || !data} onChange={event => void changeMode(event.target.value as NotificationMode)}><option value="immediate">即时提醒</option><option value="daily">每日汇总</option><option value="paused">暂停主动提醒</option></select></label>
        {data?.mode === 'daily' && <div className="p-3 rounded bg-brand-50 text-sm"><strong>{new Date(data.asOf).toLocaleDateString('zh-CN')} · 每日汇总</strong><p className="mt-1">{data.items.filter(item => !item.read && data.digestKeys.includes(item.key)).length} 条未读：{Object.entries(labels).map(([kind, label]) => `${label} ${data.items.filter(item => !item.read && item.kind === kind && data.digestKeys.includes(item.key)).length}`).join(' · ')}</p><p className="text-xs mt-1">每天首次读取时汇总一次；此后新增事项仍在清单中展示，次日进入新汇总。</p></div>}
        {data?.mode === 'paused' && <p className="text-sm text-ink-500">主动角标已暂停，仍可在这里查看和处理事项。</p>}
        <div className="flex flex-wrap items-center gap-3 text-sm"><label className="flex items-center gap-2"><input type="checkbox" checked={unreadOnly} onChange={event => setUnreadOnly(event.target.checked)} />只看未读</label><button type="button" className="btn" disabled={busy || !data?.items.some(item => !item.read)} onClick={() => void update((data?.items || []).filter(item => !item.read).map(item => item.key), 'read')}>全部标为已读</button><button type="button" className="btn ml-auto" onClick={() => setReload(value => value + 1)}>刷新</button></div>
        {error && <p role="alert" className="p-3 bg-red-50 text-red-700 rounded text-sm">{error}</p>}
        {!data && !error && <p role="status" className="text-sm">正在读取通知…</p>}
        {data && visible.length === 0 && <p className="text-sm text-ink-500 py-5">{unreadOnly ? '暂无未读通知。' : '暂无通知。'}</p>}
        {visible.map(item => <article key={item.key} className={`p-3 border rounded-lg space-y-2 ${item.read ? 'bg-ink-50' : 'bg-white border-brand-200'}`}><div className="flex items-center justify-between text-xs text-ink-500"><span>{labels[item.kind]}</span><span>{new Date(item.createdAt).toLocaleDateString('zh-CN')}</span></div><Link to={item.url} className="block text-sm font-medium text-brand-700 break-words" onClick={() => { void update([item.key], 'read'); setOpen(false) }}>{item.title}</Link><p className="text-sm whitespace-pre-wrap break-words">{item.detail}</p><div className="flex gap-2"><button className="btn text-xs" disabled={busy} onClick={() => void update([item.key], item.read ? 'unread' : 'read')}>{item.read ? '标为未读' : '标为已读'}</button><button className="btn text-xs" disabled={busy} onClick={() => void update([item.key], 'snooze')}>暂缓 24 小时</button></div></article>)}
        {data?.truncated && <p className="text-xs text-ink-500">显示最近 500 条，处理后刷新可查看后续事项。</p>}
      </div>
    </div>}
  </>
}
