import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import RequestProgressView from './RequestProgressView'
import type { AssistantRequest } from './client'

const job = (patch: Partial<AssistantRequest> = {}): AssistantRequest => ({
  requestId: 'request-a', taskId: 'task-a', status: 'failed', stage: 'failed',
  question: '分析这些主题', context: '', partialContent: '', error: '',
  diagnosticId: 'a'.repeat(32), createdAt: '2026-11-04T00:00:00Z', updatedAt: '2026-11-04T00:00:00Z', ...patch,
})

it('shows the saved request error first and keeps diagnostics in a collapsed disclosure', () => {
  render(<RequestProgressView progress={{ phase: 'failed', job: job({ error: `回答达到输出上限（诊断编号：${'a'.repeat(32)}）` }), message: '备用错误信息' }} />)
  expect(screen.getByRole('alert')).toHaveTextContent('回答达到输出上限')
  expect(screen.queryByText('备用错误信息')).not.toBeInTheDocument()
  expect(screen.getByText('诊断信息').closest('details')).not.toHaveAttribute('open')
  expect(screen.getByRole('alert')).toHaveTextContent('诊断编号：' + 'a'.repeat(32))
  expect(screen.getByRole('alert').querySelector('p')).toHaveTextContent(/^回答达到输出上限$/)
})

it('shows the recovery stage while the retained draft stays available', () => {
  render(<RequestProgressView progress={{ phase: 'processing', job: job({ status: 'running', stage: 'recovering', partialContent: '第一部分正文' }) }} />)
  expect(screen.getByRole('status')).toHaveTextContent('正在继续整理回答…')
  expect(screen.getByText('第一部分正文')).toBeInTheDocument()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

it('keeps the actual failure reason when the request record is unavailable', () => {
  render(<RequestProgressView progress={{ phase: 'failed', requestId: 'request-a', message: '当前账号无权读取这次请求。' }} />)
  expect(screen.getByRole('alert')).toHaveTextContent('当前账号无权读取这次请求。')
  expect(screen.queryByText('本轮提问')).not.toBeInTheDocument()
  expect(screen.queryByText('诊断信息')).not.toBeInTheDocument()
})

it('offers an honest draft recovery action and copies the retained text without submitting an edit', () => {
  const resume = vi.fn(), copy = vi.fn(), edit = vi.fn(), retry = vi.fn()
  render(<RequestProgressView progress={{ phase: 'failed', job: job({ error: '回答达到输出上限', errorCode: 'output_limit', partialContent: '已经写完的第一部分', canContinue: true }) }} onContinue={resume} onCopyDraft={copy} onEditQuestion={edit} onRetry={retry} />)
  expect(screen.getByText('未完成草稿 · 已保留正文，使用前请核对')).toBeInTheDocument()
  expect(screen.getByText('已经写完的第一部分')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '复制未完成草稿' }))
  expect(copy).toHaveBeenCalledWith('已经写完的第一部分')
  fireEvent.click(screen.getByRole('button', { name: '编辑问题' }))
  expect(edit).toHaveBeenCalledOnce()
  expect(retry).not.toHaveBeenCalled()
  expect(resume).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '根据草稿重新整理' }))
  expect(resume).toHaveBeenCalledOnce()
  expect(screen.queryByRole('button', { name: '接着草稿继续' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '导出 Markdown' })).not.toBeInTheDocument()
})

it('distinguishes waiting for the first answer from losing a reply after visible text', () => {
  const { rerender } = render(<RequestProgressView progress={{ phase: 'failed', job: job({ errorCode: 'model_timeout', error: '模型等待超时' }) }} />)
  expect(screen.getByRole('status')).toHaveTextContent('尚未收到回答')
  expect(screen.getByRole('alert')).toHaveTextContent('问题已保留，可以重新生成；无需重新输入。')
  expect(screen.queryByText('未完成草稿 · 已保留正文，使用前请核对')).not.toBeInTheDocument()
  rerender(<RequestProgressView progress={{ phase: 'failed', job: job({ errorCode: 'model_timeout', error: '模型等待超时', partialContent: '已生成的正文', canContinue: true }) }} />)
  expect(screen.getByRole('status')).toHaveTextContent('生成中断，草稿已保存')
  expect(screen.getByRole('alert')).toHaveTextContent('已经收到的正文保留在下方')
  expect(screen.getByText('已生成的正文')).toBeInTheDocument()
})

it('copies request timing and saved text count without copying the question or draft', () => {
  const copy = vi.fn()
  render(<RequestProgressView progress={{ phase: 'failed', job: job({ errorCode: 'model_timeout', question: 'PRIVATE QUESTION', context: 'PRIVATE CONTEXT', partialContent: 'PRIVATE DRAFT', startedAt: '2026-11-04T00:00:01Z', finishedAt: '2026-11-04T00:02:02Z' }) }} onCopyDiagnostic={copy} />)
  fireEvent.click(screen.getByRole('button', { name: '复制诊断信息' }))
  expect(copy).toHaveBeenCalledOnce()
  expect(copy.mock.calls[0][0]).toContain('开始时间：2026-11-04T00:00:01Z')
  expect(copy.mock.calls[0][0]).toContain('结束时间：2026-11-04T00:02:02Z')
  expect(copy.mock.calls[0][0]).toContain('已保存正文：13 字')
  expect(copy.mock.calls[0][0]).not.toContain('PRIVATE')
})

it('does not promise retained input or a retry after a timed out request has expired', () => {
  render(<RequestProgressView progress={{ phase: 'failed', job: job({ errorCode: 'model_timeout', payloadExpired: true, question: '', canContinue: true }) }} onRetry={vi.fn()} onContinue={vi.fn()} />)
  expect(screen.getByRole('alert')).toHaveTextContent('临时输入已清理，请重新输入问题发起新一轮。')
  expect(screen.getByRole('alert')).not.toHaveTextContent('问题已保留')
  expect(screen.queryByRole('button', { name: '重新生成' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '根据草稿重新整理' })).not.toBeInTheDocument()
})
