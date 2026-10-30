import { MessageSquare, Plus } from 'lucide-react'
import type { ConversationTopic } from './conversations'

export default function ConversationToolbar({ topics, activeId, onSelect, onNew }: {
  topics: ConversationTopic[]; activeId: string; onSelect: (id: string) => void; onNew: () => void
}) {
  return <div className="ks-conversation-toolbar" role="group" aria-label="对话主题管理">
    <label><MessageSquare size={14} /><span>对话主题</span><select aria-label="对话主题" value={activeId} onChange={event => onSelect(event.target.value)}>
      {topics.map(topic => <option key={topic.id} value={topic.id}>{topic.title} · {topic.count ? `${topic.count} 轮` : '草稿'}</option>)}
    </select></label>
    <button className="ks-button ks-new-conversation" type="button" onClick={onNew}><Plus size={14} />新建对话</button>
  </div>
}
