import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { applyReportAction, getReportActions, previewReportAction, type ActionDraft, type ActionPreview, type ReportActions } from '../../api/projectAIWork'
import { asAPIError } from '../../api/client'
import { refreshAllData } from '../../data/bootstrap'
import { subProjects, tasks, users, findProject } from '../../mock'
import { useAuth } from '../../store/auth'
import { Button } from '../ui'

const kindName = { task: '新增任务', risk: '登记风险', schedule: '联动调整计划' }
export function AIReportActions({ projectId, reportId }: { projectId: string; reportId: string }) {
  const [rows, setRows] = useState<ReportActions>({ proposals: [], applied: [] })
  const [draft, setDraft] = useState<ActionDraft | null>(null)
  const [preview, setPreview] = useState<ActionPreview | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [reload, setReload] = useState(0)
  const me = useAuth(s => s.currentUser)
  const project = findProject(projectId)
  const canApply = me?.role === 'admin' || me?.role === 'cmc_lead' || (me?.role === 'project_lead' && project?.ownerId === me.id)
  const subs = subProjects.filter(s => s.projectId === projectId)
  const projectTasks = tasks.filter(t => subs.some(s => s.id === t.subProjectId))
  const members = users.filter(u => u.isActive !== false && (u.id === project?.ownerId || project?.memberIds?.includes(u.id)))

  useEffect(() => {
    let valid = true
    getReportActions(projectId, reportId).then(value => { if (valid) { setRows(value); setError('') } }).catch(e => { if (valid) setError(asAPIError(e).detail) })
    return () => { valid = false }
  }, [projectId, reportId, reload])

  function edit(patch: Partial<ActionDraft>) { setDraft(current => current ? { ...current, ...patch } : null); setPreview(null); setError(''); setNotice('') }
  function choose(value?: Partial<ActionDraft>) {
    setDraft({ actionKey: value?.actionKey || `manual-${crypto.randomUUID()}`, kind: value?.kind || 'task', title: value?.title || '', reason: value?.reason || '',
      ownerId: value?.ownerId || project?.ownerId, subProjectId: value?.subProjectId || subs[0]?.id, taskId: value?.taskId,
      plannedStart: value?.plannedStart, plannedEnd: value?.plannedEnd, dueDate: value?.dueDate, severity: value?.severity || 'medium', lockedIds: [] })
    setPreview(null); setNotice(''); setError('')
  }
  async function review() {
    if (!draft) return
    setBusy(true); setError(''); setPreview(null)
    try { setPreview(await previewReportAction(projectId, reportId, draft)) } catch (e) { setError(asAPIError(e).detail) } finally { setBusy(false) }
  }
  async function apply() {
    if (!draft || !preview) return
    setBusy(true); setError('')
    try {
      const result = await applyReportAction(projectId, reportId, draft, preview.fingerprint)
      setDraft(null); setPreview(null); setNotice(result.replayed ? '此建议已经执行，未重复创建。请查看已执行记录。' : '建议已执行，已保留来源与变更记录。'); setReload(v => v + 1)
      try { await refreshAllData() } catch { setNotice('建议已执行；页面同步失败，请刷新查看最新数据。') }
    } catch (e) { setError(asAPIError(e).detail); setPreview(null) } finally { setBusy(false) }
  }

  return <section className="card p-5 space-y-4" aria-label="AI 建议行动">
    <div className="flex justify-between flex-wrap gap-3"><div><h3 className="font-semibold">建议行动</h3><p className="text-xs text-ink-500 mt-1">核对负责人、日期及影响范围后逐条确认。报告内容不会自动修改项目。</p></div>{canApply && <Button size="sm" onClick={() => choose()} disabled={busy}>从报告添加行动</Button>}</div>
    {rows.proposals.length > 0 ? <div className="space-y-2">{rows.proposals.map((row, i) => {
      const done = rows.applied.some(a => a.actionKey === row.actionKey)
      return <div key={row.actionKey || i} className="flex gap-3 items-center justify-between rounded-lg border border-ink-200 p-3 text-sm"><span className="min-w-0 break-words">{row.title || '待核对建议'} <span className="text-xs text-ink-500">{row.kind && kindName[row.kind]}</span></span>{done ? <span className="text-emerald-700 shrink-0">已执行</span> : canApply && <Button size="sm" disabled={busy} onClick={() => choose(row)}>核对并预览</Button>}</div>
    })}</div> : <p className="text-sm text-ink-500">本报告没有可识别的结构化建议，可从报告手动添加行动。</p>}
    {!canApply && <p className="text-sm text-ink-500">项目负责人可核对并执行建议。</p>}
    {draft && canApply && <fieldset disabled={busy} className="space-y-3 rounded-lg bg-ink-50 border border-ink-200 p-4">
      <div className="grid sm:grid-cols-2 gap-3"><label className="text-sm">行动类型<select className="input mt-1" aria-label="行动类型" value={draft.kind} onChange={e => edit({ kind: e.target.value as ActionDraft['kind'] })}>{Object.entries(kindName).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label><label className="text-sm">事项名称<input className="input mt-1" aria-label="行动名称" maxLength={200} value={draft.title} onChange={e => edit({ title: e.target.value })} /></label></div>
      {draft.kind !== 'schedule' && <label className="block text-sm">负责人<select aria-label="行动负责人" className="input mt-1" value={draft.ownerId || ''} onChange={e => edit({ ownerId: e.target.value })}><option value="">请选择</option>{members.map(u => <option value={u.id} key={u.id}>{u.displayName}</option>)}</select></label>}
      {draft.kind === 'task' && <label className="block text-sm">所属子项目<select className="input mt-1" aria-label="行动所属子项目" value={draft.subProjectId || ''} onChange={e => edit({ subProjectId: e.target.value })}><option value="">请选择</option>{subs.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>}
      {draft.kind === 'schedule' && <><label className="block text-sm">调整起点任务<select className="input mt-1" aria-label="行动调整任务" value={draft.taskId || ''} onChange={e => edit({ taskId: e.target.value })}><option value="">请选择</option>{projectTasks.filter(t => !['已完成', '已验证'].includes(t.status)).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label><details className="text-sm"><summary>锁定不可移动任务</summary><div className="max-h-48 overflow-auto mt-2 space-y-1">{projectTasks.map(t => <label className="flex gap-2" key={t.id}><input type="checkbox" checked={draft.lockedIds?.includes(t.id) || false} onChange={e => edit({ lockedIds: e.target.checked ? [...draft.lockedIds || [], t.id] : draft.lockedIds?.filter(id => id !== t.id) })} />{t.name}</label>)}</div></details></>}
      {draft.kind === 'risk' ? <div className="grid sm:grid-cols-2 gap-3"><label className="text-sm">处理期限<input aria-label="行动处理期限" className="input mt-1" type="date" value={draft.dueDate || ''} onChange={e => edit({ dueDate: e.target.value || undefined })} /></label><label className="text-sm">严重度<select className="input mt-1" value={draft.severity} onChange={e => edit({ severity: e.target.value as ActionDraft['severity'] })}><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select></label></div> : <div className="grid sm:grid-cols-2 gap-3"><label className="text-sm">计划开始<input aria-label="行动计划开始" className="input mt-1" type="date" value={draft.plannedStart || ''} onChange={e => edit({ plannedStart: e.target.value || undefined })} /></label><label className="text-sm">计划结束<input aria-label="行动计划结束" className="input mt-1" type="date" value={draft.plannedEnd || ''} onChange={e => edit({ plannedEnd: e.target.value || undefined })} /></label></div>}
      <label className="block text-sm">采纳原因／处理措施<textarea aria-label="行动采纳原因" className="input mt-1" maxLength={2000} value={draft.reason} onChange={e => edit({ reason: e.target.value })} /></label>
      {preview && <div className="rounded border border-brand-200 bg-white p-3 text-sm space-y-2"><strong>确认影响：{preview.changes.length} 项</strong>{preview.reportStale && <p className="text-amber-800">报告基于旧快照，本次预览已按当前项目重新校验，请核对。</p>}<ul className="space-y-1 max-h-64 overflow-auto">{preview.changes.map((c, i) => <li key={i} className="border-t pt-2 break-words">{String(c.name || c.taskId || c.type || '')} {c.oldStart ? `${c.oldStart}～${c.oldEnd} → ` : ''}{String(c.newStart || c.start || c.dueDate || '')}{c.newEnd || c.end ? `～${c.newEnd || c.end}` : ''}{typeof c.type === 'string' && <span className="ml-2">{String(c.type)}</span>}</li>)}</ul></div>}
      <div className="flex gap-2"><Button size="sm" disabled={busy} onClick={review}>预览影响</Button>{preview && <Button size="sm" variant="primary" disabled={busy} onClick={apply}>{busy ? '执行中…' : '确认执行此建议'}</Button>}<Button size="sm" disabled={busy} onClick={() => { setDraft(null); setPreview(null) }}>取消</Button></div>
    </fieldset>}
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}{notice && <p role="status" className="text-sm text-emerald-800">{notice}</p>}
    {rows.applied.length > 0 && <details className="text-sm"><summary>已执行记录（{rows.applied.length}）</summary><ul className="space-y-2 mt-3">{rows.applied.map(a => <li key={a.actionKey}>{kindName[a.draft.kind]}：{a.draft.title} · {a.createdAt.slice(0, 10)} · <Link className="text-brand-700 underline" to={a.result.kind === 'risk' ? `/projects/${projectId}?tab=management` : `/projects/${projectId}?tab=wbs&task=${encodeURIComponent(a.result.targetId)}`}>查看结果</Link></li>)}</ul></details>}
  </section>
}
