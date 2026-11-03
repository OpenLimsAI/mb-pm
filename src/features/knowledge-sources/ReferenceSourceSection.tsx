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
    if (await mutate('post', '/jobs', { sourceId: source.id, documentIds: selected, parse }, '参考论文下载任务已提交，可在下载任务查看结果。')) setPicks([])
  }
  return <section className="kso-source-section kso-reference-section" aria-label={`${source.name}来源与论文`}>
    <div className="kso-source-card"><div className="kso-source-card-head"><div className="kso-source-logo"><FolderInput /></div><div><h2>{source.name}</h2><p>从{source.name.startsWith('研究报告') ? '研究报告' : '个人 AI 助手'}检索结果导入的公开论文链接</p></div><span className="kso-chip blue">{docs.length} 篇参考论文</span></div>
      <p className="kso-small">导入链接后按需下载公开 PDF。下载成功才保存原件，付费或无法访问的链接会显示具体失败原因。</p>
      <div className="kso-source-searchbar"><span>下载后归入 <strong>{source.name}</strong></span><button type="button" className="kso-btn" onClick={onDownloads}>查看下载任务</button></div>
      {unfinished && <p className="kso-connection" role="status">此分类有进行中或暂停的任务，请先完成、继续或取消该任务。</p>}
    </div>
    <div className="kso-catalog"><div className="kso-catalog-tools"><label className="kso-search"><Search /><input aria-label={`筛选${source.name}`} placeholder="搜索标题或原始链接" value={query} onChange={event => setQuery(event.target.value)} /></label><span className="kso-small">已保存 {docs.filter(doc => doc.versions.length > 0).length} / {docs.length} 篇</span></div>
      {canDownload && shown.length > 0 && <div className="kso-catalog-selectbar"><label className="kso-check"><input type="checkbox" aria-label={`全选${source.name}当前结果`} checked={shown.every(doc => selected.includes(doc.id))} disabled={busy} onChange={event => setPicks(event.target.checked ? [...new Set([...picks, ...shown.map(doc => doc.id)])] : picks.filter(id => !shown.some(doc => doc.id === id)))} />全选当前结果</label><span>已选 {selected.length} 篇</span>{selected.length > 0 && <button type="button" className="kso-btn quiet" disabled={busy} onClick={() => setPicks([])}>清空选择</button>}</div>}
      <div className="kso-catalog-results">{shown.map(doc => {
        const url = safeWebSourceUrl(doc.url), saved = doc.versions.length > 0
        return <article key={doc.id} ref={doc.id === focusDocument ? target : undefined} className={`kso-catalog-row${doc.id === focusDocument ? ' kso-reference-focused' : ''}${selected.includes(doc.id) ? ' is-selected' : ''}`} aria-label={doc.title}>
          <label className="kso-catalog-document">{canDownload ? <input type="checkbox" aria-label={`选择 ${doc.title}`} checked={selected.includes(doc.id)} disabled={busy} onChange={event => setPicks(event.target.checked ? [...new Set([...picks, doc.id])] : picks.filter(id => id !== doc.id))} /> : <FileText size={17} />}<span><strong>{doc.title}</strong><small>{url ? new URL(url).hostname : '原始链接待确认'} · {new Date(doc.discoveredAt).toLocaleDateString('zh-CN')}</small>{doc.error && <small className="kso-error">{doc.error}</small>}</span></label>
          <div className="kso-catalog-row-meta"><span className={`kso-chip${saved ? ' green' : ''}`}>{saved ? <><Check size={12} />已保存原文</> : '已导入 · 未下载'}</span>{url && <a href={url} target="_blank" rel="noopener noreferrer">论文原始链接<ExternalLink size={12} /></a>}</div>
        </article>
      })}</div>
      {!shown.length && <div className="kso-catalog-empty"><FileText /><h3>{docs.length ? '没有匹配的参考论文' : '还没有导入参考论文'}</h3><p>在研究报告或个人 AI 助手的检索来源卡片中点击“导入知识源”。</p></div>}
      {canDownload ? <footer className="kso-catalog-download"><div><strong>{selected.length} 篇 <span aria-hidden="true">→</span> {source.name}</strong><label className="kso-check"><input type="checkbox" checked={parse} disabled={busy} onChange={event => setParse(event.target.checked)} />下载后加入知识库并建立问答索引</label></div><button type="button" className="kso-btn primary" disabled={busy || unfinished || !selected.length || selected.length > 1500} onClick={() => void download()}><Download />下载所选{selected.length > 0 ? `（${selected.length}）` : ''}</button>{selected.length > 1500 && <span role="alert">单次最多下载 1500 篇，请减少选择。</span>}</footer> : <p className="kso-reference-permission">论文信息已保留；下载原文由具备知识库写入权限的负责人操作。</p>}
    </div>
  </section>
}
