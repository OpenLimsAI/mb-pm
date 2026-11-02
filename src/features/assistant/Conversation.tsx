import { AnswerEvidence } from '../answerModes/AnswerTools'
import { ArrowRight, Copy, FileText, PanelRightOpen, Paperclip, Sparkles } from 'lucide-react'
import type { AssistantArtifact, AssistantMessage } from './client'
import MarkdownView from './MarkdownView'

interface Props {
  messages: AssistantMessage[]
  artifacts: AssistantArtifact[]
  userName: string
  onCopy: (content: string) => void
  onArtifact: (id: string) => void
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
export default function Conversation({ messages, artifacts, userName, onCopy, onArtifact }: Props) {
  return <div className="aa-turn-list">{conversationTurns(messages).map((turn, index) => {
    const started = new Date(turn[0].createdAt)
    return <section key={turn[0].id} className="aa-turn" aria-label={`第 ${index + 1} 轮对话`}>
      <div className="aa-turn-header"><strong className="aa-turn-number">第 {index + 1} 轮</strong>{Number.isFinite(started.getTime()) && <time dateTime={turn[0].createdAt}>{dateFormat.format(started)}</time>}</div>
      {turn.map(message => message.role === 'user' ? <article key={message.id} className="aa-message aa-user-message" aria-label="你的提问">
        <div className="aa-message-overline"><span className="aa-mini-avatar">{Array.from(userName || '我')[0]}</span><strong>你的提问</strong></div>
        <div className="aa-question-text">{message.content}</div>
        {message.context && <details className="aa-context-details"><summary><Paperclip size={12} />本轮附带资料 · {message.context.length.toLocaleString()} 字</summary><pre>{message.context}</pre></details>}
      </article> : <article key={message.id} className="aa-message aa-assistant-message" aria-label="AI 回答">
        <div className="aa-message-overline"><span className="aa-mini-avatar aa-bot-avatar"><Sparkles size={14} /></span><strong>AI 回答</strong><span>{message.mode === 'preview' ? '演示' : message.model}</span></div>
        <AnswerEvidence answer={message} preview={message.mode === 'preview'} part="status" showSourceScope /><MarkdownView>{message.content}</MarkdownView><AnswerEvidence answer={message} preview={message.mode === 'preview'} part="sources" />
        <button type="button" className="aa-artifact-card" onClick={() => onArtifact(message.id)}><span><FileText size={19} /></span><div><strong>{artifacts.find(a => a.id === message.id)?.title || '本轮产物'}</strong><small>查看完整内容 · Markdown</small></div><ArrowRight size={16} /></button>
        <div className="aa-message-actions"><button type="button" onClick={() => onCopy(message.content)}><Copy size={13} />复制回答</button><button type="button" onClick={() => onArtifact(message.id)}><PanelRightOpen size={13} />查看产物</button></div>
      </article>)}
    </section>
  })}</div>
}
