import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AnswerEvidence, SearchCapability } from './AnswerTools'
import { safeWebSourceUrl } from './sourceUrl'

describe('answer provenance', () => {
  it('uses the actual response mode, preserves unknown publication dates, and opens safe source links', () => {
    render(<AnswerEvidence answer={{ answerMode: 'web', requestedMode: 'auto', modeReason: '需要核对近期资料。', webReferences: [{ id: 'one', title: '真实来源标题', url: 'https://example.org/research', publishedAt: null, retrievedAt: '2026-11-01T12:00:00Z', excerpt: '原文摘要。' }] }} />)
    expect(screen.getByText('已联网检索')).toBeInTheDocument()
    const source = screen.getByRole('region', { name: '本轮网络来源' })
    expect(within(source).getByText(/发表：未提供日期/)).toBeInTheDocument()
    expect(within(source).getByRole('link', { name: '真实来源标题' })).toHaveAttribute('rel', 'noopener noreferrer')
    expect(screen.queryByText('界面演示 · 未实际联网')).not.toBeInTheDocument()
  })

  it('labels every preview answer and never claims a real search completed', () => {
    render(<AnswerEvidence preview answer={{ answerMode: 'web', requestedMode: 'auto' }} />)
    expect(screen.getByText('界面演示 · 未实际联网')).toBeInTheDocument()
    expect(screen.getByLabelText('演示搜索流程')).toBeInTheDocument()
    expect(screen.queryByText('已联网检索')).not.toBeInTheDocument()
  })

  it('rejects executable, credentialed, and local source URLs without turning them into links', () => {
    for (const url of ['javascript:alert(1)', 'http://example.org', 'https://secret@example.org', 'https://localhost', 'https://127.0.0.1', 'https://0x7f.0.0.1', 'https://2130706433', 'https://example.org:8443', 'https://service.local', 'https://service.localhost.', 'https://service.internal', 'https://service.test', 'https://service.invalid', 'https://[::1]']) expect(safeWebSourceUrl(url)).toBeUndefined()
    expect(safeWebSourceUrl('https://example.org:443/research')).toBe('https://example.org/research')
    render(<AnswerEvidence answer={{ answerMode: 'web', webReferences: [{ id: 'bad', title: '异常来源', url: 'javascript:alert(1)', publishedAt: null, retrievedAt: '', excerpt: '' }] }} />)
    expect(screen.getByText('异常来源')).toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('distinguishes unknown capability status from confirmed missing configuration', () => {
    render(<SearchCapability value={null} />)
    expect(screen.getByText('联网搜索状态待确认')).toBeInTheDocument()
    expect(screen.queryByText('联网搜索待管理员配置')).not.toBeInTheDocument()
  })

  it('keeps long source snapshots collapsed behind a short excerpt', () => {
    render(<AnswerEvidence answer={{ answerMode: 'web', webReferences: [{ id: 'long', title: '长来源', url: 'https://example.org', publishedAt: null, retrievedAt: '', excerpt: '摘'.repeat(400) + '更多来源内容'.repeat(1000) }] }} />)
    expect(screen.getByText('摘'.repeat(400) + '…')).toBeInTheDocument()
    expect(screen.getByText('展开来源摘要').closest('details')).not.toHaveAttribute('open')
  })
})
