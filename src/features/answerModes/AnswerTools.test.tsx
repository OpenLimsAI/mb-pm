import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AnswerEvidence, SearchCapability } from './AnswerTools'
import { safeWebSourceUrl } from './sourceUrl'

describe('answer provenance', () => {
  it('summarizes a personal general answer from its actual mode and source usage', () => {
    render(<AnswerEvidence showSourceScope part="status" answer={{ answerMode: 'general', requestedMode: 'auto', usedSources: [] }} />)
    const scope = screen.getByRole('group', { name: '本轮回答来源' })
    expect(within(scope).getByText('通用回答')).toBeInTheDocument()
    expect(within(scope).getByText('未查询知识库')).toBeInTheDocument()
    expect(within(scope).getByText('未联网')).toBeInTheDocument()
    expect(screen.queryByText('本轮未读取应用数据')).not.toBeInTheDocument()
  })

  it('keeps used knowledge and completed web search distinct in a personal source summary', () => {
    const { rerender } = render(<AnswerEvidence showSourceScope answer={{ answerMode: 'application', usedSources: ['projects', 'knowledge'] }} />)
    expect(screen.getByText('本轮应用数据：项目管理、知识库')).toBeInTheDocument()
    expect(screen.getByText('未联网')).toBeInTheDocument()
    expect(screen.queryByText('未查询知识库')).not.toBeInTheDocument()
    rerender(<AnswerEvidence showSourceScope answer={{ answerMode: 'web', usedSources: [] }} />)
    expect(screen.getByText('已联网检索')).toBeInTheDocument()
    expect(screen.getByText('未查询知识库')).toBeInTheDocument()
    expect(screen.queryByText('未联网')).not.toBeInTheDocument()
    rerender(<AnswerEvidence showSourceScope answer={{ answerMode: 'knowledge' }} />)
    expect(screen.getByText('知识库回答')).toBeInTheDocument()
    expect(screen.queryByText('未查询知识库')).not.toBeInTheDocument()
    expect(screen.queryByText('本轮应用数据：知识库')).not.toBeInTheDocument()
  })

  it('shows official DeepSeek readiness only when confirmed by the server', () => {
    const capability = { webSearch: { configured: true, provider: 'deepseek' as const, message: '复用当前模型密钥' }, modes: [] }
    const { rerender } = render(<SearchCapability value={capability} />)
    expect(screen.getByText('DeepSeek 官方搜索已就绪')).toBeInTheDocument()
    expect(screen.getByText('复用当前模型密钥')).toBeInTheDocument()
    rerender(<SearchCapability value={capability} preview />)
    expect(screen.getByText('联网搜索界面演示')).toBeInTheDocument()
    expect(screen.queryByText('DeepSeek 官方搜索已就绪')).not.toBeInTheDocument()
    expect(screen.queryByText('复用当前模型密钥')).not.toBeInTheDocument()
    expect(screen.getByText(/演示不会实际联网/)).toBeInTheDocument()
  })

  it('shows real project usage from response metadata and distinguishes the project interface demo', () => {
    const { rerender } = render(<AnswerEvidence answer={{ answerMode: 'application', usedSources: ['projects'], modeReason: '只读查询授权项目。' }} />)
    expect(screen.getByText('应用数据回答')).toBeInTheDocument()
    expect(screen.getByText('本轮应用数据：项目管理')).toBeInTheDocument()
    expect(screen.queryByText('知识库回答')).not.toBeInTheDocument()
    rerender(<AnswerEvidence preview answer={{ answerMode: 'application', usedSources: ['projects', 'knowledge'] }} />)
    expect(screen.getByText('本轮演示范围：项目管理、知识库')).toBeInTheDocument()
    expect(screen.getByText('界面演示 · 未读取真实项目数据')).toBeInTheDocument()
    expect(screen.queryByText('本轮应用数据：项目管理、知识库')).not.toBeInTheDocument()
  })

  it('does not infer unused application data for older records without usage metadata', () => {
    render(<AnswerEvidence answer={{ answerMode: 'knowledge' }} />)
    expect(screen.getByText('知识库回答')).toBeInTheDocument()
    expect(screen.queryByText('本轮未读取应用数据')).not.toBeInTheDocument()
  })

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
