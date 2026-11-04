import { useEffect, useState } from 'react'
import type { ReportCollaboration, Reviewer, Solution, SolutionClient } from './types'
import './reportCollaboration.css'

export default function ReportCollaborationPanel({ doc, client, currentSectionId, selectedText = '', onNavigate }: {
  doc: Solution; client: SolutionClient; currentSectionId: string; selectedText?: string
  onNavigate: (sectionId: string, quote: string) => void
}) {
  const [state, setState] = useState<ReportCollaboration | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [content, setContent] = useState(''), [reply, setReply] = useState<string | null>(null), [resolved, setResolved] = useState(false)
  const [people, setPeople] = useState<Reviewer[]>([]), [person, setPerson] = useState(''), [role, setRole] = useState<'editor' | 'commenter'>('commenter')
  async function refresh() { if (client.collaboration) setState(await client.collaboration(doc.id)) }
  async function perform(action: () => Promise<unknown>) {
    setBusy(true); setError('')
    try { await action(); await refresh() } catch (reason) { setError(reason instanceof Error ? reason.message : '协作操作未完成') } finally { setBusy(false) }
  }
  useEffect(() => {
    let active = true
    async function heartbeat() {
      if (document.hidden) return
      try {
        const result = client.presence ? await client.presence(doc.id, currentSectionId) : await client.collaboration?.(doc.id)
        if (active && result) { setState(result); setError('') }
      } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : '协作状态暂不可用') }
    }
    void heartbeat()
    const timer = setInterval(() => void heartbeat(), 20000)
    return () => { active = false; clearInterval(timer) }
  }, [client, doc.id, currentSectionId])
  useEffect(() => { if (!state?.canManage) return; let active = true; client.reviewers().then(rows => { if (active) setPeople(rows.filter(p => p.id !== doc.ownerId)) }).catch(() => {}); return () => { active = false } }, [client, doc.ownerId, state?.canManage])
  const parent = state?.comments.find(c => c.id === reply)
  return <div className="ks-collaboration">
    <p className="ks-muted">批注与回复保存到服务器。协作状态每 20 秒刷新；多人修改同一报告时，保存会检查版本并提示冲突。</p>
    {error && <p role="alert" className="ks-error-inline">{error}<button className="ks-button" onClick={() => void perform(refresh)}>重试</button></p>}
    {state && state.revision > doc.revision && <p role="status" className="ks-collab-conflict">服务器已有更新（r{state.revision}）。请先保存当前草稿副本，再重新载入比较。</p>}
    <section aria-label="协作者"><h3>协作者</h3><div className="ks-collab-members">{state?.members.map(member => <span key={member.id}>{member.name} · {member.role === 'owner' ? '作者' : member.role === 'editor' ? '可编辑' : '可批注'}{state.canManage && member.role !== 'owner' && <button className="ks-button" disabled={busy} aria-label={`移除协作者 ${member.name}`} onClick={() => void perform(() => client.saveMember!(doc.id, member.id, 'removed'))}>移除</button>}</span>)}</div>
      {state?.canManage && <form onSubmit={event => { event.preventDefault(); void perform(() => client.saveMember!(doc.id, person, role)) }}><label>添加协作者<select aria-label="添加协作者" value={person} onChange={e => setPerson(e.target.value)}><option value="">选择同组织账号</option>{people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><select aria-label="协作权限" value={role} onChange={e => setRole(e.target.value as typeof role)}><option value="commenter">可批注</option><option value="editor">可编辑</option></select><button className="ks-button ks-primary" disabled={!person || busy || !client.saveMember}>添加</button></form>}
      <div className="ks-muted">{state?.presence.length ? state.presence.map(p => `${p.actorName}：${doc.sections.find(s => s.id === p.sectionId)?.title || '章节已删除'}`).join(' · ') : '暂无在线协作者'}</div>
    </section>
    <section><div className="ks-collab-section"><h3>段落批注</h3><label><input type="checkbox" checked={resolved} onChange={e => setResolved(e.target.checked)} />显示已解决</label></div>
      <form onSubmit={event => { event.preventDefault(); void perform(async () => { await client.comment!(doc.id, { sectionId: parent?.sectionId || currentSectionId, quote: parent ? '' : selectedText, content, ...(parent ? { parentId: parent.id } : {}) }); setContent(''); setReply(null) }) }}>
        {parent ? <p>回复 {parent.actorName}<button type="button" className="ks-button" onClick={() => setReply(null)}>取消回复</button></p> : selectedText ? <blockquote>{selectedText}</blockquote> : <p className="ks-muted">为当前章节添加批注，也可先选择正文中的一段文字。</p>}
        <textarea aria-label="批注内容" rows={3} maxLength={8000} value={content} onChange={e => setContent(e.target.value)} placeholder={parent ? '输入回复…' : '输入批注…'} /><button className="ks-button ks-primary" disabled={busy || !content.trim() || !client.comment}>{parent ? '提交回复' : '添加批注'}</button>
      </form>
      {state?.comments.filter(c => !c.parentId && (resolved || !c.resolved)).map(comment => <article className="ks-collab-comment" key={comment.id}><header><strong>{comment.actorName}</strong><small>{new Date(comment.createdAt).toLocaleString('zh-CN')}{comment.resolved ? ' · 已解决' : ''}</small></header>{comment.quote && <button className="ks-collab-quote" onClick={() => onNavigate(comment.sectionId, comment.quote)}>{comment.quote}</button>}<p>{comment.content}</p><small>{doc.sections.find(s => s.id === comment.sectionId)?.title || '原章节已删除'}</small><div>{client.comment && <button className="ks-button" onClick={() => setReply(comment.id)}>回复</button>}{client.resolveComment && <button className="ks-button" disabled={busy} onClick={() => void perform(() => client.resolveComment!(doc.id, comment.id, comment.revision, !comment.resolved))}>{comment.resolved ? '重新打开' : '标记已解决'}</button>}</div>{state.comments.filter(c => c.parentId === comment.id).map(response => <div className="ks-collab-reply" key={response.id}><strong>{response.actorName}</strong><p>{response.content}</p></div>)}</article>)}
      {state && !state.comments.some(c => !c.parentId && (resolved || !c.resolved)) && <p className="ks-muted">暂无待处理批注。</p>}
    </section>
  </div>
}
