import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { asAPIError } from '../../api/client'
import { applyScheduleAssist, previewScheduleAssist, type ScheduleAssistPreview, type ScheduleAssistReceipt } from '../../api/projectAIWork'
import { listTasks } from '../../api/tasks'
import { refreshAllData } from '../../data/bootstrap'
import type { Task } from '../../types'
import { Button } from '../ui'

type Preview = ScheduleAssistPreview & { taskVersion: string }
type Verification = 'checking' | 'verified' | 'changed' | 'unavailable'
type SavedConfirmation = { preview: Preview; reason: string; receipt?: ScheduleAssistReceipt }

function readConfirmation(key: string): SavedConfirmation | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? 'null') as SavedConfirmation | null
    return typeof value?.preview?.confirmationToken === 'string' && Array.isArray(value.preview.schedule?.changes)
      && Array.isArray(value.preview.schedule.conflicts) && Array.isArray(value.preview.lockedMilestones)
      && typeof value.reason === 'string' ? value : null
  } catch {
    return null
  }
}

function clearConfirmation(key: string, token: string | null) {
  try {
    if (readConfirmation(key)?.preview.confirmationToken === token) sessionStorage.removeItem(key)
  } catch { /* Storage can be disabled while a request is in flight. */ }
}

function retainReceipt(key: string, result: ScheduleAssistReceipt, token: string) {
  try {
    const saved = readConfirmation(key)
    if (saved?.preview.confirmationToken === token) sessionStorage.setItem(key, JSON.stringify({ ...saved, receipt: result }))
  } catch { /* The original confirmation can still retrieve the receipt. */ }
}

