import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, FileText, Search, X } from 'lucide-react'
import type { AssistantArtifact, AssistantMessage } from './client'
import './artifactNavigator.css'

interface Props {
  artifacts: AssistantArtifact[]
  messages: AssistantMessage[]
  activeId?: string
  finalArtifactId?: string | null
  onSelect: (id: string) => void
}

const dateFormat = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

// Match Conversation's request pairing, including unmatched legacy messages.
function answerRounds(messages: AssistantMessage[]) {
  const rounds = new Map<string, number>()
  let round = 0
  let previous: AssistantMessage | undefined
  for (const message of messages) {
    if (!(message.role === 'assistant' && previous?.role === 'user' && previous.requestId === message.requestId)) round++
    if (message.role === 'assistant') rounds.set(message.id, round)
    previous = message
  }
  return rounds
}

export default function ArtifactNavigator({ artifacts, messages, activeId, finalArtifactId, onSelect }: Props) {
  const [filter, setFilter] = useState({ query: '', activeId })
  const setQuery = (query: string) => setFilter({ query, activeId })
  let query = filter.query
  if (filter.activeId !== activeId) {
    const current = artifacts.find(artifact => artifact.id === activeId)
    // A "view artifact" link in the conversation must reveal its target. Keep
    // the user's filter when they select another card already in these results.
    if (query.trim() && current && !`${current.title} ${current.model}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) query = ''
    setFilter({ query, activeId })
  }
  const list = useRef<HTMLUListElement>(null)
  const buttons = useRef(new Map<string, HTMLButtonElement>())
  const rounds = useMemo(() => answerRounds(messages), [messages])
  const search = query.trim().toLocaleLowerCase()
  const items = artifacts.map((artifact, index) => ({ artifact, number: index + 1, round: rounds.get(artifact.id) }))
    .filter(({ artifact }) => !search || `${artifact.title} ${artifact.model}`.toLocaleLowerCase().includes(search)).reverse()

  useEffect(() => {
    const container = list.current, selected = activeId ? buttons.current.get(activeId) : undefined
    if (!container || !selected) return
    // Reveal the selected card without scrolling the conversation or document.
    const outer = container.getBoundingClientRect(), inner = selected.getBoundingClientRect()
    if (inner.top < outer.top) container.scrollTop -= outer.top - inner.top
    else if (inner.bottom > outer.bottom) container.scrollTop += inner.bottom - outer.bottom
  }, [activeId, query])

  if (!artifacts.length) return null
  return <nav className="aa-artifact-nav" aria-label="产物列表">
    <div className="aa-artifact-nav-heading"><h3>全部产物 <span>{artifacts.length}</span></h3><small>最新在前 · 点击查看</small></div>
    {artifacts.length > 4 && <div className="aa-artifact-search"><Search size={14} aria-hidden="true" /><input type="search" aria-label="查找产物" placeholder="按标题或模型查找" value={query} onChange={event => setQuery(event.target.value)} />{query && <button type="button" aria-label="清除产物搜索" onClick={() => setQuery('')}><X size={14} /></button>}</div>}
    {items.length ? <ul className="aa-artifact-options" ref={list}>{items.map(({ artifact, number, round }) => {
      const selected = artifact.id === activeId, created = new Date(artifact.createdAt)
      const label = round ? `第 ${round} 轮` : `产物 ${number}`
      return <li key={artifact.id}><button type="button" className="aa-artifact-option" aria-label={`查看产物：${artifact.title}（${label}）`} aria-pressed={selected} title={artifact.title}
        ref={element => { if (element) buttons.current.set(artifact.id, element); else buttons.current.delete(artifact.id) }}
        onClick={() => onSelect(artifact.id)}>
        <span className="aa-artifact-option-top"><span><FileText size={13} aria-hidden="true" />{label}</span>{finalArtifactId === artifact.id && <strong>最终成果</strong>}{selected && <Check size={14} aria-label="正在查看" />}</span>
        <span className="aa-artifact-option-title">{artifact.title}</span>
        <span className="aa-artifact-option-meta"><span title={artifact.model}>{artifact.model || '模型未记录'}</span>{Number.isFinite(created.getTime()) && <time dateTime={artifact.createdAt}>{dateFormat.format(created)}</time>}</span>
      </button></li>
    })}</ul> : <p className="aa-artifact-no-match" role="status">没有匹配的产物，请更换关键词。</p>}
    {search && <small className="aa-artifact-search-count" role="status">找到 {items.length} / {artifacts.length} 份产物</small>}
  </nav>
}
