import { useState } from 'react'
import { knowledgeV3Post } from './v3-api'
import { sourceError } from './api'
import type { ReadingEntry, ReadingPosition, ReadingState } from './workspace-v3-types'
import './research-tools-v3.css'

export interface ReadingQueueProps {
  paperId: string
  versionId?: string
  reading?: ReadingEntry
  position?: ReadingPosition
  onChanged?: (entry: ReadingEntry) => void
}
export default function ReadingQueue({ paperId, versionId, reading, position, onChanged }: ReadingQueueProps) {
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  async function save(state: ReadingState, current = position || reading?.position || {}) {
    setBusy(true); setMessage('')
    try { const value = await knowledgeV3Post<ReadingEntry>('/workspace/reading', { paperId, versionId, state, position: current }); onChanged?.(value); setMessage('阅读状态已保存。') }
    catch (error) { setMessage(sourceError(error)) } finally { setBusy(false) }
  }
  return <section className="kso-v3-reading" aria-label="论文阅读状态"><label>阅读队列<select aria-label="论文阅读状态" disabled={busy} value={reading?.state || 'unread'} onChange={event => void save(event.target.value as ReadingState)}><option value="unread">待读</option><option value="reading">在读</option><option value="done">读完</option><option value="later">稍后</option></select></label>{reading?.position && <small>{reading.position.page ? `上次读到第 ${reading.position.page} 页` : reading.position.offset != null ? `上次读到正文第 ${reading.position.offset + 1} 字符` : reading.position.section || ''}</small>}{position && <button className="kso-btn" disabled={busy} onClick={() => void save('reading')}>记住当前阅读位置</button>}{message && <small role="status">{message}</small>}</section>
}
