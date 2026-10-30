import { describe, expect, it } from 'vitest'
import { conversationTopics } from './conversations'
import type { Answer } from './types'

const answer = (id: string, conversationId?: string | null): Answer => ({ id, conversationId, question: `问题 ${id}`, content: '', createdAt: '', mode: 'retrieval', references: [], context: '', scope: '' })
describe('conversation topics', () => {
  it('keeps older ungrouped answers as separate recoverable topics', () => {
    expect(conversationTopics([answer('a'), answer('b', null)]).map(topic => topic.id)).toEqual(['b', 'a'])
  })
  it('groups replies, retains the first question as title, and sorts by the latest turn even for tied timestamps', () => {
    expect(conversationTopics([answer('a', 'topic-1'), answer('b', 'topic-2'), answer('c', 'topic-1')])).toEqual([
      { id: 'topic-1', title: '问题 a', count: 2, updatedAt: '' },
      { id: 'topic-2', title: '问题 b', count: 1, updatedAt: '' },
    ])
  })
  it('continues a legacy topic with its original answer id', () => {
    expect(conversationTopics([answer('legacy'), answer('followup', 'legacy')])).toMatchObject([{ id: 'legacy', title: '问题 legacy', count: 2 }])
  })
})
