import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { safeMarkdownLink } from './markdownSafety'


/** Untrusted reports and model output never load images or insert raw HTML. */
export default function SafeMarkdown({ children }: { children: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
    img: ({ alt }) => <span className="markdown-image-label">{alt || '图片'}</span>,
    a: ({ href, children }) => safeMarkdownLink(href)
      ? <a href={safeMarkdownLink(href)} target="_blank" rel="noopener noreferrer">{children}</a>
      : <span>{children}</span>,
  }}>{children}</ReactMarkdown>
}
