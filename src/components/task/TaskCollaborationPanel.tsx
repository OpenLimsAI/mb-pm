import { useEffect, useState } from 'react'
import { findSubProject, findUser, users } from '../../mock'
import type { Task } from '../../types'
import { useAuth } from '../../store/auth'
import { useDataStore } from '../../store/data'
import { can } from '../../lib/permissions'
import { getScope } from '../../lib/scope'
import { refreshAllData } from '../../data/bootstrap'
import { Button } from '../ui'
import {
  addTaskComment, addTaskLink, configureTaskAcceptance, getOlderTaskActivities, getTaskCollaboration,
  taskAcceptanceAction, taskFileUrl, taskRequestError, uploadTaskFile, type TaskCollaboration,
} from '../../api/taskCollaboration'

const stateLabels = { draft: '待提交', submitted: '待验收', accepted: '已通过', rejected: '已退回' }
const labels: Record<string, string> = { status: '状态', progress: '进度', plannedStart: '计划开始', plannedEnd: '计划结束', actualStart: '实际开始', actualEnd: '实际结束', ownerId: '负责人', collaboratorIds: '协作人', actualEffort: '实际工时', estimatedEffort: '预估工时', actualCost: '实际花费', costBudget: '任务预算', priority: '优先级', name: '名称', notes: '备注', tags: '标签', isMilestone: '里程碑', isCriticalPath: '关键路径' }
const display = (value: unknown) => value === null || value === undefined || value === '' ? '未填报' : Array.isArray(value) ? value.map(x => findUser(String(x))?.displayName || String(x)).join('、') : String(value)

