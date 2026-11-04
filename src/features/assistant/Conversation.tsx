import type { AnswerMode } from '../answerModes/types'
import { AnswerEvidence } from '../answerModes/AnswerTools'
import { Copy, PanelRightOpen, Paperclip, Sparkles } from 'lucide-react'
import type { AssistantArtifact, AssistantMessage } from './client'
import MarkdownView from './MarkdownView'
import KnowledgeSources from './KnowledgeSources'

interface Props {
  taskId?: string
  messages: AssistantMessage[]
  artifacts: AssistantArtifact[]
  userName: string
  onCopy: (content: string) => void
  onArtifact: (id: string) => void
  onSource?: (path: string, offset?: number) => void
  onRemember?: (answer: AssistantMessage, turn: number) => void
  onReask?: (question: string, context: string, mode: AnswerMode) => void
  busy?: boolean
}

// Pair only the answer belonging to the preceding question. Preserve unmatched
// legacy messages in their own round instead of attaching them to another ask.
function conversationTurns(messages: AssistantMessage[]) {
  const turns: AssistantMessage[][] = []
  for (const message of messages) {
    const previous = turns.at(-1)
    if (message.role === 'assistant' && previous?.length === 1 && previous[0].role === 'user' && previous[0].requestId === message.requestId) previous.push(message)
    else turns.push([message])
  }
  return turns
}

const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })
export default function Conversation({ taskId, messages, artifacts, userName, onCopy, onArtifact, onSource, onRemember, onReask, busy }: Props) {
  return <div className="aa-turn-list">{conversationTurns(messages).map((turn, index) => {
    const started = new Date(turn[0].createdAt)
    return <section key={turn[0].id} className="aa-turn" aria-label={`第 ${index + 1} 轮对话`}>
      <div className="aa-turn-header"><strong className="aa-turn-number">第 {index + 1} 轮</strong>{Number.isFinite(started.getTime()) && <time dateTime={turn[0].createdAt}>{dateFormat.format(started)}</time>}</div>
      {turn.map(message => message.role === 'user' ? <article key={message.id} className="aa-message aa-user-message" aria-label="你的提问">
        <div className="aa-message-overline"><span className="aa-mini-avatar">{Array.from(userName || '我')[0]}</span><strong>你的提问</strong></div>
        <div className="aa-question-text">{message.content}</div>
        {message.baseArtifactId && <button type="button" className="aa-lineage" onClick={() => onArtifact(message.baseArtifactId!)}>基于原稿：{artifacts.find(artifact => artifact.id === message.baseArtifactId)?.title || '查看原稿'}</button>}
        {message.context && <details className="aa-context-details"><summary><Paperclip size={12} />本轮附带资料 · {message.context.length.toLocaleString()} 字</summary><pre>{message.context}</pre></details>}
      </article> : <article key={message.id} className="aa-message aa-assistant-message" aria-label="AI 回答">
        <div className="aa-message-overline"><span className="aa-mini-avatar aa-bot-avatar"><Sparkles size={14} /></span><strong>AI 回答</strong><span>{message.mode === 'preview' ? '演示' : message.model}</span></div>
        <AnswerEvidence answer={message} preview={message.mode === 'preview'} part="status" showSourceScope /><MarkdownView>{message.content}</MarkdownView><AnswerEvidence answer={message} preview={message.mode === 'preview'} part="sources" referenceOrigin={taskId ? { originApp: 'assistant', originId: taskId, answerId: message.id } : undefined} />
        {message.sourceSummary && (message.sourceSummary.materialCount != null || message.usedSources?.includes('knowledge') || !!message.knowledgeReferences?.length) && <p className="aa-source-summary">{message.sourceSummary.materialCount != null ? `知识库共 ${message.sourceSummary.materialCount} 份资料（含论文及其他文档） · ` : ''}本轮目录返回 {message.sourceSummary.cataloguedCount || 0} 项 · 检索命中 {message.sourceSummary.retrievedCount || 0} 份 · 阅读 {message.sourceSummary.readCount || 0} 份 · 回答提及来源 {message.sourceSummary.citedCount || 0} 份{message.sourceSummary.truncated ? ' · 来源列表已截取，并非完整清单' : ''}</p>}
        {!!message.knowledgeReferences?.length && <KnowledgeSources sources={message.knowledgeReferences} onSource={onSource} />}
        <div className="aa-message-actions"><button type="button" onClick={() => onCopy(message.content)}><Copy size={13} />复制回答</button><button type="button" onClick={() => onArtifact(message.id)}><PanelRightOpen size={13} />查看产物</button>{onRemember && <button type="button" disabled={busy} onClick={() => onRemember(message, index + 1)}>记入任务记忆</button>}</div>
        {onReask && turn[0].role === 'user' && <details className="aa-reask"><summary>换个范围重新回答</summary><p>重新回答会生成新一轮，原回答仍保留。</p>{([{ mode: 'general', label: '通用回答' }, { mode: 'knowledge', label: '仅知识库' }, { mode: 'web', label: '联网检索' }] as const).map(option => <button type="button" className="aa-button" key={option.mode} disabled={busy} onClick={() => onReask(turn[0].content, turn[0].context, option.mode)}>改用{option.label}重新回答</button>)}</details>}
      </article>)}
    </section>
  })}</div>
}
