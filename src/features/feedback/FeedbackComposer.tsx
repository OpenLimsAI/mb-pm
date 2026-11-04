import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { AlertCircle, ArrowUpRight, Bug, CheckCircle2, ChevronRight, ImagePlus, Lightbulb, Search, ShieldCheck, X } from 'lucide-react'
import ScreenCaptureEditor from './ScreenCaptureEditor'
import { saveDraft } from './drafts'
import { useFeedbackDraft } from './useFeedbackDraft'
import { applicationLabel, applicationLabels, emptyStructure, feedbackClient, issueLabel, issuePath, structureKeys, structureLabels, type Category, type FeedbackItem, type FeedbackSource, type FeedbackStructure } from './shared'

type Attachment = { file: File; url: string }
type ComposerDraft = { application: string; category: Category; description: string; structure: FeedbackStructure; source: FeedbackSource; request?: { fingerprint: string; id: string } | null }
type Props = { preview: boolean; userName: string; namespace?: string; source: FeedbackSource; onCreated: (item: FeedbackItem, blobUrls: string[]) => void; onClose: () => void; onError: (error: unknown) => string }
export default function FeedbackComposer({ preview, userName, namespace, source, onCreated, onClose, onError }: Props) {
  const [initialApplication] = useState(source.application || '')
  const [application, setApplication] = useState<string>(source.application || '')
  const [category, setCategory] = useState<Category>('bug')
  const [description, setDescription] = useState('')
  const [structure, setStructure] = useState<FeedbackStructure>({ ...emptyStructure })
  const [context, setContext] = useState(source)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [error, setError] = useState('')
  const [attachmentError, setAttachmentError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [similar, setSimilar] = useState<(FeedbackItem & { similarity_score?: number })[] | null>(null)
  const [similarError, setSimilarError] = useState('')
  const [searchingFor, setSearchingFor] = useState<string | null>(null)
  const similarRun = useRef(0)
  const signature = JSON.stringify({ description: description.trim(), application })
  const searching = searchingFor === signature
  const dialog = useRef<HTMLDivElement>(null)
  const descriptionField = useRef<HTMLTextAreaElement>(null)
  const applicationField = useRef<HTMLSelectElement>(null)
  const continueEditing = useRef<HTMLButtonElement>(null)
  const urls = useRef(new Set<string>())
  const busy = useRef(false)
  const request = useRef<{ fingerprint: string; id: string } | null>(null)
  const [requestState, setRequestState] = useState<typeof request.current>(null)
  const files = useMemo(() => attachments.map(item => item.file), [attachments])
  const dirty = !!description.trim() || application !== initialApplication || category !== 'bug' || !!attachments.length || Object.values(structure).some(Boolean)
  const addImages = (selected: File[]) => {
    if (!selected.length || busy.current) return
    if (attachments.length + selected.length > 3) { setAttachmentError('最多上传 3 张图片，请先移除多余的图片。'); return }
    if (selected.some(file => !['image/png', 'image/jpeg', 'image/webp'].includes(file.type))) { setAttachmentError('仅支持 PNG、JPEG 或 WebP 图片。'); return }
    if (selected.some(file => file.size > 5 * 1024 * 1024)) { setAttachmentError('每张图片不能超过 5 MB。'); return }
    request.current = null; setRequestState(null)
    setAttachments(current => [...current, ...selected.map(file => { const url = URL.createObjectURL(file); urls.current.add(url); return { file, url } })]); setAttachmentError('')
  }
  const draft = useFeedbackDraft<ComposerDraft>(namespace, 'compose', JSON.stringify({ application, category, description, structure, source: context, request: requestState }), files, dirty, saved => {
    const value = saved.value
    similarRun.current += 1; setSearchingFor(null); setSimilar(null)
    request.current = value.request || null; setRequestState(value.request || null)
    setApplication(typeof value.application === 'string' ? value.application : '')
    setCategory(value.category === 'feature' ? 'feature' : 'bug'); setDescription(typeof value.description === 'string' ? value.description : '')
    setStructure({ ...emptyStructure, ...value.structure }); setContext(value.source || source)
    urls.current.forEach(url => URL.revokeObjectURL(url)); urls.current.clear()
    setAttachments(saved.files.slice(0, 3).map(file => { const url = URL.createObjectURL(file); urls.current.add(url); return { file, url } }))
  })
  useEffect(() => { const active = urls.current; return () => { active.forEach(url => URL.revokeObjectURL(url)); active.clear() } }, [])
  useEffect(() => { if (confirmDiscard) continueEditing.current?.focus(); else descriptionField.current?.focus() }, [confirmDiscard])
  const close = () => { if (busy.current) return; if (dirty) setConfirmDiscard(true); else onClose() }
  useEffect(() => {
    if (preview || description.trim().length < 12) return
    let active = true
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      const run = ++similarRun.current
      setSearchingFor(signature); setSimilarError('')
      feedbackClient.post<{ items: FeedbackItem[] }>('/similar', { description: description.trim(), ...(application ? { application } : {}) }, { signal: controller.signal })
        .then(({ data }) => { if (active && run === similarRun.current) setSimilar(data.items) })
        .catch(err => { if (active && run === similarRun.current && !controller.signal.aborted) setSimilarError(onError(err)) })
        .finally(() => { if (active && run === similarRun.current) setSearchingFor(null) })
    }, 650)
    return () => { active = false; controller.abort(); window.clearTimeout(timer) }
  }, [description, application, preview, onError, signature])
  const findSimilar = async () => {
    if (searching || !description.trim()) return
    const run = ++similarRun.current
    setSearchingFor(signature); setSimilarError('')
    try { const items = preview ? [] : (await feedbackClient.post<{ items: FeedbackItem[] }>('/similar', { description: description.trim(), ...(application ? { application } : {}) })).data.items; if (run === similarRun.current) setSimilar(items) }
    catch (err) { if (run === similarRun.current) setSimilarError(onError(err)) }
    finally { if (run === similarRun.current) setSearchingFor(null) }
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy.current) return
    setError('')
    if (!Object.hasOwn(applicationLabels, application)) { setError('请选择所属应用。'); applicationField.current?.focus(); return }
    if (!description.trim()) { setError('请填写问题或建议。'); descriptionField.current?.focus(); return }
    if (attachmentError) return
    busy.current = true; setSubmitting(true)
    try {
      let item: FeedbackItem
      if (preview) item = { id: `demo-${crypto.randomUUID()}`, application, category, description: description.trim(), status: 'open', author_name: userName, created_at: new Date().toISOString(), images: attachments.map(x => x.url), can_delete: true, can_edit: true, is_mine: true, reply_count: 0, workflow_version: 2, source_context: context, ...structure }
      else {
        const fingerprint = JSON.stringify({ application, category, description: description.trim(), structure: Object.fromEntries(structureKeys(category).map(key => [key, structure[key].trim()])), source: context, files: files.map(file => [file.name, file.size, file.lastModified]) })
        if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, id: crypto.randomUUID() }
        setRequestState(request.current)
        if (namespace) await saveDraft(namespace, 'compose', { application, category, description, structure, source: context, request: request.current }, files).catch(() => false)
        const data = new FormData(); data.append('request_id', request.current.id); data.append('application', application); data.append('category', category); data.append('description', description.trim()); data.append('source_context', JSON.stringify(context))
        for (const key of structureKeys(category)) if (structure[key].trim()) data.append(key, structure[key].trim())
        files.forEach(file => data.append('images', file, file.name))
        item = (await feedbackClient.post<FeedbackItem>('', data)).data
      }
      await draft.discard()
      const transferred = preview ? attachments.map(x => x.url) : []
      transferred.forEach(url => urls.current.delete(url))
      onCreated(item, transferred)
    } catch (err) { setError(onError(err)) }
    finally { busy.current = false; setSubmitting(false) }
  }
  return <div className="feedback-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close() }}>
    <div ref={dialog} className="feedback-dialog" role="dialog" aria-modal="true" aria-labelledby="feedback-dialog-title" onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (confirmDiscard) setConfirmDiscard(false); else close() }
      if (event.key !== 'Tab') return
      const nodes = dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],summary'); if (!nodes?.length) return
      const first = nodes[0], last = nodes[nodes.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }}>
      {confirmDiscard ? <div className="feedback-discard"><span className="feedback-dialog-icon"><AlertCircle size={23} /></span><h2 id="feedback-dialog-title">放弃这条反馈？</h2><p>内容还未提交。可以保留草稿，稍后继续填写。</p><div className="feedback-dialog-actions"><button ref={continueEditing} className="feedback-outline-button" type="button" onClick={() => setConfirmDiscard(false)}>继续编辑</button><button className="feedback-outline-button" type="button" onClick={() => void draft.keep().then(ok => { if (ok) onClose() })}>保留草稿并关闭</button><button className="feedback-danger-button" type="button" onClick={() => void draft.discard().then(onClose)}>放弃并关闭</button></div>{draft.banner}</div> : <>
        <header className="feedback-dialog-header"><div><div className="feedback-dialog-kicker">SHARE YOUR FEEDBACK</div><h2 id="feedback-dialog-title">提交反馈</h2><p>描述问题与期望，让沟通更高效。</p></div><button className="feedback-icon-button" type="button" aria-label="关闭" disabled={submitting} onClick={close}><X size={20} /></button></header>
        <form className="feedback-dialog-form" onSubmit={event => void submit(event)} onPaste={event => {
          const images = Array.from(event.clipboardData.items).filter(x => x.kind === 'file' && x.type.startsWith('image/')).map(x => x.getAsFile()).filter((x): x is File => !!x)
          if (images.length) { event.preventDefault(); addImages(images) }
        }}>
          {draft.banner}
          <SourceContext source={context} />
          <div className="feedback-application-field"><div className="feedback-field-heading"><label htmlFor="feedback-application">所属应用</label><span>必选</span></div><select ref={applicationField} id="feedback-application" required value={application} disabled={submitting} onChange={event => { similarRun.current += 1; setSearchingFor(null); setSimilar(null); setApplication(event.target.value); setError('') }}><option value="">请选择所属应用</option>{Object.entries(applicationLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></div>
          <fieldset className="feedback-category-picker"><legend>反馈分类</legend>{(['bug', 'feature'] as const).map(value => <button type="button" key={value} disabled={submitting} aria-pressed={category === value} className={category === value ? 'is-selected' : ''} onClick={() => setCategory(value)}><span>{value === 'bug' ? <Bug size={18} /> : <Lightbulb size={18} />}</span><div><strong>{value === 'bug' ? 'Bug 问题' : '新功能建议'}</strong><small>{value === 'bug' ? '遇到故障或异常' : '分享需求或想法'}</small></div>{category === value && <CheckCircle2 size={17} />}</button>)}</fieldset>
          <div className="feedback-field"><div className="feedback-field-heading"><label htmlFor="feedback-description">问题或建议 <span>必填</span></label><span>{description.length} / 5000</span></div><textarea ref={descriptionField} id="feedback-description" required maxLength={5000} rows={5} disabled={submitting} value={description} onChange={event => { similarRun.current += 1; setSearchingFor(null); setDescription(event.target.value); setSimilar(null) }} placeholder="请描述遇到的问题，或希望实现的改进。" /></div>
          <details className="feedback-structured-section"><summary>{category === 'bug' ? '补充复现信息' : '补充需求信息'} <span>选填</span></summary><fieldset className="feedback-structured"><legend className="sr-only">结构化信息</legend>{structureKeys(category).map(key => <label key={key} htmlFor={`feedback-structure-${key}`}>{structureLabels[key]}<textarea id={`feedback-structure-${key}`} rows={2} maxLength={2000} disabled={submitting} value={structure[key]} onChange={event => setStructure(current => ({ ...current, [key]: event.target.value }))} /></label>)}</fieldset></details>
          <div className="feedback-similar"><button type="button" className="feedback-outline-button" disabled={searching || submitting || !description.trim()} onClick={() => void findSimilar()}><Search size={15} />{searching ? '正在查找…' : '查找相似反馈'}</button>{similarError && <p role="alert">{similarError}</p>}{similar && <div role="status">{similar.length ? <><p>可能已有相关反馈，可先查看或为同样的问题投票。</p>{similar.map(item => <a key={item.id} href={issuePath(item)} target="_blank" rel="noopener noreferrer">{issueLabel(item)} · {item.description.slice(0, 100)} <ArrowUpRight size={13} /></a>)}</> : <p>未找到相似反馈，你可以继续提交。</p>}</div>}</div>
          <div className="feedback-field"><div className="feedback-field-heading"><span className="feedback-field-label">图片说明 <span>选填</span></span><span>{attachments.length} / 3</span></div><div className="feedback-attachment-grid">{attachments.map(attachment => <div className="feedback-attachment" key={attachment.url}><img src={attachment.url} alt={`已添加图片 ${attachment.file.name}`} /><button type="button" aria-label={`移除图片 ${attachment.file.name}`} disabled={submitting} onClick={() => { request.current = null; setRequestState(null); URL.revokeObjectURL(attachment.url); urls.current.delete(attachment.url); setAttachments(current => current.filter(x => x.url !== attachment.url)); setAttachmentError('') }}><X size={15} /></button></div>)}{attachments.length < 3 && <label className="feedback-upload"><ImagePlus size={20} /><span>添加图片</span><input aria-label="添加图片" type="file" accept="image/png,image/jpeg,image/webp" multiple disabled={submitting} onChange={event => { addImages(Array.from(event.target.files || [])); event.target.value = '' }} /></label>}</div><ScreenCaptureEditor onAdd={file => addImages([file])} disabled={submitting || attachments.length >= 3} /><p className="feedback-field-help">截图后可在此按 Ctrl / Cmd + V 粘贴，也可点击添加图片。支持 PNG、JPEG、WebP，最多 3 张，每张不超过 5 MB。</p>{attachmentError && <div className="feedback-form-error" role="alert"><AlertCircle size={15} />{attachmentError}<button type="button" onClick={() => setAttachmentError('')}>忽略未添加的图片</button></div>}</div>
          {error && <div className="feedback-form-error" role="alert"><AlertCircle size={15} />{error}</div>}
          <footer className="feedback-dialog-footer"><p><ShieldCheck size={15} />反馈和图片对组织内成员可见。</p><div className="feedback-dialog-actions"><button type="button" className="feedback-outline-button" disabled={submitting} onClick={close}>取消</button><button type="submit" className="feedback-create" disabled={submitting || !!attachmentError}>{submitting ? '正在提交…' : '提交反馈'}<ChevronRight size={16} /></button></div></footer>
        </form>
      </>}
    </div>
  </div>
}

export function SourceContext({ source }: { source?: FeedbackSource | null }) {
  if (!source?.path && !source?.browser) return null
  return <aside className="feedback-source" aria-label="问题发生位置"><div><strong>问题发生位置</strong>{source.application && <span>{applicationLabel(source.application)}</span>}{source.path && <code>{source.path}</code>}</div><details><summary>环境信息</summary>{source.browser && <p>{source.browser}</p>}{source.captured_at && <p>{new Date(source.captured_at).toLocaleString('zh-CN')}</p>}</details></aside>
}