export function TaskCollaborationPanel({ task }: { task: Task }) {
  const online = useDataStore(s => s.mode) === 'api'
  const version = useDataStore(s => s.version)
  const user = useAuth(s => s.currentUser)
  const manager = can(user?.role, 'task.update')
  const writable = manager || !!user && (user.id === task.ownerId || !!task.collaboratorIds?.includes(user.id))
  const [data, setData] = useState<TaskCollaboration | null>(null)
  const [reload, setReload] = useState(0)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [body, setBody] = useState('')
  const [mentions, setMentions] = useState<string[]>([])
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [link, setLink] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [reviewer, setReviewer] = useState('')
  const [required, setRequired] = useState<number | null>(null)
  const [reviewComment, setReviewComment] = useState('')
  const [copied, setCopied] = useState(false)
  const people = users.filter(person => person.isActive && getScope(person).taskIds.has(task.id))
  useEffect(() => {
    if (!online) return
    let alive = true
    void getTaskCollaboration(task.id).then(value => { if (alive) { setData(value); setError('') } }).catch(failure => { if (alive) setError(taskRequestError(failure).message) })
    return () => { alive = false }
  }, [task.id, online, version, reload])
  async function run(action: () => Promise<unknown>, reset?: () => void) {
    setBusy(true); setError('')
    try { await action(); reset?.(); setReload(value => value + 1); await refreshAllData() }
    catch (failure) { setError(taskRequestError(failure).message) }
    finally { setBusy(false) }
  }
  const acceptance = data?.acceptance
  const requiredCount = required ?? acceptance?.requiredCount ?? 1
  const latest = data?.deliverables.filter(item => !data.deliverables.some(other => item.title === other.title && other.version > item.version)) || []
  return <div className="space-y-5">
    <div className="flex items-center justify-between"><h3 className="text-sm font-semibold">协作与交付</h3><button className="text-xs text-brand-700 underline" onClick={() => {
      const id = findSubProject(task.subProjectId)?.projectId
      if (!id) { setError('找不到所属项目，暂时无法复制链接。'); return }
      const url = new URL(`/projects/${encodeURIComponent(id)}`, window.location.origin); url.searchParams.set('tab', 'wbs'); url.searchParams.set('task', task.id)
      void navigator.clipboard.writeText(url.toString()).then(() => setCopied(true)).catch(() => setError('复制失败，请允许浏览器访问剪贴板。'))
    }}>{copied ? '已复制任务链接' : '复制任务链接'}</button></div>
    {!online ? <p className="rounded bg-ink-100 p-3 text-xs text-ink-500">连接后端后可讨论、上传交付物并验收。</p> : <>
      {error && <p role="alert" className="rounded bg-red-50 p-3 text-xs text-red-700">{error}<button className="ml-3 underline" onClick={() => setReload(value => value + 1)}>重新加载</button></p>}
      {!data && !error && <p className="text-xs text-ink-500">正在加载协作记录…</p>}
      <section className="rounded border p-3 space-y-3">
        <h4 className="text-sm font-medium">交付物 · {latest.length} 项</h4>
        {data?.deliverables.length === 0 && <p className="text-xs text-ink-500">尚未提交交付物。相同名称再次提交会保存为新版本。</p>}
        <ul className="space-y-2">{data?.deliverables.map(item => <li key={item.id} className="rounded bg-ink-100/60 p-2 text-xs space-y-1">
          <div className="font-medium flex gap-2"><span className="break-all">{item.title}</span><span className="shrink-0 text-ink-500">v{item.version}{latest.includes(item) ? ' · 当前' : ''}</span></div>
          {item.link ? <a className="text-brand-700 underline break-all" href={item.link} target="_blank" rel="noreferrer">打开链接</a> : <a className="text-brand-700 underline break-all" href={taskFileUrl(task.id, item.id)}>{item.filename} · 下载</a>}
          {item.notes && <p className="whitespace-pre-wrap">{item.notes}</p>}
          <p className="text-ink-500">{findUser(item.authorId)?.displayName || item.authorId} · {new Date(item.createdAt).toLocaleString('zh-CN')}</p>
          {acceptance?.submittedDeliverableIds.includes(item.id) && <p className="text-brand-700">本次验收版本</p>}
        </li>)}</ul>
        {writable && <fieldset disabled={busy} className="space-y-2">
          <label className="block text-xs">交付物名称<input className="input mt-1" value={title} maxLength={200} onChange={e => setTitle(e.target.value)} placeholder="相同名称保存为新版本" /></label>
          <label className="block text-xs">提交说明<textarea aria-label="提交说明" className="input mt-1" value={notes} maxLength={5000} onChange={e => setNotes(e.target.value)} /></label>
          <label className="block text-xs">链接<input type="url" className="input mt-1" value={link} onChange={e => setLink(e.target.value)} placeholder="https://" /></label>
          <Button size="sm" disabled={!title.trim() || !link.trim()} onClick={() => { void run(() => addTaskLink(task.id, title, link, notes), () => { setTitle(''); setLink(''); setNotes('') }) }}>提交链接</Button>
          <label className="block text-xs">或选择文件（最多 10 MB）<input type="file" className="block mt-1 w-full" accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.md,.png,.jpg,.jpeg,.webp,.ppt,.pptx,.zip" onChange={e => setFile(e.target.files?.[0] || null)} /></label>
          <Button size="sm" disabled={!title.trim() || !file} onClick={() => { if (!file) return; if (file.size > 10 * 1024 * 1024) { setError('文件不能超过10 MB'); return }; void run(() => uploadTaskFile(task.id, title, notes, file), () => { setTitle(''); setNotes(''); setFile(null) }) }}>上传文件</Button>
        </fieldset>}
      </section>
      {task.isMilestone && <section className="rounded border p-3 space-y-3">
        <h4 className="text-sm font-medium">里程碑验收{acceptance ? ` · ${stateLabels[acceptance.state]}` : ''}</h4>
        {acceptance && <><p className="text-xs">验收人：{findUser(acceptance.reviewerId)?.displayName || acceptance.reviewerId}；至少 {acceptance.requiredCount} 项交付物</p>{acceptance.comment && <p className="text-xs whitespace-pre-wrap">处理意见：{acceptance.comment}</p>}</>}
        {manager && <details><summary className="text-xs text-brand-700 cursor-pointer">{acceptance ? '调整验收要求' : '设置关键节点验收'}</summary><fieldset disabled={busy} className="space-y-2 mt-2">
          <label className="block text-xs">验收人<select aria-label="验收人" className="input mt-1" value={reviewer || acceptance?.reviewerId || ''} onChange={e => setReviewer(e.target.value)}><option value="">选择已可查看此任务的成员</option>{people.map(person => <option key={person.id} value={person.id}>{person.displayName}</option>)}</select></label>
          <label className="block text-xs">必备交付物数量<input type="number" className="input mt-1" min={1} max={100} value={requiredCount} onChange={e => setRequired(Number(e.target.value))} /></label>
          <Button size="sm" disabled={!(reviewer || acceptance?.reviewerId) || !Number.isInteger(requiredCount) || requiredCount < 1 || requiredCount > 100} onClick={() => { void run(() => configureTaskAcceptance(task.id, reviewer || acceptance!.reviewerId, requiredCount)) }}>保存验收要求</Button>
        </fieldset></details>}
        {acceptance && <fieldset disabled={busy} className="space-y-2"><label className="block text-xs">验收说明 / 退回原因<textarea aria-label="验收说明 / 退回原因" className="input mt-1" value={reviewComment} maxLength={5000} onChange={e => setReviewComment(e.target.value)} /></label><div className="flex gap-2 flex-wrap">
          {writable && acceptance.state !== 'submitted' && acceptance.state !== 'accepted' && <Button size="sm" onClick={() => { void run(() => taskAcceptanceAction(task.id, 'submit', reviewComment), () => setReviewComment('')) }}>提交验收</Button>}
          {acceptance.state === 'submitted' && acceptance.reviewerId === user?.id && <><Button size="sm" onClick={() => { void run(() => taskAcceptanceAction(task.id, 'accept', reviewComment), () => setReviewComment('')) }}>验收通过</Button><Button size="sm" disabled={!reviewComment.trim()} onClick={() => { void run(() => taskAcceptanceAction(task.id, 'reject', reviewComment), () => setReviewComment('')) }}>退回修改</Button></>}
        </div></fieldset>}
      </section>}
      <section className="rounded border p-3 space-y-3"><h4 className="text-sm font-medium">讨论与进展记录</h4>
        {writable && <fieldset disabled={busy} className="space-y-2"><label className="block text-xs">讨论内容<textarea aria-label="讨论内容" className="input mt-1" value={body} maxLength={5000} onChange={e => setBody(e.target.value)} placeholder="记录问题、决定和进展" /></label>
          <label className="block text-xs">@ 提醒成员（可多选）<select aria-label="@ 提醒成员（可多选）" multiple className="input mt-1" value={mentions} onChange={e => setMentions(Array.from(e.target.selectedOptions, option => option.value))}>{people.filter(person => person.id !== user?.id).map(person => <option key={person.id} value={person.id}>{person.displayName}</option>)}</select></label>
          <Button size="sm" disabled={!body.trim()} onClick={() => { void run(() => addTaskComment(task.id, body, mentions), () => { setBody(''); setMentions([]) }) }}>发表讨论</Button></fieldset>}
        {data?.activities.length === 0 && <p className="text-xs text-ink-500">暂无记录。后续进展、字段变更、提交和验收将自动记录。</p>}
        <ol className="space-y-3">{data?.activities.map(item => <li key={item.id} className="border-l-2 border-brand-200 pl-3 text-xs space-y-1"><p className="text-ink-500">{findUser(item.actorId)?.displayName || item.actorId} · {new Date(item.createdAt).toLocaleString('zh-CN')}</p>{item.body && <p className="whitespace-pre-wrap break-words">{item.body}</p>}{Object.entries(item.changes).map(([key, value]) => <p className="break-words" key={key}>{labels[key] || key}：{display(value.before)} → {display(value.after)}</p>)}{item.mentionIds.length > 0 && <p className="text-brand-700">{item.mentionIds.map(id => `@${findUser(id)?.displayName || id}`).join(' ')}</p>}</li>)}</ol>
        {data?.nextActivityCursor && <Button size="sm" disabled={busy} onClick={() => {
          setBusy(true); setError('')
          void getOlderTaskActivities(task.id, data.nextActivityCursor!).then(page => setData(current => current ? { ...current, activities: [...current.activities, ...page.activities], nextActivityCursor: page.nextActivityCursor } : current)).catch(failure => setError(taskRequestError(failure).message)).finally(() => setBusy(false))
        }}>加载更早记录</Button>}
      </section>
    </>}
  </div>
}
