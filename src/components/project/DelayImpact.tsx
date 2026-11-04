import { useState } from 'react'
import { addDays, format, parseISO } from 'date-fns'
import type { Project } from '../../types'
import { Card, CardHeader, CardBody, Button } from '../ui'
import { getProjectTasks } from '../../mock'
import { useAuth } from '../../store/auth'
import { useDataStore } from '../../store/data'
import { refreshAllData } from '../../data/bootstrap'
import { asAPIError } from '../../api/client'
import { planningApi, type SchedulePreview, type WorkingCalendar } from '../../api/planning'
import { getWorkingCalendar, moveWorkingDays } from '../../lib/workingCalendar'

export function DelayImpact({ project }: { project: Project }) {
  const role = useAuth(s => s.currentUser?.role)
  const online = useDataStore(s => s.mode) === 'api'
  useDataStore(s => s.version)
  const manager = ['admin', 'cmc_lead', 'project_lead'].includes(role ?? '')
  const tasks = getProjectTasks(project.id)
  const [pickedId, setPickedId] = useState('')
  const selected = tasks.find(t => t.id === pickedId) ?? tasks.find(t => !['已完成', '已验证'].includes(t.status))
  const [newStart, setNewStart] = useState('')
  const [newEnd, setNewEnd] = useState('')
  const [lockedIds, setLockedIds] = useState<string[]>([])
  const [reason, setReason] = useState('')
  const [preview, setPreview] = useState<SchedulePreview | null>(null)
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState('')
  const start = newStart || selected?.plannedStart || ''
  const end = newEnd || selected?.plannedEnd || ''
  const request = { taskId: selected?.id ?? '', newStart: start, newEnd: end, lockedIds }
  const invalidate = () => { setPreview(null); setMessage('') }
  const run = async (apply: boolean) => {
    setPending(true); setMessage('')
    try {
      if (apply) {
        await planningApi.apply(project.id, { ...request, fingerprint: preview?.fingerprint, reason })
        await refreshAllData()
        setPreview(null)
        setMessage('计划已统一更新，甘特图、基线对比与人员负荷已同步。')
      } else setPreview(await planningApi.preview(project.id, request))
    } catch (error) { setMessage(asAPIError(error).detail); if (apply) setPreview(null) }
    finally { setPending(false) }
  }
  return <div className="space-y-4">
    <CalendarEditor key={project.id} project={project} editable={manager && online} onSaved={invalidate} />
    <Card>
      <CardHeader title="联动调整计划" subtitle="预览前置任务变动对下游任务、里程碑与完工日期的影响，填写原因后统一应用。" />
      <CardBody className="space-y-4">
        {!online && <p className="text-sm text-amber-800">连接后端后可预览并保存真实项目计划。</p>}
        {!manager && <p className="text-sm text-ink-500">计划调整由项目负责人维护。</p>}
        <fieldset disabled={pending || !manager || !online} className="space-y-3 disabled:opacity-60">
          <label className="block text-sm">起始任务<select aria-label="起始任务" className="input mt-1" value={selected?.id ?? ''} onChange={e => { setPickedId(e.target.value); setNewStart(''); setNewEnd(''); invalidate() }}>
            {tasks.filter(t => !['已完成', '已验证'].includes(t.status)).map(t => <option key={t.id} value={t.id}>{t.code} · {t.name}</option>)}
          </select></label>
          <div className="flex flex-wrap gap-3 items-end">
            <label className="text-sm">新的计划开始<input aria-label="新的计划开始" type="date" className="input mt-1" value={start} onChange={e => { setNewStart(e.target.value); invalidate() }} /></label>
            <label className="text-sm">新的计划结束<input aria-label="新的计划结束" type="date" className="input mt-1" value={end} onChange={e => { setNewEnd(e.target.value); invalidate() }} /></label>
            {[1, 3, 7].map(days => <Button size="sm" key={days} disabled={!selected || !start || !end} onClick={() => { const calendar = getWorkingCalendar(project.id); setNewStart(format(moveWorkingDays(parseISO(start), days, calendar), 'yyyy-MM-dd')); setNewEnd(format(moveWorkingDays(parseISO(end), days, calendar), 'yyyy-MM-dd')); invalidate() }}>顺延 {days} 工作日</Button>)}
          </div>
          <details className="text-sm rounded border p-3"><summary className="cursor-pointer">锁定不能移动的节点（{lockedIds.length}）</summary><div className="mt-2 max-h-52 overflow-auto space-y-1">{tasks.filter(t => t.id !== selected?.id && !['已完成', '已验证'].includes(t.status)).map(t => <label className="flex gap-2 items-center" key={t.id}><input type="checkbox" checked={lockedIds.includes(t.id)} onChange={e => { setLockedIds(e.target.checked ? [...lockedIds, t.id] : lockedIds.filter(id => id !== t.id)); invalidate() }} /><span className="truncate" title={t.name}>{t.code} · {t.name}</span></label>)}</div><p className="mt-2 text-xs text-ink-500">已完成、已验证任务自动锁定。有依赖冲突时无法应用。</p></details>
          <Button variant="primary" disabled={!selected || !start || !end || pending} onClick={() => void run(false)}>{pending ? '正在处理…' : '预览调整影响'}</Button>
        </fieldset>
        {preview && <div className="space-y-3">
          <p className="text-sm font-medium">影响 {preview.changes.length} 项 · 项目完工：{preview.previousFinish} → {preview.newFinish}</p>
          {preview.conflicts.length > 0 && <div role="alert" className="p-3 bg-red-50 text-red-800 text-sm">{preview.conflicts.map((c, i) => <p key={`${c.taskId}-${i}`}>{c.name}：{c.reason}</p>)}</div>}
          <div className="overflow-auto max-h-96 border rounded"><table className="w-full text-xs"><thead className="bg-ink-100 sticky top-0"><tr><th className="p-2 text-left">任务</th><th className="p-2">原计划</th><th className="p-2">新计划</th></tr></thead><tbody>{preview.changes.map(c => <tr className="border-t" key={c.taskId}><td className="p-2 max-w-80 truncate" title={c.name}>{c.isMilestone ? '◇ ' : ''}{c.name}</td><td className="p-2 whitespace-nowrap">{c.oldStart} → {c.oldEnd}</td><td className="p-2 whitespace-nowrap text-brand-700">{c.newStart} → {c.newEnd}</td></tr>)}</tbody></table></div>
          <label className="block text-sm">调整原因<input aria-label="调整原因" className="input mt-1" maxLength={2000} value={reason} onChange={e => setReason(e.target.value)} placeholder="说明本次调整的依据，保存到变更记录" /></label>
          <Button variant="primary" disabled={pending || !reason.trim() || !preview.changes.length || !!preview.conflicts.length || !manager || !online} onClick={() => void run(true)}>确认应用 {preview.changes.length} 项调整</Button>
        </div>}
        {message && <p role="status" className="text-sm p-3 bg-brand-50 rounded">{message}</p>}
      </CardBody>
    </Card>
  </div>
}

