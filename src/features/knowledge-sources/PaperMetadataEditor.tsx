import { useState } from 'react'
import { knowledgeV3Post, type PaperDetail } from './v3-api'
import { sourceError } from './api'

export default function PaperMetadataEditor({ detail, onSaved }: { detail: PaperDetail; onSaved: () => void }) {
  const [editing, setEditing] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const p = detail.paper
  const [title, setTitle] = useState(p.title), [authors, setAuthors] = useState((p.authors || []).join('; ')), [year, setYear] = useState(p.year || ''), [doi, setDoi] = useState(p.doi || ''), [abstract, setAbstract] = useState(p.abstract || '')
  async function save() {
    setBusy(true); setError('')
    try { await knowledgeV3Post('/library/metadata', { paperId: p.id, revision: detail.metadataRevision ?? 0, metadata: { title: title.trim(), authors: authors.split(/[;；]/).map(s => s.trim()).filter(Boolean), year, doi, abstract } }); setEditing(false); onSaved() }
    catch (e) { setError(sourceError(e)) } finally { setBusy(false) }
  }
  return <section className="ksv-card"><div className="kso-head"><h3>资料信息</h3>{detail.canWrite && !p.id.startsWith('archive:') && <button type="button" className="kso-btn quiet" onClick={() => setEditing(!editing)}>{editing ? '取消编辑' : '补充资料信息'}</button>}</div>{editing ? <form onSubmit={e => { e.preventDefault(); void save() }} className="ksv-metadata-form">
    <label>标题<input required maxLength={500} value={title} onChange={e => setTitle(e.target.value)} /></label>
    <label>作者（分号分隔）<input maxLength={2000} value={authors} onChange={e => setAuthors(e.target.value)} /></label>
    <label>年份<input maxLength={4} pattern="[0-9]{4}|" value={year} onChange={e => setYear(e.target.value)} /></label>
    <label>DOI<input maxLength={300} value={doi} onChange={e => setDoi(e.target.value)} /></label>
    <label>摘要<textarea maxLength={20000} rows={5} value={abstract} onChange={e => setAbstract(e.target.value)} /></label>
    <button className="kso-btn primary" disabled={busy || !title.trim()}>{busy ? '正在保存…' : '保存资料信息'}</button>
  </form> : <><dl className="ksv-metadata"><dt>作者</dt><dd>{p.authors?.join('；') || '未提供'}</dd><dt>年份</dt><dd>{p.year || '未提供'}</dd><dt>DOI</dt><dd>{p.doi || '未提供'}</dd>{p.code && <><dt>指南编号</dt><dd>{p.code}</dd></>}{p.officialStatus && <><dt>官方阶段</dt><dd>{p.officialStatus}</dd></>}{p.versionId && <><dt>原件版本</dt><dd>{p.versionId.slice(0, 12)}</dd></>}</dl>{p.abstract && <details><summary>摘要</summary><p className="ksv-abstract">{p.abstract}</p></details>}</>}{error && <p role="alert" className="kso-error">{error}</p>}</section>
}
