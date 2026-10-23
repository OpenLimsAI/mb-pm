import { useEffect, useRef, useState } from 'react'
import { ExternalLink, LoaderCircle } from 'lucide-react'
import { asAPIError } from '../../api/client'
import { compareInformationVersions, readInformationVersion, type InformationDocument } from './api'

const phase = (value: string) => ({ ready: '已完成', failed: '失败', pending: '等待处理', not_requested: '未要求索引' })[value] || value
function safeLink(value?: string) {
  if (!value) return undefined
  try { const url = new URL(value || '', window.location.origin); return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined } catch { return undefined }
}

export default function LiveDocumentDetail({ doc, onRetry }: { doc: InformationDocument; onRetry?: () => void }) {
  const [tab, setTab] = useState('versions'), [text, setText] = useState(''), [error, setError] = useState(''), [loading, setLoading] = useState(false)
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => request.current?.abort(), [])
  async function show(versionId?: string) {
    const current = doc.versions.at(-1), previous = doc.versions.at(-2)
    if (!versionId && (!current || !previous)) return
    request.current?.abort()
    const controller = new AbortController(); request.current = controller
    setLoading(true); setError('')
    try {
      if (versionId) {
        const result = await readInformationVersion(doc.id, versionId, controller.signal)
        if (!controller.signal.aborted) { setText(result.text || '正文尚未提取，请先执行解析。'); setTab('text') }
      } else if (current && previous) {
        const result = await compareInformationVersions(doc.id, previous.id, current.id, controller.signal)
        if (!controller.signal.aborted) {
          setText(result.identical ? '两个版本的正文相同，文件字节可能因格式信息而变化。' : (result.text || '未发现可显示的正文差异。') + (result.truncated ? '\n\n差异已截取，完整内容请查看两个版本原文。' : ''))
          setTab('diff')
        }
      }
    } catch (failure) {
      if (!controller.signal.aborted) { const message = asAPIError(failure).detail; setError(typeof message === 'string' ? message : '读取归档资料失败') }
    } finally { if (!controller.signal.aborted) setLoading(false) }
  }
  return <article className="if-document-detail">
    <div className="if-detail-overline">{doc.scopes.join(' / ')} · {doc.documentType}</div><h2>{doc.title}</h2>
    <p className="if-caption">官方阶段：{doc.officialStatus || '来源未提供'} · 官方日期：{doc.officialDate || '来源未提供'}</p>
    <p className="if-caption">官方阶段不代表企业内部生效；采集版本按原文件校验值保留。</p>
    {safeLink(doc.url) && <a className="if-inline-link" href={safeLink(doc.url)} target="_blank" rel="noreferrer">打开官方原文<ExternalLink size={14} /></a>}
    {doc.error && <div className="if-message is-error">{doc.error}{onRetry && <button className="if-button" onClick={onRetry}>重试解析或索引</button>}</div>}
    <div className="if-tabs" role="tablist" aria-label="资料详情"><button role="tab" aria-selected={tab === 'versions'} onClick={() => setTab('versions')}>原文与版本</button><button role="tab" aria-selected={tab === 'diff'} disabled={doc.versions.length < 2 || loading} onClick={() => { void show() }}>比较最近两版</button></div>
    {error && <p role="alert" className="if-error-text">{error}</p>}{loading && <p role="status"><LoaderCircle className="if-spin" size={16} />正在读取归档资料…</p>}
    {tab === 'versions' ? <div role="tabpanel" aria-label="原文与版本">{doc.versions.length ? [...doc.versions].reverse().map((version, index) => <section key={version.id} className="if-version">
      <div className="if-section-head"><h3>采集版本 {doc.versions.length - index}</h3><span>{new Date(version.createdAt).toLocaleString('zh-CN')}</span></div>
      <div className="if-version-states"><span>正文解析：{phase(version.parseStatus)}</span><span>知识库索引：{phase(version.indexStatus)}</span></div>
      <p className="if-caption">{(version.size / 1024).toFixed(1)} KB · SHA256 <code title={version.sha256}>{version.sha256.slice(0, 16)}…</code></p>
      {version.error && <p className="if-error-text">{version.error}</p>}<div className="if-actions">
        {safeLink(version.archiveUrl) && <a className="if-button" href={safeLink(version.archiveUrl)} target="_blank" rel="noreferrer">查看归档原文<ExternalLink size={14} /></a>}
        {onRetry && version.kbUrl && version.indexStatus !== 'ready' && <button className="if-button" onClick={onRetry}>建立或重试知识库索引</button>}<button className="if-button" disabled={loading || version.parseStatus !== 'ready'} onClick={() => { void show(version.id) }}>查看解析正文</button>
        {version.indexStatus === 'ready' && version.kbUrl && safeLink(version.kbUrl) && <a className="if-button" href={safeLink(version.kbUrl)} target="_blank" rel="noreferrer">进入知识库<ExternalLink size={14} /></a>}
      </div></section>) : <div className="if-soft-box"><h3>已发现，尚未收录</h3><p>负责人可从批量收录创建后台任务；归档、解析和知识库索引分别记录。</p></div>}</div> : <div role="tabpanel" aria-label={tab === 'diff' ? '版本变化' : '解析正文'} className="if-soft-box"><pre className="if-real-text">{text.slice(0, 200000)}</pre>{text.length > 200000 && <p>页面仅显示前 20 万字符，完整内容请查看归档原文。</p>}</div>}
    <div className="if-soft-box"><h3>知识问答</h3><p>{doc.versions.some(version => version.indexStatus === 'ready') ? '资料已完成知识库索引，可前往知识库阅读和提问。' : '完成知识库收录及索引后，可在知识库提问。本页不生成示例回答。'}</p></div>
  </article>
}
