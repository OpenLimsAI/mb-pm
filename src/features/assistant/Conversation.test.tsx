import { fireEvent, render, screen, within } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import Conversation from './Conversation'
import type { AssistantMessage } from './client'

const message = (id: string, requestId: string, role: AssistantMessage['role'], content: string): AssistantMessage => ({ id, requestId, role, content, context: '', model: '测试模型', mode: 'ai', createdAt: '2026-11-01T12:00:00Z' })

it('keeps each question and its answer in a distinct numbered round with the correct actions', () => {
  const onCopy = vi.fn(), onArtifact = vi.fn()
  render(<Conversation userName="研究员" messages={[
    message('q1', 'request1', 'user', '先整理研究背景'), message('a1', 'request1', 'assistant', '## 第一轮回答\n\n研究背景正文。'),
    message('q2', 'request2', 'user', '再列下一步计划'), message('a2', 'request2', 'assistant', '## 第二轮回答\n\n行动计划正文。'),
  ]} artifacts={[]} onCopy={onCopy} onArtifact={onArtifact} />)
  const first = screen.getByRole('region', { name: '第 1 轮对话' }), second = screen.getByRole('region', { name: '第 2 轮对话' })
  expect(within(first).getByRole('article', { name: '你的提问' })).toHaveTextContent('先整理研究背景')
  expect(within(first).getByRole('article', { name: 'AI 回答' })).toHaveTextContent('研究背景正文。')
  expect(within(first).queryByText('行动计划正文。')).not.toBeInTheDocument()
  expect(within(second).getByRole('article', { name: '你的提问' })).toHaveTextContent('再列下一步计划')
  expect(within(second).getByRole('article', { name: 'AI 回答' })).toHaveTextContent('行动计划正文。')
  fireEvent.click(within(first).getByRole('button', { name: '复制回答' }))
  expect(onCopy).toHaveBeenCalledWith('## 第一轮回答\n\n研究背景正文。')
  fireEvent.click(within(second).getByRole('button', { name: '查看产物' }))
  expect(onArtifact).toHaveBeenCalledWith('a2')
})

it('preserves unmatched history without pairing an answer with a different question', () => {
  render(<Conversation userName="研究员" messages={[
    message('q1', 'request1', 'user', '历史提问'), message('a2', 'request2', 'assistant', '另一轮的独立回答'),
  ]} artifacts={[]} onCopy={() => {}} onArtifact={() => {}} />)
  expect(screen.getAllByRole('region')).toHaveLength(2)
  expect(within(screen.getByRole('region', { name: '第 1 轮对话' })).queryByText('另一轮的独立回答')).not.toBeInTheDocument()
  expect(within(screen.getByRole('region', { name: '第 2 轮对话' })).getByText('另一轮的独立回答')).toBeInTheDocument()
})

it('offers the personal-assistant reference category for a saved message in its own task', () => {
  render(<Conversation taskId="task-own" userName="研究员" messages={[{...message('a-web','request-web','assistant','公开研究结果'),answerMode:'web',webReferences:[{id:'source-web',title:'原始论文',url:'https://example.org/paper',publishedAt:null,retrievedAt:'',excerpt:''}]}]} artifacts={[]} onCopy={()=>{}} onArtifact={()=>{}} />)
  fireEvent.click(screen.getByRole('button',{name:'导入知识源'}))
  expect(within(screen.getByRole('dialog')).getByText('个人AI助手参考论文')).toBeInTheDocument()
  expect(within(screen.getByRole('dialog')).getByRole('link',{name:'https://example.org/paper'})).toHaveAttribute('href','https://example.org/paper')
})
