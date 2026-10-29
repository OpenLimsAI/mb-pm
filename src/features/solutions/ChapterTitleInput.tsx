import { useRef, useState } from 'react'

export default function ChapterTitleInput({ title, onChange, compact = false }: { title: string; onChange: (title: string) => void; compact?: boolean }) {
  const [draft, setDraft] = useState({ base: title, value: title })
  const cancelBlur = useRef(false)
  const value = draft.base === title ? draft.value : title
  function commit() {
    if (cancelBlur.current) { cancelBlur.current = false; return }
    const next = value.trim() || title
    setDraft({ base: next, value: next })
    if (next !== title) onChange(next)
  }
  return <input aria-label="章节标题" className={compact ? 'ks-focus-chapter-title' : 'ks-section-title-input'} value={value} maxLength={200} placeholder="输入章节标题" title="直接修改章节标题，离开输入框后保存" onChange={event => setDraft({ base: title, value: event.target.value })} onBlur={commit} onKeyDown={event => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() }
    if (event.key === 'Escape') { event.preventDefault(); cancelBlur.current = true; setDraft({ base: title, value: title }); event.currentTarget.blur() }
  }} />
}
