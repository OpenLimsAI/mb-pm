import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

function safeLink(value: string | undefined): string | undefined {
  if (!value || /[\u0000-\u0020\u007f\\]/.test(value)) return undefined
  if (value.startsWith('/') && !value.startsWith('//')) return value
  if (value.startsWith('#')) return value
  try {
    const url = new URL(value)
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? value : undefined
  } catch { return undefined }
}

/** Untrusted reports and model output never load images or insert raw HTML. */
export default function SafeMarkdown({ children }: { children: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
    img: ({ alt }) => <span className="markdown-image-label">{alt || '图片'}</span>,
    a: ({ href, children }) => safeLink(href)
      ? <a href={safeLink(href)} target="_blank" rel="noopener noreferrer">{children}</a>
      : <span>{children}</span>,
  }}>{children}</ReactMarkdown>
}
