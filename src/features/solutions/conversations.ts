import type { Answer } from './types'

export const answerTopic = (answer: Answer) => answer.conversationId || answer.id
export interface ConversationTopic { id: string; title: string; count: number; updatedAt: string }
export interface ConversationDraft { question: string; context: string; showContext: boolean }
export function conversationTopics(answers: Answer[]): ConversationTopic[] {
  const groups = new Map<string, ConversationTopic>()
  const latest = new Map<string, number>()
  for (const [index, answer] of answers.entries()) {
    const id = answerTopic(answer), group = groups.get(id)
    latest.set(id, index)
    if (group) { group.count++; group.updatedAt = answer.createdAt }
    else groups.set(id, { id, title: answer.question.replace(/\s+/g, ' ').trim().slice(0, 80) || '未命名对话', count: 1, updatedAt: answer.createdAt })
  }
  return [...groups.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || latest.get(b.id)! - latest.get(a.id)!)
}
