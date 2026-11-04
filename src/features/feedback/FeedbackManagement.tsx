import { useEffect, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, UserCheck } from 'lucide-react'
import { feedbackClient, formatDate, priorityLabels, type FeedbackActivity, type FeedbackItem, type FeedbackPriority, type FeedbackStatus } from './shared'

export type ManagementDraft = { changes: { assignee_id?: string | null; priority?: FeedbackPriority; due_at?: string | null }; resolution: string | null; verification: string | null; version: string | null; note: string }
type Props = { initialDraft?: ManagementDraft; onDraftChange?: (draft: ManagementDraft, dirty: boolean) => void; onBusyChange?: (busy: boolean) => void; item: FeedbackItem; preview: boolean; userName: string; onUpdated: (item: FeedbackItem) => void; onActivity: (activity: FeedbackActivity) => void; onError: (error: unknown) => string }
export default function FeedbackManagement({ item, preview, userName, onUpdated, onActivity, onError, initialDraft, onDraftChange, onBusyChange }: Props) {
  const [people, setPeople] = useState<{ id: string; name: string }[]>([])
  const [peopleError, setPeopleError] = useState('')
  const [changes, setChanges] = useState<{ assignee_id?: string | null; priority?: FeedbackPriority; due_at?: string | null }>(initialDraft?.changes || {})
  const [resolution, setResolution] = useState<string | null>(initialDraft?.resolution ?? null)
  const [verification, setVerification] = useState<string | null>(initialDraft?.verification ?? null)
  const [version, setVersion] = useState<string | null>(initialDraft?.version ?? null)
  const [note, setNote] = useState(initialDraft?.note || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const request = useRef<{ fingerprint: string; id: string; payload: Record<string, unknown> } | null>(null)
  const lock = useRef(false)
  useEffect(() => {
    if (!item.can_assign || preview) return
    let active = true
    feedbackClient.get<{ items: { id: string; name: string }[] }>('/people').then(({ data }) => { if (active) setPeople(data.items) }).catch(err => { if (active) setPeopleError(onError(err)) })
    return () => { active = false }
  }, [item.can_assign, preview, onError])
  useEffect(() => {
    const dirty = !!Object.keys(changes).length || !!note.trim() || (resolution !== null && resolution !== (item.resolution || '')) || (verification !== null && verification !== (item.verification_steps || '')) || (version !== null && version !== (item.release_version || ''))
    onDraftChange?.({ changes, resolution, verification, version, note }, dirty)
  }, [changes, resolution, verification, version, note, item.resolution, item.verification_steps, item.release_version, onDraftChange])
  useEffect(() => { onBusyChange?.(busy); return () => { onBusyChange?.(false) } }, [busy, onBusyChange])
  const mutate = async (kind: 'claim' | 'management' | 'transition' | 'remind' | 'unclaim', status?: FeedbackStatus) => {
    if (lock.current) return
    let payload: Record<string, unknown> = kind === 'management' ? { ...changes } : kind === 'unclaim' ? { assignee_id: null } : {}
    if (kind === 'transition') {
      payload.status = status
      if (note.trim()) payload.note = note.trim()
      if (status === 'ready') {
        if (!(resolution ?? item.resolution ?? '').trim() || !(verification ?? item.verification_steps ?? '').trim()) { setError('请填写修复说明和验证步骤。'); return }
        payload.resolution = (resolution ?? item.resolution ?? '').trim(); payload.verification_steps = (verification ?? item.verification_steps ?? '').trim()
      }
      if (status === 'released') {
        if (!(version ?? item.release_version ?? '').trim()) { setError('请填写发布版本。'); return }
        payload.release_version = (version ?? item.release_version ?? '').trim()
      }
      if ((item.status === 'released' || item.status === 'fixed') && status === 'in_progress' && !note.trim()) { setError(item.status === 'fixed' ? '请说明重新打开的原因。' : '请说明验证未通过的原因。'); return }
    }
    const fingerprint = JSON.stringify({ kind, payload })
    if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, id: crypto.randomUUID(), payload: { ...payload, ...((kind !== 'management' && kind !== 'transition' && kind !== 'unclaim') || item.revision === undefined ? {} : { expected_revision: item.revision }) } }
    payload = { ...request.current.payload }
    if (kind === 'transition' || kind === 'remind') payload.request_id = request.current.id
    lock.current = true; setBusy(true); setError(''); setNotice('')
    try {
      if (preview) {
        const updated = { ...item, ...(kind === 'management' ? changes : {}), ...(kind === 'claim' ? { assignee_id: 'preview', assignee_name: userName, can_manage: true, can_unclaim: true, status: item.status === 'open' ? 'in_progress' as const : item.status } : {}), ...(kind === 'unclaim' ? { assignee_id: null, assignee_name: null, can_unclaim: false } : {}), ...(status ? { status, workflow_version: 2 as const, can_verify: status === 'released' && !!item.is_mine, can_reopen: status === 'fixed' && !!item.can_manage } : {}), resolution: String(payload.resolution ?? item.resolution ?? ''), verification_steps: String(payload.verification_steps ?? item.verification_steps ?? ''), release_version: String(payload.release_version ?? item.release_version ?? '') }
        onUpdated(updated)
        onActivity({ id: crypto.randomUUID(), kind: status ? 'status' : 'management', body: note, author_name: userName, created_at: new Date().toISOString(), from_status: status ? item.status : null, to_status: status ?? null })
      } else if (kind === 'management' || kind === 'unclaim') onUpdated((await feedbackClient.patch<FeedbackItem>(`/${item.id}/management`, payload)).data)
      else if (kind === 'claim') onUpdated((await feedbackClient.post<FeedbackItem>(`/${item.id}/claim`, payload)).data)
      else {
        const { data } = await feedbackClient.post<{ feedback: FeedbackItem; activity: FeedbackActivity }>(`/${item.id}/${kind}`, payload)
        onUpdated(data.feedback); onActivity(data.activity)
      }
      if (!preview && (kind === 'management' || kind === 'claim' || kind === 'unclaim')) {
        try { const page = await feedbackClient.get<{ items: FeedbackActivity[] }>(`/${item.id}/activities`); page.data.items.forEach(onActivity) } catch { setNotice('处理已保存，记录暂未刷新，可稍后重试。') }
      }
      if (kind === 'management') setChanges({})
      if (kind === 'transition') { setNote(''); setResolution(null); setVerification(null); setVersion(null) }
      request.current = null; setNotice(preview ? '演示处理信息已更新。' : '处理信息已保存。')
    } catch (err) { setError(onError(err)) }
    finally { lock.current = false; setBusy(false) }
  }
  const due = changes.due_at === undefined ? item.due_at : changes.due_at
  return <section className="feedback-management" aria-label="处理与验证">
    <h3>处理与验证</h3><div className="feedback-management-summary"><span>负责人：{item.assignee_name || '待认领'}</span><span>{priorityLabels[item.priority || 'p2']}</span>{item.due_at && <span className={item.is_overdue ? 'is-overdue' : ''}>计划完成：{formatDate(item.due_at)}</span>}</div>
    {!item.assignee_id && item.can_claim !== false && item.status !== 'fixed' && <button className="feedback-outline-button" type="button" disabled={busy} onClick={() => void mutate('claim')}><UserCheck size={15} />我来处理</button>}
    {item.can_manage && <div className="feedback-manage-fields"><label>负责人<select aria-label="负责人" value={changes.assignee_id === undefined ? item.assignee_id || '' : changes.assignee_id || ''} disabled={busy || !item.can_assign || !!peopleError} onChange={event => setChanges(current => ({ ...current, assignee_id: event.target.value || null }))}><option value="">待分配</option>{item.assignee_id && !people.some(x => x.id === item.assignee_id) && <option value={item.assignee_id}>{item.assignee_name || '当前负责人'}</option>}{people.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}</select>{!item.can_assign && <small>管理员可转派负责人。</small>}</label><label>优先级<select aria-label="优先级" disabled={busy} value={changes.priority || item.priority || 'p2'} onChange={event => setChanges(current => ({ ...current, priority: event.target.value as FeedbackPriority }))}>{Object.entries(priorityLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label>计划完成日期<input aria-label="计划完成日期" type="date" disabled={busy} value={due ? `${new Date(due).getFullYear()}-${String(new Date(due).getMonth() + 1).padStart(2, '0')}-${String(new Date(due).getDate()).padStart(2, '0')}` : ''} onChange={event => setChanges(current => ({ ...current, due_at: event.target.value ? new Date(event.target.value + 'T23:59:59').toISOString() : null }))} /></label><button type="button" className="feedback-outline-button" disabled={busy || !Object.keys(changes).length} onClick={() => void mutate('management')}>保存分派</button>{peopleError && <p role="alert">{peopleError}</p>}</div>}
    {item.can_unclaim && <button type="button" className="feedback-outline-button" disabled={busy} onClick={() => void mutate('unclaim')}>取消我的认领</button>}
    {item.resolution && <div className="feedback-resolution"><strong>修复说明</strong><p>{item.resolution}</p>{item.verification_steps && <><strong>验证步骤</strong><p>{item.verification_steps}</p></>}{item.release_version && <span>发布版本：{item.release_version}</span>}</div>}
    {item.can_manage && item.status === 'in_progress' && <div className="feedback-workflow-form"><label>修复说明<textarea aria-label="修复说明" rows={3} maxLength={2000} disabled={busy} value={resolution ?? item.resolution ?? ''} onChange={event => setResolution(event.target.value)} /></label><label>验证步骤<textarea aria-label="验证步骤" rows={3} maxLength={2000} disabled={busy} value={verification ?? item.verification_steps ?? ''} onChange={event => setVerification(event.target.value)} /></label><div className="feedback-dialog-actions"><button type="button" className="feedback-create" disabled={busy} onClick={() => void mutate('transition', 'ready')}>提交修复</button></div></div>}
    {item.can_manage && !!item.assignee_id && item.status === 'open' && <button type="button" className="feedback-outline-button" disabled={busy} onClick={() => void mutate('transition', 'in_progress')}>开始处理</button>}
    {item.workflow_version === 2 && item.can_manage && item.status === 'ready' && <div className="feedback-workflow-form"><label>发布版本<input aria-label="发布版本" maxLength={100} disabled={busy} value={version ?? item.release_version ?? ''} onChange={event => setVersion(event.target.value)} /></label><button type="button" className="feedback-create" disabled={busy} onClick={() => void mutate('transition', 'released')}>登记上线</button></div>}
    {item.workflow_version === 2 && item.can_verify && item.status === 'released' && <div className="feedback-workflow-form"><label>验证说明<textarea aria-label="验证说明" rows={3} maxLength={2000} disabled={busy} value={note} onChange={event => setNote(event.target.value)} placeholder="如仍有问题，请写明复测步骤和实际结果。" /></label><div className="feedback-dialog-actions"><button type="button" className="feedback-outline-button" disabled={busy} onClick={() => void mutate('transition', 'in_progress')}>仍有问题</button><button type="button" className="feedback-create" disabled={busy} onClick={() => void mutate('transition', 'fixed')}>确认已解决</button></div></div>}
    {item.status === 'released' && !item.can_verify && <p className="feedback-field-help">已登记上线，等待反馈提交人复测确认。</p>}
    {item.can_reopen && item.status === 'fixed' && <div className="feedback-workflow-form"><label>重新处理原因<textarea aria-label="重新处理原因" rows={3} maxLength={2000} disabled={busy} value={note} onChange={event => setNote(event.target.value)} /></label><button type="button" className="feedback-outline-button" disabled={busy} onClick={() => void mutate('transition', 'in_progress')}>重新打开</button></div>}
    {item.can_remind && <button type="button" className="feedback-outline-button" disabled={busy} onClick={() => void mutate('remind')}>催办</button>}
    {error && <p className="feedback-history-error" role="alert"><AlertCircle size={14} />{error}</p>}{notice && <p className="feedback-discussion-notice" role="status"><CheckCircle2 size={15} />{notice}</p>}
  </section>
}