export function ScheduleAssist({ userId, projectId, task, editorDirty }: { userId: string; projectId: string; task: Task; editorDirty: boolean }) {
  const storageKey = `pm-schedule-confirmation:${JSON.stringify([userId, projectId, task.id])}`
  const [restored] = useState(() => readConfirmation(storageKey))
  const [instruction, setInstruction] = useState('')
  const [reason, setReason] = useState(restored?.reason ?? '')
  const [preview, setPreview] = useState<Preview | null>(restored?.preview ?? null)
  const [receipt, setReceipt] = useState<ScheduleAssistReceipt | null>(restored?.receipt ?? null)
  const [pending, setPending] = useState<'preview' | 'apply' | null>(null)
  const [error, setError] = useState('')
  const [expired, setExpired] = useState(false)
  const [uncertain, setUncertain] = useState(!!restored && !restored.receipt)
  const [verification, setVerification] = useState<Verification>('unavailable')
  const [syncFailed, setSyncFailed] = useState(false)
  const controller = useRef<AbortController | null>(null)
  const taskVersion = [task.revision, task.status, task.plannedStart, task.plannedEnd].join(':')
  const stale = preview?.taskVersion !== taskVersion
  const completed = task.status === '已完成' || task.status === '已验证'
  const blocked = editorDirty || completed
  const confirmable = !!preview?.confirmationToken && !!preview.schedule.changes.length && !preview.schedule.conflicts.length
  const taskPath = (id: string) => `/projects/${encodeURIComponent(projectId)}?tab=wbs&task=${encodeURIComponent(id)}`

  useEffect(() => () => controller.current?.abort(), [])
  useEffect(() => {
    if (!preview?.expiresAt || receipt) return
    const timer = window.setTimeout(() => setExpired(true), Math.max(0, Date.parse(preview.expiresAt) - Date.now()))
    return () => window.clearTimeout(timer)
  }, [preview, receipt])

  async function review() {
    if (!instruction.trim() || pending || blocked || uncertain || receipt) return
    const request = new AbortController()
    controller.current = request
    setPending('preview')
    setError('')
    setPreview(null)
    try {
      const result = await previewScheduleAssist(projectId, task.id, instruction.trim(), request.signal)
      if (request.signal.aborted) return
      setExpired(!result.expiresAt || !(Date.parse(result.expiresAt) > Date.now()))
      setPreview({ ...result, taskVersion })
    } catch (e) {
      if (!request.signal.aborted) setError(asAPIError(e).detail)
    } finally {
      if (!request.signal.aborted) setPending(null)
    }
  }

  async function verify(result: ScheduleAssistReceipt, locked: ScheduleAssistPreview['lockedMilestones']) {
    setVerification('checking')
    setSyncFailed(false)
    const [read, sync] = await Promise.allSettled([listTasks({ projectId, pageSize: 5000 }), refreshAllData()])
    setSyncFailed(sync.status === 'rejected')
    if (read.status === 'rejected') {
      setVerification('unavailable')
      return
    }
    const byId = new Map(read.value.items.map(item => [item.id, item]))
    const expected = [
      ...result.schedule.changes.map(change => ({ taskId: change.taskId, start: change.newStart, end: change.newEnd })),
      ...locked.map(milestone => ({ taskId: milestone.taskId, start: milestone.startDate, end: milestone.date })),
    ]
    if (expected.some(item => !byId.has(item.taskId))) {
      setVerification('unavailable')
    } else {
      setVerification(expected.every(item => {
        const current = byId.get(item.taskId)
        return current?.plannedStart === item.start && current.plannedEnd === item.end
      }) ? 'verified' : 'changed')
    }
  }

  async function apply() {
    if (!preview?.confirmationToken || !confirmable || pending || editorDirty || receipt || !reason.trim()) return
    if (!uncertain && (completed || stale || expired || !(Date.parse(preview.expiresAt ?? '') > Date.now()))) return
    try {
      sessionStorage.setItem(storageKey, JSON.stringify({ preview, reason: reason.trim() }))
    } catch {
      setError('浏览器暂时无法保存本次确认记录。请允许此页面使用会话存储后重试。')
      return
    }
    setPending('apply')
    setError('')
    try {
      const result = await applyScheduleAssist(projectId, preview.confirmationToken, reason.trim())
      retainReceipt(storageKey, result, preview.confirmationToken)
      setReceipt(result)
      setUncertain(false)
      void verify(result, preview.lockedMilestones)
    } catch (e) {
      const failure = asAPIError(e)
      if (failure.status && failure.status >= 400 && failure.status < 500 && ![408, 429].includes(failure.status)) {
        clearConfirmation(storageKey, preview.confirmationToken)
        setError(failure.detail)
        setPreview(null)
        setUncertain(false)
      } else {
        setUncertain(true)
      }
    } finally {
      setPending(null)
    }
  }

  function startOver() {
    clearConfirmation(storageKey, preview?.confirmationToken ?? null)
    setReceipt(null)
    setPreview(null)
    setInstruction('')
    setReason('')
    setError('')
  }

  return (
    <details className="rounded-lg border border-ink-200 p-3">
      <summary className="cursor-pointer text-sm font-medium text-brand-700">AI 排期推演</summary>
      <div className="mt-3 space-y-3 text-sm">
        <p className="break-words text-ink-600">当前任务 {task.code} · {task.name}</p>
        {!receipt && <>
          {editorDirty && <p className="text-amber-800">请先处理未保存的进展，再调整排期。</p>}
          {completed && !uncertain && <p className="text-ink-600">当前任务已完成或已验证。</p>}
          <fieldset disabled={!!pending || blocked || uncertain} className="space-y-2">
            <label className="block">
              延期要求
              <textarea className="input mt-1" maxLength={800} rows={2} value={instruction}
                placeholder="例如，延迟 5 个工作日，IND 申报里程碑保持不动"
                onChange={e => { setInstruction(e.target.value); setPreview(null); setError('') }} />
            </label>
            <p className="text-xs text-ink-500">请写明当前任务要顺延几个工作日。可以用名称或编号指定一个保持不动的里程碑。</p>
            <Button size="sm" disabled={!instruction.trim()} onClick={() => void review()}>
              {pending === 'preview' ? '正在推演…' : '预览排期影响'}
            </Button>
          </fieldset>
        </>}
        {preview && (
          <div className="space-y-3 border-t border-ink-200 pt-3">
            <p className="font-medium">顺延 {preview.delayWorkdays} 个工作日 · 涉及 {preview.schedule.changes.length} 项调整</p>
            <p>项目完工 {preview.schedule.previousFinish} → {preview.schedule.newFinish}</p>
            {preview.lockedMilestones.length > 0 ? <ul className="space-y-1">
              {preview.lockedMilestones.map(item => <li key={item.taskId} className="break-words">
                保持不动 <Link className="text-brand-700 underline" to={taskPath(item.taskId)} target="_blank" rel="noreferrer">{item.code} · {item.name}</Link> · {item.startDate === item.date ? item.date : `${item.startDate} 至 ${item.date}`}
              </li>)}
            </ul> : <p className="text-ink-500">未指定锁定里程碑。</p>}
            {preview.schedule.conflicts.length > 0 && <div role="alert" className="space-y-1 rounded bg-red-50 p-2 text-red-800">
              <p className="font-medium">存在排期冲突，请调整要求后重新推演。</p>
              {preview.schedule.conflicts.map((conflict, index) => (
                <p key={`${conflict.taskId}-${index}`} className="break-words">{conflict.name}：{conflict.reason}</p>
              ))}
            </div>}
            {preview.schedule.changes.length > 0 && <div className="max-h-64 overflow-auto rounded border border-ink-200">
              <table className="w-full text-left text-xs" aria-label="排期调整前后对比">
                <thead className="sticky top-0 bg-ink-100"><tr><th scope="col" className="p-2">任务</th><th scope="col" className="p-2">原计划</th><th scope="col" className="p-2">新计划</th></tr></thead>
                <tbody>{preview.schedule.changes.map(change => <tr className="border-t border-ink-200" key={change.taskId}>
                  <td className="p-2 break-words"><Link className="text-brand-700 underline" to={taskPath(change.taskId)}
                    target="_blank" rel="noreferrer">{change.code} · {change.name}</Link></td>
                  <td className="p-2">{change.oldStart}<br />{change.oldEnd}</td>
                  <td className="p-2 font-medium text-brand-700">{change.newStart}<br />{change.newEnd}</td>
                </tr>)}</tbody>
              </table>
            </div>}
            {!receipt && confirmable && <>
              {!uncertain && (expired || stale) && <p className="text-amber-800">{expired ? '预览已过期' : '任务已更新'}，请重新推演。</p>}
              {uncertain && <p role="status" className="text-amber-800">
                暂未收到执行回执。重试将继续这次已确认的调整，若已执行则返回原回执。
              </p>}
              <label className="block">
                调整原因
                <input className="input mt-1" maxLength={2000} value={reason} disabled={!!pending || blocked || uncertain}
                  onChange={e => setReason(e.target.value)} />
              </label>
              <Button size="sm" variant="primary"
                disabled={!!pending || editorDirty || !reason.trim() || (!uncertain && (completed || expired || stale))}
                onClick={() => void apply()}>
                {pending === 'apply' ? '正在确认…' : uncertain ? '重试本次确认' : `确认应用 ${preview.schedule.changes.length} 项调整`}
              </Button>
            </>}
          </div>
        )}
        {error && <p role="alert" className="break-words text-red-700">{error}</p>}
        {receipt && <div className="space-y-2 rounded bg-brand-50 p-3">
          <div role="status" className="space-y-1">
            <p className="font-medium">调整已应用 · 回执 {receipt.receiptId}</p>
            <p>{{
              checking: '正在读取最新任务日期…',
              verified: '已核验受影响任务和锁定里程碑的日期。',
              changed: '最新任务日期与回执不一致，请查看当前计划。',
              unavailable: '暂未核验全部任务日期，可重新读取。',
            }[verification]}</p>
            {syncFailed && <p>页面同步失败，可重新同步。</p>}
          </div>
          {verification !== 'checking' && (verification !== 'verified' || syncFailed) && <Button size="sm"
            onClick={() => void verify(receipt, preview?.lockedMilestones ?? [])}>重新核验并同步</Button>}
          <Button className="ml-2" size="sm" disabled={verification === 'checking'} onClick={startOver}>开始新的推演</Button>
        </div>}
      </div>
    </details>
  )
}
