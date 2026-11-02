import { render, screen } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import ReportMarkdown from './ReportMarkdown'

describe('report Markdown security and portable images', () => {
  it('renders only bounded embedded images and never requests remote images or raw HTML', () => {
    const html = renderToStaticMarkup(<ReportMarkdown>{'![inline](data:image/png;base64,aGVsbG8=)\n\n![remote](https://collector.example/pixel)\n\n<img src="https://collector.example/raw">'}</ReportMarkdown>)
    expect(html).toContain('src="data:image/png;base64,aGVsbG8="')
    expect(html).not.toContain('collector.example')
    expect(html.match(/<img /g)).toHaveLength(1)
  })
  it('uses the shared safe-link policy and retains note source links', () => {
    render(<ReportMarkdown>{'[note](/notes?note=123)\n\n[credentials](https://user:password@example.com/a)\n\n[protocol-relative](//example.com/a)\n\n[unsafe](javascript:alert%281%29)'}</ReportMarkdown>)
    expect(screen.getByRole('link', { name: 'note' })).toHaveAttribute('href', '/notes?note=123')
    expect(screen.getByRole('link', { name: 'note' })).toHaveAttribute('rel', 'noopener noreferrer')
    for (const name of ['credentials', 'protocol-relative', 'unsafe']) expect(screen.queryByRole('link', { name })).toBeNull()
  })
})