function CalendarEditor({ project, editable, onSaved }: { project: Project; editable: boolean; onSaved: () => void }) {
  const initial = getWorkingCalendar(project.id)
  const [calendar, setCalendar] = useState<WorkingCalendar>(initial)
  const [holidays, setHolidays] = useState(initial.holidays.join(', '))
  const [working, setWorking] = useState(initial.workingDates.join(', '))
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState('')
  const save = async () => {
    const splitDates = (text: string) => [...new Set(text.split(/[\s,，;；]+/).filter(Boolean))]
    const value = { ...calendar, holidays: splitDates(holidays), workingDates: splitDates(working) }
    if (![...value.holidays, ...value.workingDates].every(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(parseISO(d).getTime()) && format(parseISO(d), 'yyyy-MM-dd') === d)) { setMessage('请按 YYYY-MM-DD 输入有效日期，多项以逗号分隔。'); return }
    setPending(true); setMessage('')
    try { setCalendar(await planningApi.saveCalendar(project.id, value)); await refreshAllData(); onSaved(); setMessage('工作日历已保存。现有计划日期保留；后续联动排期、关键路径和人员负荷使用本日历。') }
    catch (error) { setMessage(asAPIError(error).detail) }
    finally { setPending(false) }
  }
  return <Card><CardHeader title="项目工作日历" subtitle="默认连续作业兼容已有计划；可设置工作周、节假日和例外工作日。" /><CardBody>
    <details><summary className="text-sm cursor-pointer">配置工作日历 · 每周 {calendar.weekdays.length} 天</summary>
      <fieldset disabled={!editable || pending} className="mt-3 space-y-3">
        <div className="flex gap-3 flex-wrap">{['一', '二', '三', '四', '五', '六', '日'].map((label, i) => <label className="text-sm" key={i}><input type="checkbox" checked={calendar.weekdays.includes(i + 1)} onChange={e => setCalendar({ ...calendar, weekdays: e.target.checked ? [...calendar.weekdays, i + 1].sort() : calendar.weekdays.filter(d => d !== i + 1) })} /> 周{label}</label>)}</div>
        <label className="block text-sm">节假日<textarea aria-label="节假日" className="input mt-1" value={holidays} onChange={e => setHolidays(e.target.value)} placeholder={`例如 ${format(addDays(new Date(), 1), 'yyyy-MM-dd')}，多个日期以逗号分隔`} /></label>
        <label className="block text-sm">调休 / 例外工作日<textarea aria-label="调休 / 例外工作日" className="input mt-1" value={working} onChange={e => setWorking(e.target.value)} placeholder="例外工作日优先于周末和节假日" /></label>
        <Button size="sm" disabled={!calendar.weekdays.length || pending} onClick={() => void save()}>保存日历</Button>
      </fieldset>
      {message && <p role="status" className="mt-2 text-sm">{message}</p>}
    </details>
  </CardBody></Card>
}
