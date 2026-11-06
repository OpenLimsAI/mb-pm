import { useEffect, useRef, useState } from 'react'
import { Check, Download, ExternalLink, FileText, FolderInput, Search } from 'lucide-react'
import type { KnowledgeSourceSnapshot, SourceDefinition } from './api'
import { safeWebSourceUrl } from '../answerModes/sourceUrl'
import './referenceSources.css'

type Mutation = (method: 'post' | 'patch', path: string, body: unknown, success: string) => Promise<boolean>
interface Props { source: SourceDefinition; data: KnowledgeSourceSnapshot; busy: boolean; mutate: Mutation; onDownloads: () => void; focusDocument?: string }
export default function ReferenceSourceSection({ source, data, busy, mutate, onDownloads, focusDocument }: Props) {
  const [query, setQuery] = useState(''), [picks, setPicks] = useState<string[]>([]), [parse, setParse] = useState(true)
  const target = useRef<HTMLElement>(null)
  const docs = data.documents.filter(document => document.sourceId === source.id)
  const needle = query.trim().toLocaleLowerCase()
  const shown = docs.filter(doc => !needle || `${doc.title} ${doc.url}`.toLocaleLowerCase().includes(needle)).sort((a, b) => Number(b.id === focusDocument) - Number(a.id === focusDocument) || b.discoveredAt.localeCompare(a.discoveredAt))
  const selected = picks.filter(id => docs.some(doc => doc.id === id))
  const unfinished = data.jobs.some(job => job.sourceId === source.id && ['pending', 'queued', 'running', 'paused'].includes(job.status))
  const canDownload = data.canManage && data.canOrganize
  useEffect(() => { if (focusDocument) target.current?.scrollIntoView?.({ block: 'nearest' }) }, [focusDocument])
  async function download() {
    if (!selected.length || busy || unfinished || !canDownload) return
    if (await mutate('post', '/jobs', { sourceId: source.id, documentIds: selected, parse }, 'PDF 下载任务已提交，可在下载任务查看结果；找不到公开 PDF 时会提示无法下载。')) setPicks([])
  }
  return <section className="kso-source-section kso-reference-section" aria-label={`${source.name}来源与资料`}>
    <div className="kso-source-card"><div className="kso-source-card-head"><div className="kso-source-logo"><FolderInput /></div><div><h2>{source.name}</h2><p>从应用检索结果保存的来源链接</p></div><span className="kso-chip blue">{docs.length} 条参考资料</span></div>
      <p className="kso-small">来源链接可能指向网页、摘要或 PDF，导入不代表已经下载。只保存公开可下载的 PDF；找不到时提示“无法下载”，并保留来源链接。</p>
      <div className="kso-source-searchbar"><span>下载后归入 <strong>{source.name}</strong></span><button type="button" className="kso-btn" onClick={onDownloads}>查看下载任务</button></div>
      {unfinished && <p className="kso-connection" role="status">此分类有进行中或暂停的任务，请先完成、继续或取消该任务。</p>}
    </div>
    <div className="kso-catalog"><div className="kso-catalog-tools"><label className="kso-search"><Search /><input aria-label={`筛选${source.name}`} placeholder="搜索标题或原始链接" value={query} onChange={event => setQuery(event.target.value)} /></label><span className="kso-small">已下载 PDF {docs.filter(doc => doc.versions.length > 0).length} / {docs.length} 条</span></div>
      {canDownload && shown.length > 0 && <div className="kso-catalog-selectbar"><label className="kso-check"><input type="checkbox" aria-label={`全选${source.name}当前结果`} checked={shown.every(doc => selected.includes(doc.id))} disabled={busy} onChange={event => setPicks(event.target.checked ? [...new Set([...picks, ...shown.map(doc => doc.id)])] : picks.filter(id => !shown.some(doc => doc.id === id)))} />全选当前结果</label><span>已选 {selected.length} 条</span>{selected.length > 0 && <button type="button" className="kso-btn quiet" disabled={busy} onClick={() => setPicks([])}>清空选择</button>}</div>}
      <div className="kso-catalog-results">{shown.map(doc => {
        const url = safeWebSourceUrl(doc.url), saved = doc.versions.length > 0
        const unavailable = !saved && doc.downloadStatus === 'unavailable'
        const currentVersion = doc.versions.find(version => version.id === doc.currentVersionId) || doc.versions.find(version => version.sha256 === doc.verifiedSha256) || [...doc.versions].sort((a,b) => b.createdAt.localeCompare(a.createdAt))[0]
        const indexLabel = currentVersion?.parseStatus === 'failed' ? '解析失败 · PDF 已保留' : currentVersion?.indexStatus === 'failed' ? '索引失败 · PDF 已保留' : currentVersion?.indexStatus === 'ready' ? '可用于知识库问答' : '问答索引尚未就绪'
        const error = saved ? currentVersion?.error || doc.error : doc.error
        return <article key={doc.id} ref={doc.id === focusDocument ? target : undefined} className={`kso-catalog-row${doc.id === focusDocument ? ' kso-reference-focused' : ''}${selected.includes(doc.id) ? ' is-selected' : ''}`} aria-label={doc.title}>
          <label className="kso-catalog-document">{canDownload ? <input type="checkbox" aria-label={`选择 ${doc.title}`} checked={selected.includes(doc.id)} disabled={busy} onChange={event => setPicks(event.target.checked ? [...new Set([...picks, doc.id])] : picks.filter(id => id !== doc.id))} /> : <FileText size={17} />}<span><strong>{doc.title}</strong><small>{url ? new URL(url).hostname : '原始链接待确认'} · {new Date(doc.discoveredAt).toLocaleDateString('zh-CN')}</small>{error && <small className="kso-error">{error}</small>}</span></label>
          <div className="kso-catalog-row-meta"><span className={`kso-chip${saved ? ' green' : unavailable || doc.error ? ' warn' : ''}`}>{saved ? <><Check size={12} />已下载 PDF</> : unavailable ? '无法下载' : doc.error ? '下载未完成' : '仅保存来源链接'}</span><span className="kso-small">{saved ? indexLabel : unavailable ? '来源链接仍保留' : 'PDF 待核验 · 未加入问答索引'}</span>{url && <a href={url} target="_blank" rel="noopener noreferrer">查看原始链接<ExternalLink size={12} /></a>}</div>
        </article>
      })}</div>
      {!shown.length && <div className="kso-catalog-empty"><FileText /><h3>{docs.length ? '没有匹配的参考资料' : '还没有导入参考资料'}</h3><p>在研究报告或个人 AI 助手的检索来源卡片中点击“导入知识源”。</p></div>}
      {canDownload ? <footer className="kso-catalog-download"><div><strong>{selected.length} 条 <span aria-hidden="true">→</span> {source.name}</strong><label className="kso-check"><input type="checkbox" checked={parse} disabled={busy} onChange={event => setParse(event.target.checked)} />下载后加入知识库并建立问答索引</label></div><button type="button" className="kso-btn primary" disabled={busy || unfinished || !selected.length || selected.length > 1500} onClick={() => void download()}><Download />下载所选{selected.length > 0 ? `（${selected.length}）` : ''}</button>{selected.length > 1500 && <span role="alert">单次最多下载 1500 条，请减少选择。</span>}</footer> : <p className="kso-reference-permission">来源链接已保留；下载 PDF 由具备知识库写入权限的负责人操作。</p>}
    </div>
  </section>
}
