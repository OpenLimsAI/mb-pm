import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { noteSourceUrl } from '../notes/client'
export default function MarkdownView({ children }: { children: string }) {
  return <div className="aa-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{ a: ({ href, children }) => noteSourceUrl(href || '') ? <a href={noteSourceUrl(href || '')} target="_blank" rel="noreferrer">{children}</a> : <span>{children}</span>, img: ({ alt }) => <span className="aa-image-label">{alt || '图片'}</span> }}>{children}</ReactMarkdown></div>
}
