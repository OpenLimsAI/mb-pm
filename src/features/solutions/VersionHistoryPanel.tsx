import { useState } from 'react'
import { History, Save } from 'lucide-react'
import type { Solution, Version } from './types'
import { revisionDiff } from './revisionDiff'
import './versionHistory.css'

export default function VersionHistoryPanel({ doc, versions, busy, onSnapshot, onRestoreSection, onRestoreReport }: {
  doc: Solution; versions: Version[]; busy: boolean
  onSnapshot: (name: string) => Promise<void>
  onRestoreSection: (versionId: string, sectionId: string) => Promise<void>
  onRestoreReport: (version: Version) => Promise<void>
}) {
  const [chosen, setChosen] = useState<string | null>(null), [name, setName] = useState(''), [error, setError] = useState('')
  const [pending, setPending] = useState(false), [restore, setRestore] = useState<{ version: Version; sectionId?: string } | null>(null)
  const selected = versions.find(version => version.id === chosen) || versions[0]
  const disabled = busy || pending, editable = doc.canEdit && doc.status === 'draft'
  async function perform(action: () => Promise<void>) {
    setError(''); setPending(true)
    try { await action(); setRestore(null) } catch (reason) { setError(reason instanceof Error ? reason.message : '版本操作失败，请重试。') } finally { setPending(false) }
  }
  return <div className="ks-history-panel">
    {editable && <form className="ks-history-create" onSubmit={event => { event.preventDefault(); void perform(async () => { await onSnapshot(name.trim()); setName('') }) }}>
      <label>版本名称<input aria-label="版本名称" value={name} onChange={event => setName(event.target.value)} maxLength={200} placeholder="例如：完成实验依据整理" disabled={disabled} /></label>
      <button type="submit" className="ks-button ks-primary" disabled={disabled || !name.trim()}><Save size={15} />保存当前版本</button>
    </form>}
    <p className="ks-muted">自动快照保留修改前的内容；手动版本记录当前内容。下方对比以历史版本为基准，绿色为当前新增，红色为当前删除。</p>
    {error && <p role="alert" className="ks-error-inline">{error}</p>}
    {!versions.length ? <p className="ks-empty-small">暂无历史版本，可以先保存一个命名版本。</p> : <div className="ks-history-grid">
      <nav aria-label="选择历史版本">{versions.map(version => <button type="button" key={version.id} className={`ks-history-item${selected?.id === version.id ? ' is-active' : ''}`} aria-pressed={selected?.id === version.id} onClick={() => setChosen(version.id)}><strong>{version.note || `版本 ${version.version}`}</strong><span>{new Date(version.createdAt).toLocaleString('zh-CN')} · {version.actorName}</span></button>)}</nav>
      {selected && <div className="ks-history-diff"><h3>{selected.snapshot.title}</h3>{selected.snapshot.title !== doc.title && <p>当前标题：{doc.title}</p>}
        {Array.from(new Set([...selected.snapshot.sections.map(section => section.id), ...doc.sections.map(section => section.id)])).map(id => {
          const previous = selected.snapshot.sections.find(section => section.id === id), current = doc.sections.find(section => section.id === id)
          const changed = previous?.content !== current?.content || previous?.title !== current?.title
          return <section key={id}><div className="ks-history-section-head"><h4>{current?.title || previous?.title} <small>{!previous ? '新增章节' : !current ? '已删除章节' : changed ? '有修改' : '无修改'}</small></h4>
            {editable && previous && <button type="button" className="ks-button" disabled={disabled} onClick={() => setRestore({ version: selected, sectionId: id })}>恢复此章节</button>}</div>
            {previous && current && previous.title !== current.title && <p className="ks-muted">原标题：{previous.title}</p>}
            <pre className="ks-line-diff">{revisionDiff(previous?.content || '', current?.content || '').map((line, index) => <span className={`ks-diff-${line.kind}`} key={index}><b aria-hidden="true">{line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}</b>{line.text || ' '}{'\n'}</span>)}</pre>
          </section>
        })}
        {editable && <button type="button" className="ks-button" disabled={disabled} onClick={() => setRestore({ version: selected })}><History size={15} />恢复整份历史报告</button>}
      </div>}
    </div>}
    {restore && <div className="ks-history-confirm" role="alertdialog" aria-label="确认恢复历史内容"><p>{restore.sectionId ? '将恢复这一章节及其引用，其他章节保留当前内容。' : '将整份报告恢复为所选历史内容。当前版本会保留为快照。'}</p><div><button type="button" className="ks-button" disabled={disabled} onClick={() => setRestore(null)}>取消</button><button type="button" className="ks-button ks-primary" disabled={disabled} onClick={() => void perform(() => restore.sectionId ? onRestoreSection(restore.version.id, restore.sectionId) : onRestoreReport(restore.version))}>确认恢复</button></div></div>}
  </div>
}
