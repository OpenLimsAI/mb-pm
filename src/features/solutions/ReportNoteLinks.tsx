import { useEffect, useState } from 'react'
import type { NotesClient, PersonalNote } from '../notes/client'
import type { ReportNoteLink, Solution, SolutionClient } from './types'
import { revisionDiff } from './revisionDiff'
import './reportCollaboration.css'

export function reportNoteReferences(doc: Solution) {
  return doc.sections.flatMap(section => Array.from(section.content.matchAll(/\]\(\/notes\?note=([^\s)]+)\)/g)).flatMap(match => {
    try { return [{ noteId: decodeURIComponent(match[1]), sectionId: section.id }] } catch { return [] }
  }))
}
export default function ReportNoteLinks({ doc, client, notesClient, onReplace }: {
  doc: Solution; client: SolutionClient; notesClient: NotesClient
  onReplace: (sectionId: string, before: string, after: string) => boolean
}) {
  const [links, setLinks] = useState<{ saved: ReportNoteLink; current: PersonalNote | null }[]>([]), [error, setError] = useState(''), [selected, setSelected] = useState<string | null>(null), [busy, setBusy] = useState(false), [retry, setRetry] = useState(0)
  // Refresh after a report change; no note body is shared with other collaborators.
  useEffect(() => {
    if (!client.noteLinks || !client.linkNote || !notesClient.get) return
    let active = true
    async function load() {
      const saved = await client.noteLinks!(doc.id), references = reportNoteReferences(doc)
      const unique = references.filter((ref, i) => references.findIndex(r => r.noteId === ref.noteId && r.sectionId === ref.sectionId) === i).slice(0, 100)
      const result = await Promise.all(unique.map(async ref => {
        let current: PersonalNote | null = null
        try { current = await notesClient.get!(ref.noteId) } catch { /* Deleted or unowned note keeps the immutable report content. */ }
        let link = saved.find(s => s.noteId === ref.noteId && s.sectionId === ref.sectionId)
        if (!link && current) {
          // Only bind existing copies whose exact note text is present in the report.
          if (!doc.sections.find(s => s.id === ref.sectionId)?.content.includes(current.content)) return null
          link = await client.linkNote!(doc.id, ref.noteId, ref.sectionId)
        }
        return link ? { saved: link, current } : null
      }))
      if (active) { setLinks(result.filter((r): r is NonNullable<typeof r> => !!r)); setError('') }
    }
    void load().catch(reason => { if (active) setError(reason instanceof Error ? reason.message : '笔记来源检查失败') })
    return () => { active = false }
  }, [doc.id, doc.revision, doc.sections, client, notesClient, retry])
  const changed = links.filter(link => !link.current || link.current.revision !== link.saved.noteRevision)
  if (!links.length && !error) return null
  return <section className="ks-report-note-links" aria-label="关联笔记"><h4>关联笔记 <small>{links.length}</small></h4>{error && <p role="alert">{error}<button className="ks-button" onClick={() => setRetry(n => n + 1)}>重试</button></p>}{links.map(({ saved, current }) => <article key={saved.id}><a href={`/notes?note=${encodeURIComponent(saved.noteId)}`}>{saved.noteTitle}</a><span>{!current ? '原笔记不可用，报告保留已插入内容' : current.revision !== saved.noteRevision ? '笔记有更新' : '与笔记版本一致'}</span>{changed.some(link => link.saved.id === saved.id) && current && <button className="ks-button" onClick={() => setSelected(selected === saved.id ? null : saved.id)}>查看差异</button>}{selected === saved.id && current && <div><pre className="ks-line-diff">{revisionDiff(saved.content, current.content).map((line, i) => <span className={`ks-diff-${line.kind}`} key={i}>{line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}{line.text}{'\n'}</span>)}</pre><button className="ks-button ks-primary" disabled={busy || !doc.canEdit} onClick={() => { if (!onReplace(saved.sectionId, saved.content, current.content)) { setError('原笔记内容已在报告中修改，请手动比较，避免覆盖报告的后续编辑。'); return } setBusy(true); void client.linkNote!(doc.id, saved.noteId, saved.sectionId).then(() => { setSelected(null); setRetry(n => n + 1) }).catch(reason => setError(reason instanceof Error ? reason.message : '关联更新失败')).finally(() => setBusy(false)) }}>确认更新报告中的笔记内容</button></div>}</article>)}</section>
}
