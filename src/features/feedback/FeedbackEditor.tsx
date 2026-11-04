import { useEffect, useRef, useState, type FormEvent } from 'react'
import { AlertCircle, ImagePlus, X } from 'lucide-react'
import { applicationLabels, emptyStructure, feedbackClient, imageUrl, structureKeys, structureLabels, type Category, type FeedbackItem, type FeedbackStructure } from './shared'

type Props = { item: FeedbackItem; preview: boolean; onSaved: (item: FeedbackItem) => void; onClose: () => void; onError: (error: unknown) => string }
export default function FeedbackEditor({ item, preview, onSaved, onClose, onError }: Props) {
  const [description, setDescription] = useState(item.description)
  const [application, setApplication] = useState(item.application || '')
  const [category, setCategory] = useState<Category>(item.category)
  const [structure, setStructure] = useState<FeedbackStructure>({ ...emptyStructure, ...Object.fromEntries(Object.keys(emptyStructure).map(key => [key, item[key as keyof FeedbackStructure] || ''])) })
  const [kept, setKept] = useState(item.images)
  const [added, setAdded] = useState<{ file: File; url: string }[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const urls = useRef(new Set<string>())
  const lock = useRef(false)
  const dialog = useRef<HTMLDivElement>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  const continueEditing = useRef<HTMLButtonElement>(null)
  const dirty = description !== item.description || application !== (item.application || '') || category !== item.category || kept.length !== item.images.length || added.length > 0 || Object.keys(structure).some(key => structure[key as keyof FeedbackStructure] !== (item[key as keyof FeedbackStructure] || ''))
  useEffect(() => { const active = urls.current; return () => { active.forEach(url => URL.revokeObjectURL(url)); active.clear() } }, [])
  useEffect(() => { if (confirmDiscard) continueEditing.current?.focus(); else field.current?.focus() }, [confirmDiscard])
  const close = () => { if (lock.current) return; if (dirty) setConfirmDiscard(true); else onClose() }
  const addFiles = (files: File[]) => {
    if (!files.length || lock.current) return
    if (kept.length + added.length + files.length > 3) { setError('最多保留 3 张图片。'); return }
    if (files.some(file => !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024)) { setError('图片须为 PNG、JPEG 或 WebP，每张不超过 5 MB。'); return }
    setAdded(current => [...current, ...files.map(file => { const url = URL.createObjectURL(file); urls.current.add(url); return { file, url } })]); setError('')
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (lock.current || !dirty) return
    if (!description.trim() || !Object.hasOwn(applicationLabels, application)) { setError('请填写问题说明并选择所属应用。'); return }
    lock.current = true; setBusy(true); setError('')
    try {
      let updated: FeedbackItem
      if (preview) { updated = { ...item, description: description.trim(), application, category, images: [...kept, ...added.map(x => x.url)], ...structure }; added.forEach(x => urls.current.delete(x.url)) }
      else {
        const data = new FormData(); data.append('description', description.trim()); data.append('application', application); data.append('category', category); data.append('keep_images', JSON.stringify(kept))
        if (item.revision !== undefined) data.append('expected_revision', String(item.revision))
        for (const key of Object.keys(emptyStructure) as (keyof FeedbackStructure)[]) data.append(key, structureKeys(category).includes(key) ? structure[key].trim() : '')
        added.forEach(x => data.append('images', x.file, x.file.name))
        updated = (await feedbackClient.patch<FeedbackItem>(`/${item.id}/content-with-images`, data)).data
      }
      onSaved(updated)
    } catch (err) { setError(onError(err)) }
    finally { lock.current = false; setBusy(false) }
  }
  return <div className="feedback-modal-backdrop feedback-editor-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close() }}>
    <div className="feedback-dialog" role="dialog" aria-modal="true" aria-labelledby="feedback-edit-title" ref={dialog} onKeyDown={event => {
      event.stopPropagation()
      if (event.key === 'Escape') { event.preventDefault(); if (confirmDiscard) setConfirmDiscard(false); else close() }
      if (event.key !== 'Tab') return
      const nodes = dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled])'); if (!nodes?.length) return
      if (event.shiftKey && document.activeElement === nodes[0]) { event.preventDefault(); nodes[nodes.length - 1].focus() } else if (!event.shiftKey && document.activeElement === nodes[nodes.length - 1]) { event.preventDefault(); nodes[0].focus() }
    }}>
      {confirmDiscard ? <div className="feedback-discard"><h2 id="feedback-edit-title">放弃未保存的修改？</h2><p>修改还没有保存，原反馈不受影响。</p><div className="feedback-dialog-actions"><button ref={continueEditing} type="button" className="feedback-outline-button" onClick={() => setConfirmDiscard(false)}>继续编辑</button><button type="button" className="feedback-danger-button" onClick={onClose}>放弃并关闭</button></div></div> : <><header className="feedback-dialog-header"><div><h2 id="feedback-edit-title">编辑原反馈</h2><p>保存后会保留原文和原图的编辑记录。</p></div><button type="button" className="feedback-icon-button" aria-label="关闭编辑" disabled={busy} onClick={close}><X size={20} /></button></header><form className="feedback-dialog-form" onSubmit={event => void submit(event)} onPaste={event => { const images = Array.from(event.clipboardData.items).filter(x => x.kind === 'file' && x.type.startsWith('image/')).map(x => x.getAsFile()).filter((x): x is File => !!x); if (images.length) { event.preventDefault(); addFiles(images) } }}>
        <div className="feedback-application-field"><label htmlFor="feedback-edit-application">所属应用</label><select id="feedback-edit-application" required disabled={busy} value={application} onChange={event => setApplication(event.target.value)}><option value="">请选择所属应用</option>{Object.entries(applicationLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></div>
        <label className="feedback-edit-category">反馈分类<select aria-label="编辑反馈分类" value={category} disabled={busy} onChange={event => setCategory(event.target.value as Category)}><option value="bug">Bug 问题</option><option value="feature">新功能建议</option></select></label>
        <div className="feedback-field"><label htmlFor="feedback-edit-description">问题或建议</label><textarea id="feedback-edit-description" ref={field} required maxLength={5000} rows={5} disabled={busy} value={description} onChange={event => setDescription(event.target.value)} /></div>
        <fieldset className="feedback-structured"><legend>补充信息</legend>{structureKeys(category).map(key => <label key={key}>{structureLabels[key]}<textarea aria-label={structureLabels[key]} rows={2} maxLength={2000} disabled={busy} value={structure[key]} onChange={event => setStructure(current => ({ ...current, [key]: event.target.value }))} /></label>)}</fieldset>
        <div className="feedback-attachment-grid">{kept.map((id, index) => <div className="feedback-attachment" key={id}><img src={imageUrl(id)} alt={`原图片 ${index + 1}`} /><button type="button" disabled={busy} aria-label={`移除原图片 ${index + 1}`} onClick={() => setKept(current => current.filter(x => x !== id))}><X size={15} /></button></div>)}{added.map(x => <div className="feedback-attachment" key={x.url}><img src={x.url} alt={`已添加图片 ${x.file.name}`} /><button type="button" disabled={busy} aria-label={`移除图片 ${x.file.name}`} onClick={() => { URL.revokeObjectURL(x.url); urls.current.delete(x.url); setAdded(current => current.filter(y => y.url !== x.url)) }}><X size={15} /></button></div>)}{kept.length + added.length < 3 && <label className="feedback-upload"><ImagePlus size={19} /><span>添加图片</span><input type="file" multiple aria-label="添加图片" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={event => { addFiles(Array.from(event.target.files || [])); event.target.value = '' }} /></label>}</div>
        {error && <p className="feedback-history-error" role="alert"><AlertCircle size={14} />{error}</p>}<div className="feedback-dialog-actions"><button type="button" className="feedback-outline-button" disabled={busy} onClick={close}>取消</button><button type="submit" className="feedback-create" disabled={busy || !dirty}>{busy ? '正在保存…' : '保存修改'}</button></div>
      </form></>}
    </div>
  </div>
}
