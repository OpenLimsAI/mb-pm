import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { NumberedReference } from './reportReferences'
import { resolveCitations } from './reportReferences'
import type { Reference } from './types'
import { safeReportImage } from './reportMarkup'
import { safeMarkdownLink } from '../../components/markdownSafety'

export default function ReportMarkdown({ children, references = [], onReference }: { children: string; references?: NumberedReference[]; onReference?: (reference: Reference) => void }) {
  const content = resolveCitations(children, references, true)
  return <div className="ks-markdown"><ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} urlTransform={(url, key) => key === 'src' ? safeReportImage(url) ? url : '' : defaultUrlTransform(url)} components={{ a: ({ href, children }) => /^#report-(figure|table)-[a-zA-Z0-9_-]+$/.test(href || '') ? /^[图表]\s*\d+[ \u3000]/.test(String(children)) ? <span id={href!.slice(1)} className="ks-report-caption">{children}</span> : <a href={href} onClick={event => { event.preventDefault(); document.getElementById(href!.slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'center' }) }}>{children}</a> : href?.startsWith('#report-reference-') ? <button type="button" className="ks-button ks-inline-citation" onClick={() => { const item = references.find(ref => `#report-reference-${encodeURIComponent(ref.reference.id)}` === href); if (item) onReference?.(item.reference) }} title="核对引用原文">[{children}]</button> : safeMarkdownLink(href) ? <a href={safeMarkdownLink(href)} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>, img: ({ src, alt }) => safeReportImage(src || '') ? <img src={src} alt={alt} /> : <span className="ks-image-placeholder">[图片：{alt || '外部图片未加载'}]</span> }}>{content}</ReactMarkdown></div>
}
