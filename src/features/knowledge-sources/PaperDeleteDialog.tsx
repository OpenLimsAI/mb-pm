import { useEffect, useRef, useState } from 'react'
import { LoaderCircle, Trash2, X } from 'lucide-react'
import axios from 'axios'
import type { SourceFolder, SourcePaper } from './api'
import { sourceError } from './api'
import { knowledgeV3Get, knowledgeV3Post } from './v3-api'
import './paper-delete.css'

interface DeletePlan { planId: string; path: string; title: string; expiresAt: string; pages: { path: string; title: string; layer: string }[]; sharedCount: number; unverifiedCount: number; scope?: 'original' }
interface DeleteStatus { operationId: string; path: string; status: 'running' | 'succeeded' | 'failed'; completed: number; total: number; message?: string }
type Pending = { plan: DeletePlan; submitted: true }
const validPath = (path: string) => path.startsWith('sources/') && path.endsWith('.md') && !/[\\%\p{Cc}]/u.test(path) && !path.split('/').some(p => !p || p === '.' || p === '..')

interface Props {
  paper: SourcePaper
  folders: SourceFolder[]
  storageKey: string
  position?: { current: number; total: number }
  onClose: () => void
  onDeleted: () => void
}

export default function PaperDeleteDialog({ paper, folders, storageKey, position, onClose, onDeleted }: Props) {
  const originalOnly = /^archive:[a-f0-9]{64}$/.test(paper.id)
  const canPreview = originalOnly || validPath(paper.id)
  const key = `${storageKey}:delete:${paper.id}`
  const affectedFolders = folders.filter(folder => paper.folderIds.includes(folder.id))
  const [plan, setPlan] = useState<DeletePlan | null>(null), [status, setStatus] = useState<DeleteStatus | null>(null)
  const [loading, setLoading] = useState(true), [submitted, setSubmitted] = useState(false), [error, setError] = useState('')
  const [retryConfirmation, setRetryConfirmation] = useState(false)
  const box = useRef<HTMLDivElement>(null), active = useRef(true), pending = useRef<AbortController | null>(null), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const lock = useRef(false), done = useRef(onDeleted); done.current = onDeleted
  function save(value: Pending | null) { try { if (value) localStorage.setItem(key, JSON.stringify(value)); else localStorage.removeItem(key) } catch { /* The server operation remains durable. */ } }
  function acceptPlan(value: DeletePlan) {
    if (!value || value.path !== paper.id || !value.planId || !Array.isArray(value.pages) || !Number.isFinite(Date.parse(value.expiresAt)) || !Number.isInteger(value.sharedCount) || value.sharedCount < 0 || !Number.isInteger(value.unverifiedCount) || value.unverifiedCount < 0 || (value.scope === 'original') !== originalOnly || (originalOnly && value.pages.length > 0)) throw new Error('删除清单无效，请重新检查。')
    setPlan(value); return value
  }
  function acceptStatus(value: DeleteStatus, expected: DeletePlan) {
    if (!value || value.operationId !== expected.planId || value.path !== expected.path || !['running', 'succeeded', 'failed'].includes(value.status) || value.total !== expected.pages.length + 1 || value.completed < 0 || value.completed > value.total || (value.status === 'succeeded' && value.completed !== value.total)) throw new Error('删除结果暂未确认，请重新查询。')
    setStatus(value); setRetryConfirmation(false)
    if (value.status === 'succeeded') { save(null); done.current() }
    return value
  }
  async function query(expected: DeletePlan) {
    if (!active.current || lock.current) return
    lock.current = true; setLoading(true); setError(''); setRetryConfirmation(false)
    const abort = new AbortController(); pending.current = abort
    try {
      const value = await knowledgeV3Get<DeleteStatus>(`/library/delete-status?operationId=${encodeURIComponent(expected.planId)}`, abort.signal)
      if (!active.current) return
      if (acceptStatus(value, expected).status === 'running') timer.current = setTimeout(() => void query(expected), 1500)
    } catch (e) {
      if (active.current && !abort.signal.aborted) {
        if (axios.isAxiosError(e) && e.response?.status === 404) {
          // Keep the same plan: an accepted request may still race with this status lookup.
          setRetryConfirmation(true); setStatus(null); setError('尚未查询到已启动的删除任务，可使用原确认单重试。')
        } else setError(sourceError(e))
      }
    }
    finally { lock.current = false; if (active.current) setLoading(false) }
  }
  async function preview() {
    if (lock.current) return
    lock.current = true; setLoading(true); setError('')
    const abort = new AbortController(); pending.current = abort
    try {
      const value = await knowledgeV3Post<DeletePlan>('/library/delete-preview', { paperId: paper.id }, abort.signal)
      if (active.current) acceptPlan(value)
    } catch (e) { if (active.current && !abort.signal.aborted) setError(sourceError(e)) }
    finally { lock.current = false; if (active.current) setLoading(false) }
  }
  async function confirm(retry = false) {
    if (!plan || (submitted && !(retry && (status?.status === 'failed' || retryConfirmation))) || lock.current) return
    lock.current = true; setLoading(true); setError(''); setRetryConfirmation(false); setSubmitted(true); save({ plan, submitted: true })
    const abort = new AbortController(); pending.current = abort
    try {
      const value = await knowledgeV3Post<DeleteStatus>('/library/delete', { paperId: paper.id, planId: plan.planId }, abort.signal)
      if (!active.current) return
      if (acceptStatus(value, plan).status === 'running') timer.current = setTimeout(() => void query(plan), 1500)
    } catch (e) {
      if (active.current && !abort.signal.aborted) {
        if (axios.isAxiosError(e) && e.response?.data?.detail?.code === 'paper_delete_plan_expired') {
          save(null); setSubmitted(false); setPlan(null); setError('删除确认已过期，请重新检查后确认。')
        } else setError(`${sourceError(e)} 请查询删除结果，不要重复提交。`)
      }
    }
    finally { lock.current = false; if (active.current) setLoading(false) }
  }
  useEffect(() => {
    active.current = true; const prior = document.activeElement as HTMLElement; box.current?.querySelector<HTMLButtonElement>('[data-close]')?.focus()
    queueMicrotask(() => {
      if (!active.current) return
      if (!canPreview) { setLoading(false); setError('此原件尚未登记到知识库，暂不能执行全库删除。'); return }
      let restored = false
      try { const value = JSON.parse(localStorage.getItem(key) || 'null') as Pending | null; if (value?.submitted && value.plan?.path === paper.id) { acceptPlan(value.plan); setSubmitted(true); restored = true; void query(value.plan) } } catch { /* Invalid local state cannot authorize deletion. */ }
      if (!restored) void preview()
    })
    return () => { active.current = false; pending.current?.abort(); if (timer.current) clearTimeout(timer.current); lock.current = false; if (prior?.isConnected) prior.focus() }
    // Each dialog instance is bound to one paper and one authenticated namespace.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const closeDisabled = submitted && loading && !status
  const safeClose = () => { if (!closeDisabled) onClose() }
  return <div className="kso-dialog-layer" onMouseDown={event => { if (event.target === event.currentTarget) safeClose() }}><div ref={box} className="kso-dialog kso-paper-delete" role="dialog" aria-modal="true" aria-labelledby="kso-paper-delete-title" aria-describedby="kso-paper-delete-scope" onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); safeClose() }
    if (event.key === 'Tab') { const nodes = Array.from(box.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href]') || []); const first = nodes[0], last = nodes.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() } }
  }}><div className="kso-dialog-head"><h2 id="kso-paper-delete-title">{originalOnly ? '删除 PDF 原件' : '从知识库删除文件'}</h2><button data-close type="button" className="kso-icon-btn" aria-label="关闭删除窗口" disabled={closeDisabled} onClick={safeClose}><X /></button></div><div className="kso-dialog-body">
    {position && <p className="kso-small">逐份确认删除 · 第 {position.current} / {position.total} 份</p>}
    <strong>{paper.title}</strong>
    <p id="kso-paper-delete-scope">{originalOnly ? '将删除这份已保存的 PDF 原件，并从所有文件夹中移除。' : '将从整个知识库删除此文件，所有文件夹都将不再显示。'}</p>
    {affectedFolders.length > 0 && <div className="kso-paper-delete-folder-scope">
      <p id="kso-paper-delete-folders" className="kso-small">受影响的文件夹（当前可见）</p>
      <ul aria-labelledby="kso-paper-delete-folders">
        {affectedFolders.map(folder => <li key={folder.id} className="kso-chip">{folder.name}</li>)}
      </ul>
    </div>}
    {plan && <>{!originalOnly && <p className="kso-small">同时删除 {plan.pages.length} 项仅由此文件生成的关联内容；保留 {plan.sharedCount} 项共享内容{plan.unverifiedCount > 0 ? `及 ${plan.unverifiedCount} 项无法确认归属的内容` : ''}。</p>}<p className="kso-error">此操作无法在知识源中撤销，请确认后继续。</p></>}
    {position && submitted && <p className="kso-small">退出后，本次已确认的删除会继续执行。</p>}
    {loading && <p role="status"><LoaderCircle className="if-spin" />{submitted ? '正在确认删除进度…' : '正在检查删除范围…'}</p>}
    {status && <p role="status">{status.status === 'succeeded' ? '文件已删除。' : status.status === 'failed' ? `删除未完成：${status.message || '请核对后重试查询。'}` : `正在删除 ${status.completed} / ${status.total} 项…`}</p>}
    {error && <p role="alert" className="kso-error">{error}</p>}
  </div><div className="kso-dialog-foot"><button type="button" className="kso-btn" disabled={closeDisabled} onClick={safeClose}>{position ? '退出逐份确认' : submitted ? '关闭' : '取消'}</button>{submitted && plan ? <><button type="button" className="kso-btn" disabled={loading} onClick={() => void query(plan)}>查询删除结果</button>{(status?.status==='failed'||retryConfirmation)&&<button type="button" className="kso-btn danger" disabled={loading} onClick={()=>void confirm(true)}>{retryConfirmation?'重试确认删除':'继续删除'}</button>}</> : error ? <button type="button" className="kso-btn" disabled={loading || !canPreview} onClick={() => void preview()}>重新检查</button> : <button type="button" className="kso-btn danger" disabled={!plan || loading} onClick={() => void confirm()}><Trash2 />{originalOnly ? '确认删除原件' : '确认删除文件'}</button>}</div></div></div>
}
