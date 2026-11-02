import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { safeReportImage } from './reportMarkup'
import { safeMarkdownLink } from '../../components/markdownSafety'

export default function ReportMarkdown({ children }: { children: string }) {
  return <div className="ks-markdown"><ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} urlTransform={(url, key) => key === 'src' ? safeReportImage(url) ? url : '' : defaultUrlTransform(url)} components={{ a: ({ href, children }) => safeMarkdownLink(href) ? <a href={safeMarkdownLink(href)} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>, img: ({ src, alt }) => safeReportImage(src || '') ? <img src={src} alt={alt} /> : <span className="ks-image-placeholder">[图片：{alt || '外部图片未加载'}]</span> }}>{children}</ReactMarkdown></div>
}
