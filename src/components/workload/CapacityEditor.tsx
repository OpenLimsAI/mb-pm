import { useState } from 'react'
import type { User } from '../../types'
import { planningApi } from '../../api/planning'
import { asAPIError } from '../../api/client'
import { getWeeklyCapacity } from '../../lib/workingCalendar'
import { refreshAllData } from '../../data/bootstrap'
import { Button } from '../ui'

export function CapacityEditor({ user, weekKey, onSaved }: { user: User; weekKey: string; onSaved: () => void }) {
  const current = getWeeklyCapacity(user.id, weekKey)
  const [hours, setHours] = useState(String(current?.availableHours ?? user.weeklyAvailableHours ?? 40))
  const [leave, setLeave] = useState(String(current?.leaveHours ?? 0))
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const valid = hours !== '' && leave !== '' && Number.isFinite(Number(hours)) && Number.isFinite(Number(leave)) && Number(hours) >= 0 && Number(hours) <= 168 && Number(leave) >= 0 && Number(leave) <= Number(hours)
  const save = async () => {
    setPending(true); setError('')
    try {
      await planningApi.saveCapacity({ userId: user.id, weekStart: weekKey, availableHours: Number(hours), leaveHours: Number(leave), revision: current?.revision ?? 0 })
      await refreshAllData()
      onSaved()
    } catch (error) { setError(asAPIError(error).detail) }
    finally { setPending(false) }
  }
  return <details className="m-3 p-3 border rounded text-sm"><summary className="cursor-pointer">调整本周容量 / 请假</summary><div className="mt-3 space-y-3">
    <label className="block">本周可用工时（请假前）<input aria-label="本周可用工时" className="input mt-1" type="number" min={0} max={168} step={0.5} value={hours} onChange={e => setHours(e.target.value)} /></label>
    <label className="block">本周请假 / 不可用工时<input aria-label="本周请假工时" className="input mt-1" type="number" min={0} max={Number(hours)} step={0.5} value={leave} onChange={e => setLeave(e.target.value)} /></label>
    <p className="text-xs text-ink-500">净可用：{valid ? Number(hours) - Number(leave) : '—'} 小时。0 小时会明确标记容量不足。</p>
    {error && <p role="alert" className="text-red-700">{error}</p>}
    <Button size="sm" disabled={pending || !valid} onClick={() => void save()}>{pending ? '保存中…' : '保存本周容量'}</Button>
  </div></details>
}
