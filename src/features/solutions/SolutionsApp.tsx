import { AnswerEvidence, AnswerModeControl, SearchCapability } from '../answerModes/AnswerTools'
import type { AnswerMode } from '../answerModes/types'
import { useSearchCapabilities } from '../answerModes/useSearchCapabilities'
import { modelPriceLabel } from '../../lib/modelPricing'
import ApplicationActions from '../../components/application/ApplicationActions'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import ReportMarkdown from './ReportMarkdown'
import SafeMarkdown from '../../components/SafeMarkdown'
import { stripReportImages } from './reportMarkup'
import { ArrowUpRight, BookOpen, BookOpenCheck, Check, CheckCheck, ChevronDown, ChevronRight, Copy, FileText, History, Info, LayoutDashboard, Library, List, LoaderCircle, Maximize2, MessageSquare, MoreHorizontal, Pencil, PanelLeftClose, Plus, Search, Send, Settings2, Sparkles, Trash2, Undo2, Upload, X } from 'lucide-react'
import type { Answer, KnowledgeSource, PolishResult, Reference, ReviewAction, Reviewer, Solution, SolutionClient, SolutionInput, TrashedSolution, SourceKind, Version } from './types'
import { deleteChapter, restoreChapter } from './chapterActions'
import { chapterDepth, chapterDescendants, moveChapter, filterReports, insertionRange } from './reportOrganization'
import type { LibraryNavigation } from './libraryEmbed'
import type { ReportCursor } from './reportOrganization'
import type { ReportTemplate, TopicMetadata } from './types'
import ReportNotesPicker from './ReportNotesPicker'
import VersionHistoryPanel from './VersionHistoryPanel'
import ReportExportMenu from './ReportExportMenu'
import './reportUpgrade.css'
import type { DeletedChapter } from './chapterActions'
import LayoutPicker from './LayoutPicker'
import NoteEditor from '../notes/NoteEditor'
import { newNote } from '../notes/draft'
import type { NoteDraft } from '../notes/draft'
import type { NotesClient } from '../notes/client'
import NoteSelectionCapture from '../notes/NoteSelectionCapture'
import ChapterTitleInput from './ChapterTitleInput'
import ConversationToolbar from './ConversationToolbar'
import { answerTopic, conversationTopics } from './conversations'
import type { ConversationDraft } from './conversations'
import ReportImportForm from './ReportImportForm'
import KnowledgeLibrary from './KnowledgeLibrary'
import InlineAssistantEditor from './InlineAssistantEditor'
import ModelSettingsPanel from './ModelSettingsPanel'
import type { ModelSettings, ModelSettingsClient } from './modelSettings'
import type { InlineQuestion } from './InlineAssistantEditor'
import { insertAtInlineAnchor, rebaseInlineAnchors, textEditFromValues } from './inlineAssistant'
import type { InlineTextEdit } from './inlineAssistant'
import { moduleLabels, readWorkspaceLayout, WORKSPACE_LAYOUT_KEY } from './layout'
import type { WorkspaceModule } from './layout'
import { panelStorageKey, readPanelPreferences, clampOutlineWidth } from './workspacePanels'
import WorkspaceResizers from './WorkspaceResizers'
import { getSizedGrid, getStackHeight, readWorkspaceSizes, WORKSPACE_SIZES_KEY } from './workspaceSizing'
import { readFocusWriting, WRITING_MODE_KEY } from './focusWriting'
import type { WritingTool } from './focusWriting'
import { discardWorkspaceRecovery, readWorkspaceRecovery, RECOVERED_QUESTION_NOTICE, recoveredInlineCards, workspaceRecoveryNotice, workspaceRecoveryScope, writeWorkspaceRecovery } from './workspaceRecovery'
import './solutions.css'
import './focusWriting.css'
import './reportTheme.css'
import './reportWorkspace.css'

const statuses = { draft: '草稿', in_review: '待评审', final: '已定稿', archived: '已归档' }
const kinds: Record<SourceKind, string> = { paper: '论文', practice: '实践记录', note: '专家笔记', solution: '历史报告', web: '网络来源' }
const sectionTitles = ['研究目标与适用范围', '已有知识与实践基础', '候选配方与选择依据', '工艺思路与关键条件', '验证安排与评价方法', '风险与待解决问题', '专家结论与参考资料']
const uid = () => crypto.randomUUID()
const message = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请重试。'
const asInput = (s: Solution): SolutionInput => ({ title: s.title, projectName: s.projectName, productName: s.productName, sections: s.sections, formula: s.formula, references: s.references, pinned: !!s.pinned, tags: s.tags || [] })
const dateText = (value: string) => value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'
function aiContext(text: string) { return stripReportImages(text) }
function safeUrl(url: string) { try { const value = new URL(url); return ['http:', 'https:'].includes(value.protocol) ? value.href : undefined } catch { return undefined } }
function Button({ children, primary, className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }) { return <button type="button" className={`ks-button ${primary ? 'ks-primary' : ''} ${className}`} {...props}>{children}</button> }
function FocusModeSwitch({ active, onChange }: { active: boolean; onChange: () => void }) {
  return <button type="button" className="ks-focus-switch" role="switch" aria-label="专注模式" aria-checked={active} title={active ? '关闭专注模式，恢复分栏' : '打开专注模式，全屏撰写'} onClick={onChange}><Maximize2 size={14} /><span>专注模式</span><span className="ks-switch-track" aria-hidden="true"><span /></span></button>
}
function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { const previous = document.activeElement as HTMLElement; const element = ref.current; if (!element?.contains(document.activeElement)) element?.focus(); const handler = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); if (event.key === 'Tab' && element) { const controls = [...element.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),a[href]')]; const first = controls[0], last = controls.at(-1); if (event.shiftKey && (document.activeElement === first || document.activeElement === element)) { event.preventDefault(); last?.focus() } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() } } }; document.addEventListener('keydown', handler); return () => { document.removeEventListener('keydown', handler); previous?.focus() } }, [onClose, title])
  return <div className="ks-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}><div className={`ks-modal ${wide ? 'ks-modal-wide' : ''}`} ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><Button aria-label="关闭弹窗" onClick={onClose}><X size={18} /></Button></header>{children}</div></div>
}
function Markdown({ children }: { children: string }) { return <div className="ks-markdown"><SafeMarkdown>{children}</SafeMarkdown></div> }
function NewSolution({ original, busy, onClose, onCreate, templates = [] }: { templates?: ReportTemplate[]; original?: Solution; busy: boolean; onClose: () => void; onCreate: (input: SolutionInput) => Promise<void> }) {
  const [title, setTitle] = useState(original ? `${original.title} · 副本` : ''), [project, setProject] = useState(original?.projectName || ''), [product, setProduct] = useState(original?.productName || ''), [template, setTemplate] = useState('formula')
  return <Modal title={original ? '复制为新报告' : '新建研究报告'} onClose={onClose}><form onSubmit={event => { event.preventDefault(); const chosen = templates.find(item => item.id === template); const ids = new Map(chosen?.sections.map(section => [section.id, uid()])); const sections = chosen ? chosen.sections.map(section => ({ ...section, id: ids.get(section.id)!, parentId: section.parentId ? ids.get(section.parentId) || null : null, content: '' })) : original ? original.sections.map((s, i) => ({ ...s, content: i === 0 ? `来源：${original.title} · v${original.version}。复制的引用需重新核对适用性。\n\n${s.content}` : s.content })) : (template === 'formula' ? sectionTitles : ['报告正文']).map(title => ({ id: uid(), title, content: '' })); void onCreate({ title: title.trim(), projectName: project.trim(), productName: product.trim(), sections, formula: original?.formula || [], references: original?.references || [] }) }}><label className="ks-field">报告名称<input autoFocus required value={title} onChange={e => setTitle(e.target.value)} placeholder="为这次研究命名" maxLength={200} /></label><div className="ks-form-grid"><label className="ks-field">所属项目<input value={project} onChange={e => setProject(e.target.value)} placeholder="项目名称" maxLength={200} /></label><label className="ks-field">产品 / 剂型<input value={product} onChange={e => setProduct(e.target.value)} placeholder="研究对象" maxLength={200} /></label></div>{!original && <label className="ks-field">报告模板<select value={template} onChange={e => setTemplate(e.target.value)}><option value="formula">配方研究报告 · 7 个章节</option><option value="blank">空白报告</option>{templates.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}<p className="ks-muted">从问题、证据与专家判断开始，逐步完善研究报告。</p><footer><Button onClick={onClose}>取消</Button><button className="ks-button ks-primary" disabled={busy || !title.trim()} type="submit">{busy ? '创建中…' : '开始撰写'}<ArrowUpRight size={15} /></button></footer></form></Modal>
}
function ReviewDialog({ action, reviewers, userId, userName, busy, onClose, onConfirm }: { action: ReviewAction['action']; reviewers: Reviewer[]; userId: string; userName: string; busy: boolean; onClose: () => void; onConfirm: (note: string, reviewerId: string) => Promise<void> }) {
  const [note, setNote] = useState(''), [reviewer, setReviewer] = useState(userId)
  const titles: Record<ReviewAction['action'], string> = { submit: '提交报告评审', withdraw: '撤回评审', approve: '确认通过并定稿', return: '退回修改', revise: '建立下一版草稿', archive: '归档报告', restore: '恢复历史版本' }
  const allReviewers = reviewers.some(r => r.id === userId) ? reviewers : [{ id: userId, name: userName }, ...reviewers]
  return <Modal title={titles[action]} onClose={onClose}><form onSubmit={e => { e.preventDefault(); void onConfirm(note, reviewer) }}>{action === 'submit' && <label className="ks-field">指定评审者<select value={reviewer} onChange={e => setReviewer(e.target.value)}>{allReviewers.map(r => <option value={r.id} key={r.id}>{r.name}{r.id === userId ? '（作者确认）' : ''}</option>)}</select></label>}<p className="ks-muted">{action === 'submit' ? '提交后形成评审快照，正文暂时锁定。需要编辑时可撤回。' : action === 'approve' ? '定稿将保留当前正文、配方、引用和评审结论。' : action === 'revise' || action === 'restore' ? '将创建新的草稿版本，既有历史记录继续保留。' : '本次操作及理由将保留在版本记录中。'}</p><label className="ks-field">{action === 'approve' ? '评审结论与待验证事项' : '说明 / 理由'}<textarea autoFocus rows={5} required value={note} onChange={e => setNote(e.target.value)} placeholder="请记录判断依据和后续安排…" /></label><footer><Button onClick={onClose}>取消</Button><button className="ks-button ks-primary" disabled={busy || !note.trim()}>{busy ? '处理中…' : titles[action]}</button></footer></form></Modal>
}

export default function SolutionsApp({ client, userId, userName, preview, modelClient, notesClient, initialHome = false, recoveryNamespace }: { client: SolutionClient; userId: string; userName: string; preview: boolean; modelClient?: ModelSettingsClient; notesClient?: NotesClient; initialHome?: boolean; recoveryNamespace?: string }) {
  const recoveryScope = workspaceRecoveryScope(recoveryNamespace, userId, preview)
  const [notesPicker, setNotesPicker] = useState(false), [fullPreview, setFullPreview] = useState(false)
  const [reportProject, setReportProject] = useState(''), [reportTag, setReportTag] = useState(''), [reportSort, setReportSort] = useState('updated'), [listView, setListView] = useState(false), [groupProjects, setGroupProjects] = useState(false)
  const [templates, setTemplates] = useState<ReportTemplate[]>([]), [templateOpen, setTemplateOpen] = useState(false), [templateName, setTemplateName] = useState(''), [templateError, setTemplateError] = useState('')
  const [topicMetadata, setTopicMetadata] = useState<TopicMetadata[]>([]), [sourceNames, setSourceNames] = useState<Record<string,string>>({})
  const versionOperation = useRef(false), deletedTopicIds = useRef(new Set<string>())
  const cursorRef = useRef<ReportCursor | null>(null), [insertMode, setInsertMode] = useState('end'), [insertCursor, setInsertCursor] = useState<ReportCursor | null>(null)
  const [chapterDrag, setChapterDrag] = useState(''), questionAbort = useRef<AbortController | null>(null)
  const [noteDraft, setNoteDraft] = useState<NoteDraft | null>(null)
  const [models, setModels] = useState<ModelSettings>({ profiles: [], defaultProfileId: null, revision: 0 })
  const [modelSettingsOpen, setModelSettingsOpen] = useState(false), [modelProfileId, setModelProfileId] = useState('system'), [modelLoading, setModelLoading] = useState(!!modelClient), [modelError, setModelError] = useState(''), [modelReload, setModelReload] = useState(0)
  const [loadedModelClient, setLoadedModelClient] = useState<ModelSettingsClient | undefined>(undefined), modelLoadGeneration = useRef(0)
  const modelsLoading = !!modelClient && (modelLoading || loadedModelClient !== modelClient)
  useEffect(() => {
    if (!modelClient) return
    let active = true
    const generation = ++modelLoadGeneration.current
    const isCurrent = () => active && generation === modelLoadGeneration.current
    modelClient.get().then(value => { if (isCurrent()) { setModels(value); setModelProfileId(value.defaultProfileId || 'system'); setModelError('') } }).catch(reason => { if (isCurrent()) setModelError(message(reason)) }).finally(() => { if (isCurrent()) { setModelLoading(false); setLoadedModelClient(modelClient) } })
    return () => { active = false }
  }, [modelClient, modelReload])
  const [solutions, setSolutions] = useState<Solution[]>([]), [doc, setDoc] = useState<Solution | null>(null), [loading, setLoading] = useState(true), [listOpen, setListOpen] = useState(initialHome), [listQuery, setListQuery] = useState('')
  const [deleteReport, setDeleteReport] = useState<Solution | null>(null), [trashOpen, setTrashOpen] = useState(false), [trashedReports, setTrashedReports] = useState<TrashedSolution[]>([]), [trashLoading, setTrashLoading] = useState(false)
  const [renameReport, setRenameReport] = useState<Solution | null>(null), [renameName, setRenameName] = useState(''), [renameError, setRenameError] = useState(''), [renameBusy, setRenameBusy] = useState(false)
  const renamePending = useRef(false)
  const [sectionId, setSectionId] = useState(''), [readMode, setReadMode] = useState(false), [selection, setSelection] = useState(''), [workspaceLayout, setWorkspaceLayout] = useState(readWorkspaceLayout), [panels, setPanels] = useState(readPanelPreferences), [layoutOpen, setLayoutOpen] = useState(false), [assistantFocusRequest, setAssistantFocusRequest] = useState(0)
  const [focusWriting, setFocusWriting] = useState(readFocusWriting), [focusTool, setFocusTool] = useState<WritingTool | null>(null), toolReturnFocus = useRef<HTMLElement | null>(null)
  const [workspaceSizes, setWorkspaceSizes] = useState(readWorkspaceSizes)
  const appElement = useRef<HTMLDivElement>(null), workspaceElement = useRef<HTMLDivElement>(null)
  const [answerMode, setAnswerMode] = useState<AnswerMode>('auto'), [showSearchStatus, setShowSearchStatus] = useState(false)
  const capabilities = useSearchCapabilities(client, modelClient ? modelProfileId : undefined, models.revision)
  const [libraryNavigation, setLibraryNavigation] = useState<LibraryNavigation | undefined>()
  const [knowledgeMessage, setKnowledgeMessage] = useState(''), [sourceOpen, setSourceOpen] = useState<KnowledgeSource | null>(null), [selectedSources, setSelectedSources] = useState<string[]>([])
  const [projectFilter, setProjectFilter] = useState('') // Preserve an existing recovery scope; no removed selector is restored.
  const [sourcesRestoring, setSourcesRestoring] = useState(false), [recoverySourceError, setRecoverySourceError] = useState(''), [recoveryStorageError, setRecoveryStorageError] = useState(false)
  const sourceSelectionEpoch = useRef(0), recoveringSourceIds = useRef<string[]>([])
  const [topicId, setTopicId] = useState<string | null>(null), [topicDrafts, setTopicDrafts] = useState<Record<string, ConversationDraft>>({})
  const [newTopicId, setNewTopicId] = useState(uid), activeTopicRef = useRef('')
  const [pendingTopicId, setPendingTopicId] = useState(''), [askErrorTopicId, setAskErrorTopicId] = useState(''), [referencesExpanded, setReferencesExpanded] = useState(false)
  const [answers, setAnswers] = useState<Answer[]>([]), [question, setQuestion] = useState(''), [context, setContext] = useState(''), [showContext, setShowContext] = useState(false), [asking, setAsking] = useState(false), [askError, setAskError] = useState(''), [historyError, setHistoryError] = useState('')
  const [saveState, setSaveState] = useState<'saved' | 'dirty' | 'saving' | 'error' | 'conflict'>('saved'), [saveError, setSaveError] = useState(''), [editCount, setEditCount] = useState(0), [notice, setNotice] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState('')
  const [importOpen, setImportOpen] = useState(false), [importError, setImportError] = useState('')
  const importPending = useRef(false)
  const [createOpen, setCreateOpen] = useState(false), [copyFrom, setCopyFrom] = useState<Solution | undefined>(), [reviewAction, setReviewAction] = useState<ReviewAction['action'] | null>(null), [reviewers, setReviewers] = useState<Reviewer[]>([]), [versions, setVersions] = useState<Version[] | null>(null), [remoteDoc, setRemoteDoc] = useState<Solution | null>(null), [metadata, setMetadata] = useState(false)
  const [insert, setInsert] = useState<{ content: string; refs: Reference[]; sectionId: string; type: string; inlineCardId?: string } | null>(null), [undo, setUndo] = useState<{ sectionId: string; added: string; offset: number; referenceIds: string[]; removed?: string } | null>(null)
  const [inlineCards, setInlineCards] = useState<InlineQuestion[]>([]), inlineCardsRef = useRef<InlineQuestion[]>([])
  const [textRequests, setTextRequests] = useState(0)
  const updateInlineCards = useCallback((next: InlineQuestion[]) => { inlineCardsRef.current = next; setInlineCards(next) }, [])
  const [chapterAction, setChapterAction] = useState<{ id: string; mode: 'menu' | 'rename' | 'delete' } | null>(null), [chapterName, setChapterName] = useState(''), [deletedChapter, setDeletedChapter] = useState<DeletedChapter | null>(null)
  const questionGeneration = useRef(0), pendingQuestionSection = useRef<string | null>(null)
  const docRef = useRef<Solution | null>(null), dirtyRef = useRef(false), sequence = useRef(0), savingRef = useRef<Promise<boolean> | null>(null), openSequence = useRef(0), writingArea = useRef<HTMLDivElement>(null), answerEnd = useRef<HTMLDivElement>(null), questionInput = useRef<HTMLTextAreaElement>(null)
  const modelBusy = asking || textRequests > 0 || inlineCards.some(card => card.status === 'asking')
  const selectedModel = models.profiles.find(profile => profile.id === modelProfileId)
  const modelLabel = preview ? '自动问答演示' : selectedModel ? `${selectedModel.name} · ${selectedModel.model}` : modelProfileId === 'retrieval' ? '仅检索资料' : '企业默认模型'
  const modelUnavailable = sourcesRestoring || !!recoverySourceError || !!modelClient && modelProfileId !== 'retrieval' && (modelsLoading || !!modelError)
  const modelPayload = modelClient ? { modelProfileId } : {}
  useEffect(() => { let active = true; client.templates?.().then(items => { if(active) setTemplates(items) }).catch(reason => { if(active) setTemplateError(message(reason)) }); return () => { active=false } }, [client])
  useEffect(() => () => { questionAbort.current?.abort() }, [])
  const closeModelSettings = useCallback(() => setModelSettingsOpen(false), [])
  function applyModelSettings(value: ModelSettings) { modelLoadGeneration.current += 1; setModels(value); setModelProfileId(value.defaultProfileId || 'system'); setModelError(''); setModelLoading(false); setLoadedModelClient(modelClient) }
  const topics = conversationTopics(answers).map(topic => ({ ...topic, ...topicMetadata.find(meta => meta.id === topic.id) }))
  const activeTopicId = topicId || topics.find(topic => !topic.archived)?.id || newTopicId
  useLayoutEffect(() => { activeTopicRef.current = activeTopicId }, [activeTopicId])
  const topicAnswers = answers.filter(answer => answerTopic(answer) === activeTopicId)
  const topicOptions = [...topics]
  for (const meta of topicMetadata) if(!topicOptions.some(topic=>topic.id===meta.id)) topicOptions.push({...meta,count:0,updatedAt:''})
  for (const [id, draft] of Object.entries(topicDrafts)) if (!topicOptions.some(topic => topic.id === id) && (draft.question.trim() || draft.context.trim())) topicOptions.unshift({ id, title: draft.question.trim().slice(0, 80) || '新的对话', count: 0, updatedAt: '' })
  if (!topicOptions.some(topic => topic.id === activeTopicId)) topicOptions.unshift({ id: activeTopicId, title: question.trim().slice(0, 80) || '新的对话', count: 0, updatedAt: '' })
  function switchConversation(id: string) {
    if (id === activeTopicId) return
    setTopicDrafts(items => ({ ...items, [activeTopicId]: { question, context, showContext } }))
    const draft = topicDrafts[id]
    setTopicId(id); setQuestion(draft?.question || ''); setContext(draft?.context || ''); setShowContext(draft?.showContext || false)
  }
  function startConversation() { switchConversation(uid()); showAssistant() }
  const currentSection = doc?.sections.find(section => section.id === sectionId) || doc?.sections[0]
  const editable = !!doc?.canEdit && doc.ownerId === userId && doc.status === 'draft'
  const chapterEditable = editable && !readMode
  const visibleModules = focusWriting ? { editor: true, knowledge: focusTool === 'knowledge', ai: focusTool === 'ai' } : panels.visible
  const outlineVisible = focusWriting ? focusTool === 'outline' : panels.outlineVisible
  const focusedWorkspace = focusWriting && !!doc && !listOpen && !loading
  const actionSection = doc?.sections.find(section => section.id === chapterAction?.id)
  const backupKey = useCallback((id: string) => `ks-draft:${preview ? 'preview' : 'live'}:${recoveryScope || userId}:${id}`, [preview, userId, recoveryScope])
  const replaceDoc = useCallback((value: Solution) => { if (docRef.current?.id !== value.id || docRef.current?.status !== value.status || docRef.current?.version !== value.version || !value.canEdit) updateInlineCards([]); docRef.current = value; setDoc(value); setSolutions(list => list.some(item => item.id === value.id) ? list.map(item => item.id === value.id ? value : item) : [value, ...list]) }, [updateInlineCards])
  function editDoc(patch: Partial<Solution>, anchors?: InlineQuestion[]) { const current = docRef.current; if (!current || !current.canEdit || current.ownerId !== userId || current.status !== 'draft') return; if (patch.sections) setUndo(previous => {
      if (!previous || previous.offset < 0) return previous
      const before = current.sections.find(s => s.id === previous.sectionId), after = patch.sections!.find(s => s.id === previous.sectionId)
      if (!before || !after) return null
      if (before.content === after.content) return previous
      const edit = textEditFromValues(before.content, after.content), end = previous.offset + previous.added.length
      if (edit.to <= previous.offset) return { ...previous, offset: previous.offset + edit.insert.length - (edit.to - edit.from) }
      if (edit.from >= end) return previous
      return { ...previous, offset: -1 }
    }); if (anchors) updateInlineCards(anchors); else if (patch.sections) { const nextCards = patch.sections.flatMap(section => { const cards = inlineCardsRef.current.filter(card => card.sectionId === section.id), previous = current.sections.find(s => s.id === section.id); return previous && previous.content !== section.content ? rebaseInlineAnchors(cards, textEditFromValues(previous.content, section.content)) : cards }); updateInlineCards(nextCards) } const next = { ...current, ...patch }; docRef.current = next; setDoc(next); dirtyRef.current = true; sequence.current += 1; setEditCount(n => n + 1); setSaveState('dirty'); try { sessionStorage.setItem(backupKey(next.id), JSON.stringify(next)) } catch { /* The unsaved document remains in memory. */ } }
  function editSection(content: string) { if (doc && currentSection) editDoc({ sections: doc.sections.map(section => section.id === currentSection.id ? { ...section, content } : section) }) }
  function editInlineText(edit: InlineTextEdit, precedingIds: string[]) {
    const current = docRef.current, section = current?.sections.find(s => s.id === currentSection?.id)
    if (!current || !section) return
    const anchors = rebaseInlineAnchors(inlineCardsRef.current.filter(c => c.sectionId === section.id).map(card => ({ ...card, affinity: precedingIds.includes(card.id) ? 'before' as const : 'after' as const })), edit).map(card => ({ ...card, affinity: undefined }))
    editDoc({ sections: current.sections.map(s => s.id === section.id ? { ...s, content: section.content.slice(0, edit.from) + edit.insert + section.content.slice(edit.to) } : s) }, [...inlineCardsRef.current.filter(c => c.sectionId !== section.id), ...anchors])
  }
  function createInlineQuestion(offset: number, precedingIds: string[]) {
    const current = docRef.current, section = current?.sections.find(s => s.id === currentSection?.id)
    if (!editable || !current || !section || section.content[offset] !== '/') return
    const anchors = rebaseInlineAnchors(inlineCardsRef.current.filter(c => c.sectionId === section.id), { from: offset, to: offset + 1, insert: '' }).sort((a, b) => a.offset - b.offset)
    const index = anchors.findIndex(card => card.offset > offset || (card.offset === offset && !precedingIds.includes(card.id)))
    anchors.splice(index === -1 ? anchors.length : index, 0, { id: uid(), sectionId: section.id, offset, question: '', includeContext: false, status: 'idle' })
    editDoc({ sections: current.sections.map(s => s.id === section.id ? { ...s, content: s.content.slice(0, offset) + s.content.slice(offset + 1) } : s) }, [...inlineCardsRef.current.filter(c => c.sectionId !== section.id), ...anchors])
    setSelection('')
  }
  function updateInlineQuestion(id: string, patch: Partial<InlineQuestion>) { updateInlineCards(inlineCardsRef.current.map(card => card.id === id ? { ...card, ...patch } : card)) }
  function removeInlineQuestion(id: string) { updateInlineCards(inlineCardsRef.current.filter(card => card.id !== id)) }
  async function askInlineQuestion(id: string) {
    const current = docRef.current, card = inlineCardsRef.current.find(c => c.id === id)
    if (!current || !editable || !card || !card.question.trim() || card.status === 'asking') return
    if (sourcesRestoring || recoverySourceError) { updateInlineQuestion(id, { status: 'error', error: '请先确认恢复后的资料范围，再重新提问。' }); return }
    if (modelUnavailable) { updateInlineQuestion(id, { status: 'error', error: '模型配置尚未加载，请在 AI 研究助手中重试，或切换为仅检索资料。' }); return }
    const token = openSequence.current, requestId = uid(), reportId = current.id
    const payload = { conversationId: card.id, question: card.question.trim(), context: card.includeContext ? aiContext(current.sections.find(s => s.id === card.sectionId)?.content || '').slice(0, 5000) : '', sourceIds: [...selectedSources], projectName: projectFilter, sectionId: card.sectionId, ...modelPayload, answerMode }
    const isCurrent = () => token === openSequence.current && docRef.current?.id === reportId && docRef.current?.canEdit && docRef.current?.status === 'draft' && docRef.current.sections.some(s => s.id === card.sectionId) && inlineCardsRef.current.some(c => c.id === id && c.requestId === requestId)
    updateInlineQuestion(id, { status: 'asking', error: '', answer: undefined, requestId })
    try {
      const saved = await flushAll()
      if (!isCurrent()) return
      if (!saved) throw new Error('报告尚未保存，请处理保存失败后再次提问。问题已保留。')
      const result = await client.ask(reportId, payload)
      const answer = { ...result, conversationId: payload.conversationId }
      // Keep authorized history available even if the author dismissed the card while waiting.
      if (token === openSequence.current && docRef.current?.id === reportId) setAnswers(items => items.some(item => item.id === answer.id) ? items : [...items, answer])
      if (isCurrent()) updateInlineQuestion(id, { status: 'answered', answer })
    } catch (reason) { if (isCurrent()) updateInlineQuestion(id, { status: 'error', error: message(reason) }) }
  }
  function stageInlineAnswer(id: string) {
    const card = inlineCardsRef.current.find(c => c.id === id)
    if (!editable || !card?.answer || card.status === 'asking' || !docRef.current?.sections.some(s => s.id === card.sectionId)) return
    stageInsert({ content: card.answer.content, refs: card.answer.references, sectionId: card.sectionId, type: card.answer.mode === 'ai' ? 'AI 辅助建议' : '知识摘录', inlineCardId: id })
  }
  const flush = useCallback(async (): Promise<boolean> => {
    while (savingRef.current) { const pending = savingRef.current; const ok = await pending; if (!ok) return false; if (savingRef.current === pending) savingRef.current = null }
    if (!dirtyRef.current || !docRef.current) return true
    const current = docRef.current, sentSequence = sequence.current
    setSaveState('saving'); setSaveError('')
    const task = (async () => { try { const saved = await client.save(current.id, { ...asInput(current), revision: current.revision }); if (docRef.current?.id !== current.id) return true; if (sentSequence === sequence.current) { dirtyRef.current = false; replaceDoc(saved); setSaveState('saved'); try { sessionStorage.removeItem(backupKey(current.id)) } catch { /* Optional recovery cache. */ } } else { const latest = { ...docRef.current, revision: saved.revision, updatedAt: saved.updatedAt }; replaceDoc(latest); setSaveState('dirty'); try { sessionStorage.setItem(backupKey(current.id), JSON.stringify(latest)) } catch { /* Optional recovery cache. */ } } return true } catch (reason) { const text = message(reason); const conflict = (reason as { status?: number })?.status === 409 || /conflict|冲突|版本已|revision/i.test(text); setSaveState(conflict ? 'conflict' : 'error'); setSaveError(text); return false } })()
    savingRef.current = task
    try { return await task } finally { if (savingRef.current === task) savingRef.current = null }
  }, [client, backupKey, replaceDoc])
  const flushAll = useCallback(async () => { while (dirtyRef.current || savingRef.current) { if (!await flush()) return false } return true }, [flush])
  const openDoc = useCallback(async (id: string) => {
    if (!await flushAll()) { setError('当前修改尚未保存，已保留在编辑器中。请先重试保存或另存副本。'); return }
    const token = ++openSequence.current; setLoading(true); setError(''); setNotice('')
    try {
      const value = await client.get(id)
      if (token !== openSequence.current) return
      const canRecover = value.canEdit && value.ownerId === userId && value.status === 'draft'
      const recovery = canRecover ? readWorkspaceRecovery(recoveryScope, id) : null
      if (!canRecover) discardWorkspaceRecovery(recoveryScope, id)
      let local: Solution | null = null
      try { const raw = sessionStorage.getItem(backupKey(id)); if (raw) local = JSON.parse(raw) } catch { /* Invalid recovery cache ignored. */ }
      const displayed = local && canRecover ? { ...value, ...asInput(local) } : value
      replaceDoc(displayed)
      setSectionId(displayed.sections.some(section => section.id === recovery?.sectionId) ? recovery!.sectionId : displayed.sections[0]?.id || '')
      setFocusTool(null); setSelection(''); setSelectedSources([]); setSourceNames({}); setTopicMetadata([]); deletedTopicIds.current.clear(); cursorRef.current = null; questionAbort.current?.abort()
      setContext(recovery?.context || ''); setQuestion(recovery?.question || ''); setShowContext(recovery?.showContext || false)
      setAnswerMode(recovery?.answerMode || 'auto')
      setAnswers([]); setTopicId(recovery?.topicId || null); setTopicDrafts(recovery?.topicDrafts || {})
      setNewTopicId(uid()); setPendingTopicId(''); setAskErrorTopicId(recovery?.pendingTopicId || '')
      updateInlineCards(recovery ? recoveredInlineCards(recovery, displayed, userId) : [])
      setAskError(recovery?.interrupted ? '上次生成已中断。问题已保留，请先核对问答历史，再决定是否重试。' : '')
      setHistoryError(''); setUndo(null); setDeletedChapter(null); setChapterAction(null)
      questionGeneration.current += 1; pendingQuestionSection.current = null; setAsking(false); setListOpen(false); setInsert(null)
      dirtyRef.current = !!local && canRecover; sequence.current += 1
      if (dirtyRef.current) {
        if (local!.revision !== value.revision) {
          docRef.current = { ...docRef.current!, revision: local!.revision }; setDoc(docRef.current)
          setSaveState('conflict'); setSaveError('恢复的本地草稿与服务器版本不同，请比较后处理。')
        } else { setSaveState('dirty'); setEditCount(n => n + 1) }
        setNotice('已恢复本机未保存草稿，请核对内容并保存。')
      } else {
        setSaveState('saved')
        setNotice(workspaceRecoveryNotice(recovery))
      }
      if (value.ownerId === userId && client.topics) void client.topics(id).then(items => { if (token === openSequence.current) setTopicMetadata(items) }).catch(reason => { if(token === openSequence.current) setHistoryError(message(reason)) })
      if (value.ownerId === userId) client.history(id).then(history => {
        if (token !== openSequence.current) return
        setAnswers(current => [...history.filter(item=>!deletedTopicIds.current.has(answerTopic(item))), ...current.filter(item => !history.some(old => old.id === item.id) && !deletedTopicIds.current.has(answerTopic(item)))])
        // Only freshly authorized server answers can restore a card's adoptable citations.
        updateInlineCards(inlineCardsRef.current.map(card => {
          const answer = history.findLast(item => item.conversationId === card.id && item.question === card.question.trim())
          return answer && card.status !== 'asking' ? { ...card, status: 'answered', answer, error: undefined } : card
        }))
      }).catch(reason => { if (token === openSequence.current) setHistoryError(message(reason)) })
      setProjectFilter(recovery?.projectFilter || '')
      recoveringSourceIds.current = recovery?.selectedSourceIds || []
      const sourceEpoch = ++sourceSelectionEpoch.current
      setRecoverySourceError(''); setSourcesRestoring(!!recoveringSourceIds.current.length)
      if (recoveringSourceIds.current.length) void (async () => {
        const ids = [...recoveringSourceIds.current], verified: string[] = []
        // Recheck every cached selection with the server, with bounded concurrency.
        for (let index = 0; index < ids.length; index += 4) {
          if (token !== openSequence.current || sourceEpoch !== sourceSelectionEpoch.current) return
          const batch = ids.slice(index, index + 4)
          const results = await Promise.allSettled(batch.map(sourceId => client.getSource(sourceId, id)))
          results.forEach((result, offset) => { if (result.status === 'fulfilled' && result.value.id === batch[offset]) { verified.push(batch[offset]); setSourceNames(names => ({ ...names, [result.value.id]: result.value.title })) } })
        }
        if (token !== openSequence.current || sourceEpoch !== sourceSelectionEpoch.current) return
        setSelectedSources(verified); setSourcesRestoring(false)
        if (verified.length !== ids.length) setRecoverySourceError('上次的资料范围未能完整确认。请重新选择资料，或明确清除原范围后继续提问。')
        else recoveringSourceIds.current = []
      })()
    } catch (reason) {
      if (token === openSequence.current) {
        if ([403, 404].includes((reason as { status?: number })?.status || 0)) discardWorkspaceRecovery(recoveryScope, id)
        setError(message(reason))
        updateInlineCards(inlineCardsRef.current.map(card => card.status === 'asking' ? { ...card, status: 'error', requestId: undefined, error: '报告未能切换，上次提问已中断。问题已保留，请重试。' } : card))
      }
    } finally { if (token === openSequence.current) setLoading(false) }
  // flushAll deliberately reads the latest save refs; its callback identity remains stable.
  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  }, [client, backupKey, flushAll, replaceDoc, userId, updateInlineCards, recoveryScope])
  useEffect(() => {
    let active = true
    client.list().then(async list => {
      if (!active) return
      setSolutions(list)
      const recovery = readWorkspaceRecovery(recoveryScope)
      const requestedReport = new URLSearchParams(window.location.search).get('report')
      const linkedReport = list.find(item => item.id === requestedReport)?.id
      const resume = linkedReport || (recovery && !recovery.listOpen && list.some(item => item.id === recovery.reportId) ? recovery.reportId : undefined)
      if (resume || list[0] && !initialHome) await openDoc(resume || list[0].id)
      else { setListOpen(true); setLoading(false) }
    }).catch(reason => { if (active) { setError(message(reason)); setLoading(false) } })
    client.knowledgeStatus().then(status => { if (active) setKnowledgeMessage(status.message) }).catch(reason => { if (active) setKnowledgeMessage(`知识连接状态读取失败：${message(reason)}`) })
    client.reviewers().then(data => { if (active) setReviewers(data) }).catch(() => { /* Author confirmation remains available. */ })
    return () => { active = false; openSequence.current += 1 }
  }, [client, openDoc, initialHome, recoveryScope])
  useLayoutEffect(() => {
    if (!doc || loading || !doc.canEdit || doc.ownerId !== userId || doc.status !== 'draft') return
    const saved = writeWorkspaceRecovery(recoveryScope, {
      reportId: doc.id, sectionId, topicId: activeTopicId, question, context, showContext, topicDrafts,
      selectedSourceIds: sourcesRestoring || recoverySourceError ? recoveringSourceIds.current : selectedSources,
      projectFilter, answerMode, inlineCards, interrupted: modelBusy, pendingTopicId, listOpen,
    })
    setRecoveryStorageError(!saved)
  }, [recoveryScope, doc, loading, userId, sectionId, activeTopicId, question, context, showContext, topicDrafts, selectedSources, projectFilter, answerMode, inlineCards, modelBusy, pendingTopicId, listOpen, sourcesRestoring, recoverySourceError])
  useEffect(() => { if (!editCount) return; const timer = setTimeout(() => { void flush() }, 3000); return () => clearTimeout(timer) }, [editCount, flush])
  useEffect(() => { if (notice !== RECOVERED_QUESTION_NOTICE) return; const timer = window.setTimeout(() => setNotice(current => current === RECOVERED_QUESTION_NOTICE ? '' : current), 5000); return () => window.clearTimeout(timer) }, [notice])
  useEffect(() => { try { localStorage.setItem(WORKSPACE_LAYOUT_KEY, JSON.stringify(workspaceLayout)) } catch { /* Layout persistence is optional. */ } }, [workspaceLayout])
  useEffect(() => { try { localStorage.setItem(panelStorageKey, JSON.stringify(panels)) } catch { /* Panel preferences are optional. */ } }, [panels])
  useEffect(() => { try { localStorage.setItem(WORKSPACE_SIZES_KEY, JSON.stringify(workspaceSizes)) } catch { /* Module size preferences are optional. */ } }, [workspaceSizes])
  useEffect(() => { try { localStorage.setItem(WRITING_MODE_KEY, focusWriting ? 'focus' : 'split') } catch { /* Writing mode persistence is optional. */ } }, [focusWriting])
  useEffect(() => {
    const workspace = workspaceElement.current
    if (!focusedWorkspace || !workspace) return
    const toolbar = workspace.querySelector<HTMLElement>('.ks-focus-toolbar')
    const positionPanels = () => {
      const height = toolbar?.getBoundingClientRect().height ?? 48
      appElement.current?.style.setProperty('--ks-focus-module-header-height', `${height}px`)
      appElement.current?.style.setProperty('--ks-focus-panel-top', `${workspace.getBoundingClientRect().top + height}px`)
    }
    positionPanels()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(positionPanels)
    observer?.observe(workspace)
    if (toolbar) observer?.observe(toolbar)
    window.addEventListener('resize', positionPanels)
    return () => { observer?.disconnect(); window.removeEventListener('resize', positionPanels) }
  }, [focusedWorkspace])
  useEffect(() => {
    if (!focusedWorkspace || !focusTool) return
    const frame = requestAnimationFrame(() => {
      const panel = focusTool === 'outline' ? '#ks-chapter-outline' : focusTool === 'knowledge' || focusTool === 'ai' ? `[data-module="${focusTool}"]` : '#ks-supplement-panel'
      appElement.current?.querySelector<HTMLElement>(`${panel} button:not([disabled])`)?.focus({ preventScroll: true })
    })
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || document.querySelector('.ks-overlay')) return
      setFocusTool(null); toolReturnFocus.current?.focus({ preventScroll: true })
    }
    document.addEventListener('keydown', onEscape)
    return () => { cancelAnimationFrame(frame); document.removeEventListener('keydown', onEscape) }
  }, [focusedWorkspace, focusTool])
  useEffect(() => { const handler = (event: BeforeUnloadEvent) => { if (dirtyRef.current) { event.preventDefault(); event.returnValue = '' } }; window.addEventListener('beforeunload', handler); return () => window.removeEventListener('beforeunload', handler) }, [])
  useEffect(() => { const conversation = answerEnd.current?.parentElement; conversation?.scrollTo?.({ top: conversation.scrollHeight, behavior: 'smooth' }) }, [topicAnswers.length, activeTopicId])
  useEffect(() => { if (!assistantFocusRequest) return; const frame = requestAnimationFrame(() => { questionInput.current?.focus({ preventScroll: true }); questionInput.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }) }); return () => cancelAnimationFrame(frame) }, [assistantFocusRequest])
  function toggleFocusMode() {
    setFocusTool(null); setFocusWriting(current => !current)
    requestAnimationFrame(() => { [...(appElement.current?.querySelectorAll<HTMLButtonElement>('.ks-focus-switch') ?? [])].find(button => button.getClientRects().length > 0)?.focus({ preventScroll: true }) })
  }
  function closeFocusTool() { setFocusTool(null); toolReturnFocus.current?.focus({ preventScroll: true }) }
  function openFocusTool(tool: WritingTool) {
    if (focusTool === tool) { closeFocusTool(); return }
    toolReturnFocus.current = document.activeElement as HTMLElement
    setFocusTool(tool)
  }
  function toggleOutline() {
    if (focusWriting) { openFocusTool('outline'); return }
    setPanels(current => ({ ...current, outlineVisible: !current.outlineVisible }))
  }
  function toggleModule(module: WorkspaceModule) {
    if (focusWriting) { if (module !== 'editor') openFocusTool(module); return }
    setPanels(current => ({ ...current, visible: { ...current.visible, [module]: !current.visible[module] } }))
  }
  function showAssistant() {
    if (focusWriting) { toolReturnFocus.current = document.activeElement as HTMLElement; setFocusTool('ai') }
    else setPanels(current => ({ ...current, visible: { ...current.visible, ai: true } }))
    setAssistantFocusRequest(current => current + 1)
  }
  function saveExcerptToNotes(text: string) {
    if (!docRef.current || !notesClient) return
    const sourceTitle = `${docRef.current.title} · ${currentSection?.title || '研究报告'}`.slice(0, 500)
    setNoteDraft(newNote({ title: `${currentSection?.title || '研究报告'}摘录`.slice(0, 200), content: text, sourceApp: 'solutions', sourceTitle, sourceUrl: '/solutions' + (preview ? '?preview=1' : '') }))
  }
  function askAboutChapter() { if (!currentSection) return; setTopicId(activeTopicId); setContext(selection || aiContext(currentSection.content).slice(0, 5000)); setShowContext(true); showAssistant(); if (!question) setQuestion('关于这段内容，知识库中有哪些相关论文和实践依据？') }
  function addExpertJudgment() { if (currentSection) editSection(`${currentSection.content}\n\n### 专家判断\n结论：\n支持 / 反对的依据：\n适用条件：\n选择理由：\n作者：${userName} · ${new Date().toLocaleDateString('zh-CN')}\n`) }
  function resizeOutline(clientX: number) { const bounds = writingArea.current?.getBoundingClientRect(); if (bounds) setPanels(current => ({ ...current, outlineWidth: clampOutlineWidth(Math.min(clientX - bounds.left, bounds.width * .45)) })) }
  const closeLayout = useCallback(() => setLayoutOpen(false), [])
  const moduleProps = (module: WorkspaceModule) => ({ 'data-module': module, 'data-slot': workspaceLayout.order.indexOf(module) + 1, hidden: !visibleModules[module], style: { gridArea: `s${workspaceLayout.order.indexOf(module) + 1}`, order: workspaceLayout.order.indexOf(module), '--ks-mobile-height': `${getStackHeight(module, workspaceSizes)}px` } as CSSProperties })
  async function run(key: string, action: () => Promise<void>) { setBusy(key); setError(''); try { await action() } catch (reason) { setError(message(reason)) } finally { setBusy('') } }
  async function saveReportName() {
    const target = renameReport, name = renameName.trim()
    if (!target || !name || name.length > 300 || renamePending.current) return
    renamePending.current = true; setRenameBusy(true); setRenameError('')
    try {
      if (docRef.current?.id === target.id && !await flushAll()) throw new Error('当前报告尚未保存，请先处理保存失败后再修改名称。')
      const expectedRevision = docRef.current?.id === target.id ? docRef.current.revision : target.revision
      const latest = await client.get(target.id)
      if (latest.ownerId !== userId || !latest.canEdit || latest.status !== 'draft') throw new Error('只有作者的草稿可以修改名称，请先创建新修订。')
      if (latest.revision !== expectedRevision) throw new Error('报告已在其他页面更新，请关闭窗口并重新打开报告后再修改名称。')
      if (latest.title === name) { setRenameReport(null); return }
      const saved = await client.save(target.id, { ...asInput(latest), title: name, revision: latest.revision })
      const current = docRef.current
      if (current?.id === target.id) {
        if (dirtyRef.current) {
          const merged = { ...current, title: saved.title, revision: saved.revision, updatedAt: saved.updatedAt }
          replaceDoc(merged); setSaveState('dirty')
          try { sessionStorage.setItem(backupKey(merged.id), JSON.stringify(merged)) } catch { /* Optional recovery cache. */ }
        } else replaceDoc(saved)
      } else setSolutions(items => items.map(item => item.id === saved.id ? saved : item))
      setRenameReport(null); setNotice('报告名称已更新。')
    } catch (reason) { setRenameError(message(reason)) }
    finally { renamePending.current = false; setRenameBusy(false) }
  }
  async function ask() {
    if (!doc || doc.ownerId !== userId || !question.trim() || asking) return
    if(topicMetadata.find(topic=>topic.id===activeTopicId)?.archived) {setAskError('当前主题已归档，请先取消归档或新建对话。');return}
    if (sourcesRestoring || recoverySourceError) { setAskErrorTopicId(activeTopicId); setAskError('请先确认恢复后的资料范围，再重新提问。'); return }
    if (modelUnavailable) { setAskErrorTopicId(activeTopicId); setAskError('模型配置尚未加载，请重试加载，或切换为仅检索资料。'); return }
    const selectedModelPayload = { ...modelPayload }
    const token = openSequence.current, generation = ++questionGeneration.current
    const sentQuestion = question, sentSection = currentSection?.id || '', sentTopic = activeTopicId
    setTopicId(sentTopic); setPendingTopicId(sentTopic); setAskErrorTopicId(sentTopic)
    const isCurrent = () => token === openSequence.current && generation === questionGeneration.current
    pendingQuestionSection.current = sentSection; const controller = new AbortController(); questionAbort.current = controller; setAsking(true); setAskError('')
    try {
      const saved = await flushAll()
      if (!isCurrent()) return
      if (!saved) { setAskError('当前报告尚未保存，请先处理保存失败后再提问。'); return }
      if (!docRef.current?.sections.some(section => section.id === sentSection)) { setAskError('提问所关联的章节已删除，请核对上下文后重新提问。'); return }
      const answer = await client.ask(docRef.current.id, { question: sentQuestion.trim(), context: aiContext(context), sourceIds: selectedSources, projectName: projectFilter, sectionId: sentSection, conversationId: sentTopic, ...selectedModelPayload, answerMode }, controller.signal)
      if (isCurrent() && !deletedTopicIds.current.has(sentTopic) && docRef.current?.sections.some(section => section.id === sentSection)) { setAnswers(items => [...items, { ...answer, conversationId: sentTopic }]); if (activeTopicRef.current === sentTopic) setQuestion(value => value === sentQuestion ? '' : value); setTopicDrafts(items => { const draft = items[sentTopic]; return draft && draft.question === sentQuestion ? { ...items, [sentTopic]: { ...draft, question: '' } } : items }) }
    } catch (reason) { if (isCurrent()) setAskError(message(reason)) }
    finally { if (isCurrent()) { pendingQuestionSection.current = null; setAsking(false) } }
  }
  function stopQuestion() { questionAbort.current?.abort(); questionGeneration.current += 1; pendingQuestionSection.current = null; setAsking(false); setAskErrorTopicId(pendingTopicId); setAskError('已停止等待回答，问题已保留；服务端可能仍在完成本次请求，请核对历史后再重试。') }
  async function textRequest<T>(action: (reportId: string, sectionId: string) => Promise<T>): Promise<T> {
    const current = docRef.current, targetSection = currentSection?.id, token = openSequence.current
    if (!editable || !current || !targetSection) throw new Error('当前报告不可编辑，请返回草稿后重试。')
    if (sourcesRestoring || recoverySourceError) throw new Error('请先确认恢复后的资料范围，再重新提问。')
    if (modelUnavailable) throw new Error('模型配置尚未加载，请在 AI 设置中重试，或在研究助手选择仅检索资料。')
    const isCurrent = () => token === openSequence.current && docRef.current?.id === current.id && docRef.current.canEdit && docRef.current.status === 'draft' && docRef.current.sections.some(section => section.id === targetSection)
    setTextRequests(count => count + 1)
    try {
      if (!await flushAll()) throw new Error('报告尚未保存，请处理保存失败后重试。选中文字仍保留。')
      if (!isCurrent()) throw new Error('报告或章节已改变，请重新选择文字。')
      const result = await action(current.id, targetSection)
      if (!isCurrent()) throw new Error('报告或章节已改变，请重新选择文字。')
      return result
    } finally { setTextRequests(count => Math.max(0, count - 1)) }
  }
  async function askSelectedText(question: string, text: string): Promise<Answer> {
    const payload = { conversationId: uid(), question, context: text, sourceIds: [...selectedSources], projectName: projectFilter, ...modelPayload, answerMode }
    const result = await textRequest((id, sectionId) => client.ask(id, { ...payload, sectionId }))
    const answer = { ...result, conversationId: payload.conversationId }
    setAnswers(items => items.some(item => item.id === answer.id) ? items : [...items, answer])
    return answer
  }
  async function polishSelectedText(text: string, instruction: string): Promise<PolishResult> {
    if (!client.polish) throw new Error('当前服务尚未支持文字润色。')
    if (!preview && modelProfileId === 'retrieval') throw new Error('文字润色需要 AI 模型，请在研究助手选择个人模型或企业默认模型。')
    const payload = { text, instruction, ...modelPayload }
    return textRequest((id, sectionId) => client.polish!(id, { ...payload, sectionId }))
  }
  function openChapterAction(id: string, mode: 'menu' | 'rename' | 'delete' = 'menu') {
    const section = docRef.current?.sections.find(item => item.id === id)
    if (!chapterEditable || !section) return
    setChapterName(section.title); setChapterAction({ id, mode })
  }
  function renameChapter() {
    const current = docRef.current, title = chapterName.trim()
    if (!chapterEditable || !current || !chapterAction || !title || title.length > 200) return
    editDoc({ sections: current.sections.map(section => section.id === chapterAction.id ? { ...section, title } : section) })
    setChapterAction(null)
  }
  function confirmChapterDeletion() {
    const current = docRef.current
    if (!chapterEditable || !current || !chapterAction) return
    const result = deleteChapter(current, chapterAction.id)
    if (!result) return
    const removedIndex = current.sections.findIndex(section => section.id === chapterAction.id)
    editDoc(result.patch); setDeletedChapter(result.undo)
    if (currentSection?.id === chapterAction.id) setSectionId(result.patch.sections[Math.min(removedIndex, result.patch.sections.length - 1)].id)
    setChapterAction(null); setSelection(''); setContext(''); setShowContext(false); setInsert(null); setUndo(null); setNotice('')
    if (pendingQuestionSection.current !== null) setAskError('章节已变更，请核对上下文后重新提问。问题已保留。')
    questionGeneration.current += 1; pendingQuestionSection.current = null; setAsking(false)
  }
  function undoChapterDeletion() {
    const current = docRef.current
    if (!chapterEditable || !current || !deletedChapter || current.sections.length >= 60) return
    const patch = restoreChapter(current, deletedChapter)
    if (!patch) { setDeletedChapter(null); return }
    editDoc(patch); setDeletedChapter(null); setNotice('已恢复删除的章节、引用和配方关联，其他章节的后续编辑保持不变。')
  }
  function locateReference(ref: Reference) { if (!ref.sourceId.startsWith('kb:')) { void previewSource(ref.sourceId); return } setLibraryNavigation(previous=>({id:(previous?.id || 0)+1,path:ref.sourceId.slice(3),title:ref.title,excerpt:ref.excerpt})); if(focusWriting)setFocusTool('knowledge');else setPanels(current=>({...current,visible:{...current.visible,knowledge:true}})) }
  async function previewSource(id: string) { await run('read-source', async () => { const source = await client.getSource(id, docRef.current?.id); setSourceOpen(source) }) }
  async function handleLibrarySource(path: string, action: 'ask' | 'cite', excerpt?: { excerpt: string; locator: string; page?: number }) {
    const reportId = docRef.current?.id, token = openSequence.current
    await run('library-source', async () => {
      // A frame only identifies a selection; this request rechecks access and reads the source.
      const source = await client.getSource(`kb:${path}`, reportId)
      if (token !== openSequence.current || docRef.current?.id !== reportId) return
      if (action === 'cite') {
        const current = docRef.current
        if (!current?.canEdit || current.ownerId !== userId || current.status !== 'draft') return
        if (!current.sections.some(section => section.id === currentSection?.id)) throw new Error('目标章节已变更，请重新选择章节后引用。')
        stageSource(source, excerpt); return
      }
      if (docRef.current?.ownerId !== userId) return
      sourceSelectionEpoch.current += 1; recoveringSourceIds.current = []; setSourcesRestoring(false); setRecoverySourceError('')
      setSourceNames(names => ({ ...names, [source.id]: source.title })); setSelectedSources(items => [...new Set([...items, source.id])]); setProjectFilter('')
      setNotice(`已将《${source.title}》加入问答范围。`); showAssistant()
    })
  }
  function stageSource(source: KnowledgeSource, selected?: { excerpt: string; locator: string; page?: number }) {
    if (!currentSection) return
    const text = selected?.excerpt?.trim() || source.content.slice(0, 4000), locator = selected?.excerpt ? `${source.locator ? source.locator+' · ' : ''}原文选段` : source.locator
    // The server validates selected visible text against the authorized Markdown source before saving.
    stageInsert({ content: text, sectionId: currentSection.id, type: '原文引用', refs: [{ id: uid(), sourceId: source.id, title: source.title, excerpt: selected?.excerpt ? text : text.slice(0, 1200), locator, sourceVersion: source.version, sectionId: currentSection.id }] }); setSourceOpen(null)
  }
  function stageInsert(next: NonNullable<typeof insert>) { setInsertCursor(cursorRef.current); setInsertMode('end'); setInsert(next) }
  function confirmInsert() {
    const current = docRef.current
    if (!insert || !current || !current.canEdit || current.ownerId !== userId || current.status !== 'draft') return
    const target = current.sections.find(s => s.id === insert.sectionId)
    if (!target) return
    const refs = insert.refs.map(ref => ({ ...ref, id: uid(), sectionId: target.id }))
    const citation = refs.map(ref => `[依据：${ref.title} · ${ref.sourceVersion} · ${ref.locator || '正文片段'}]`).join('\n')
    const added = `\n\n${insert.type === '待验证项' ? '【待验证假设】\n' : insert.type === 'AI 辅助建议' ? '【AI 辅助建议 · 专家待核对】\n' : ''}${insert.content}${citation ? `\n\n${citation}` : ''}${insert.inlineCardId ? '\n\n' : ''}`
    const inline = insert.inlineCardId ? insertAtInlineAnchor(target.content, inlineCardsRef.current.filter(c => c.sectionId === target.id), insert.inlineCardId, added) : null
    if (insert.inlineCardId && !inline) { setInsert(null); setNotice('问答卡片已移除，请从助手历史重新选择回答。'); return }
    let range: { from: number; to: number }; try { range = inline ? { from: inline.range.from, to: inline.range.from } : insertionRange(target.content, target.id, insertMode, insertCursor) } catch (reason) { setError(message(reason)); return }
    const removed = inline ? '' : target.content.slice(range.from, range.to)
    editDoc({ sections: current.sections.map(s => s.id === target.id ? { ...s, content: inline ? inline.text : s.content.slice(0,range.from) + added + s.content.slice(range.to) } : s), references: [...current.references, ...refs] }, inline ? [...inlineCardsRef.current.filter(c => c.sectionId !== target.id), ...inline.anchors] : undefined)
    setSectionId(target.id); setUndo({ sectionId: target.id, added, offset: range.from, removed, referenceIds: refs.map(r => r.id) }); setInsert(null); setNotice('已插入当前章节并保留来源，请补充适用条件与专家判断。')
  }
  function undoInsert() { if (!undo || !doc) return; const section = doc.sections.find(s => s.id === undo.sectionId); if (!section || undo.offset < 0 || section.content.slice(undo.offset, undo.offset + undo.added.length) !== undo.added) { setNotice('插入内容已被改写，请在正文中手动调整；不会覆盖后续编辑。'); return } const last = undo.offset; editDoc({ sections: doc.sections.map(s => s.id === section.id ? { ...s, content: s.content.slice(0, last) + (undo.removed || '') + s.content.slice(last + undo.added.length) } : s), references: doc.references.filter(ref => !undo.referenceIds.includes(ref.id)), formula: doc.formula.map(row => ({ ...row, evidenceIds: row.evidenceIds.filter(id => !undo.referenceIds.includes(id)) })) }); setUndo(null); setNotice('已撤销本次插入，其他编辑保持不变。') }
  async function versionAction(action: (current: Solution) => Promise<void>) {
    if(versionOperation.current) return
    const id=docRef.current?.id, token=openSequence.current
    if(!id || !await flushAll() || token!==openSequence.current || docRef.current?.id!==id) throw new Error('报告已切换或尚未保存，请重新打开历史版本。')
    versionOperation.current=true;setBusy('version-operation')
    try { await action(docRef.current) } finally { versionOperation.current=false;setBusy('') }
  }
  async function saveNamedVersion(name: string) { await versionAction(async current=>{
    if(!client.snapshot)throw new Error('版本服务暂不可用')
    const token=openSequence.current, saved=await client.snapshot(current.id,current.revision,name)
    if(token!==openSequence.current || docRef.current?.id!==current.id)return
    if(docRef.current.revision===current.revision)replaceDoc({...docRef.current,revision:saved.snapshot.revision})
    const versions=await client.versions(current.id);if(token===openSequence.current&&docRef.current?.id===current.id)setVersions(versions)
  }) }
  async function restoreVersionSection(versionId:string,sectionId:string) {await versionAction(async current=>{
    if(!client.restoreSection)throw new Error('版本服务暂不可用')
    const token=openSequence.current, seq=sequence.current, saved=await client.restoreSection(current.id,versionId,current.revision,sectionId)
    if(token!==openSequence.current || docRef.current?.id!==current.id)return
    if(seq!==sequence.current){setSaveState('conflict');setSaveError('历史章节已在服务端恢复，当前仍有新修改，请比较后保存。');return}
    replaceDoc(saved);setSelection('');cursorRef.current=null;updateInlineCards(inlineCardsRef.current.filter(card=>card.sectionId!==sectionId));setDeletedChapter(null);setSectionId(sectionId)
    const versions=await client.versions(current.id);if(token===openSequence.current&&docRef.current?.id===current.id)setVersions(versions)
    setNotice('历史章节已恢复，其他章节保持不变。')
  })}
  async function restoreVersionReport(version:Version) {await versionAction(async current=>{
    const token=openSequence.current,seq=sequence.current,saved=await client.review(current.id,{action:'restore',revision:current.revision,versionId:version.id,note:`恢复历史版本 v${version.version}`})
    if(token!==openSequence.current || docRef.current?.id!==current.id)return
    if(seq!==sequence.current){setSaveState('conflict');setSaveError('历史报告已在服务端恢复，当前仍有新修改，请比较后保存。');return}
    replaceDoc(saved);setSelection('');cursorRef.current=null;updateInlineCards([]);setDeletedChapter(null);setSectionId(saved.sections[0]?.id||'');setVersions(null)
  })}
  async function changeTopic(topic: TopicMetadata) {
    const id=docRef.current?.id; if(!id || !client.saveTopic) return
    const saved=await client.saveTopic(id,topic); if(docRef.current?.id===id) setTopicMetadata(items=>[...items.filter(item=>item.id!==saved.id),saved])
  }
  async function deleteTopic(topic: TopicMetadata) {
    const id=docRef.current?.id; if(!id || !client.deleteTopic) return
    if(pendingTopicId===topic.id){questionAbort.current?.abort();questionGeneration.current+=1;setAsking(false);pendingQuestionSection.current=null} deletedTopicIds.current.add(topic.id); try { await client.deleteTopic(id,topic.id,topic.revision) } catch(reason) { deletedTopicIds.current.delete(topic.id);throw reason } if(docRef.current?.id!==id)return
    setAnswers(items=>items.filter(item=>answerTopic(item)!==topic.id));setTopicMetadata(items=>items.filter(item=>item.id!==topic.id));setTopicDrafts(items=>Object.fromEntries(Object.entries(items).filter(([key])=>key!==topic.id)));if(activeTopicRef.current===topic.id){setTopicId(uid());setQuestion('');setContext('')}
  }
  function reorderChapter(id: string,target: string) { const current=docRef.current; if(chapterEditable&&current) {const sections=moveChapter(current.sections,id,target);if(sections===current.sections){setNotice('不能移入自己的子章节，且章节层级最多六层。');return}editDoc({sections})} }
  function duplicateChapter(id: string) { const current=docRef.current, source=current?.sections.find(s=>s.id===id); if(!current||!source||!chapterEditable||current.sections.length>=60)return; const next={...source,id:uid(),title:source.title+' · 副本'}; const descendants=chapterDescendants(current.sections,id), index=current.sections.findLastIndex(s=>descendants.has(s.id)); editDoc({sections:[...current.sections.slice(0,index+1),next,...current.sections.slice(index+1)],references:[...current.references,...current.references.filter(r=>r.sectionId===id).map(r=>({...r,id:uid(),sectionId:next.id}))]});setSectionId(next.id);setChapterAction(null) }
  function addChildChapter(id: string) { const current=docRef.current; if(!current||!chapterEditable||current.sections.length>=60||chapterDepth(current.sections,id)>=5)return; const child={id:uid(),title:'新子章节',content:'',parentId:id}; const descendants=chapterDescendants(current.sections,id), index=current.sections.findLastIndex(s=>descendants.has(s.id));editDoc({sections:[...current.sections.slice(0,index+1),child,...current.sections.slice(index+1)]});setSectionId(child.id);setChapterAction(null) }
  async function togglePin(report: Solution) { if(report.ownerId!==userId||!report.canEdit)return; if(docRef.current?.id===report.id&&!await flushAll())return;const current=docRef.current?.id===report.id?docRef.current:report; const saved=await client.save(current.id,{...asInput(current),pinned:!current.pinned,revision:current.revision});if(docRef.current?.id===saved.id){if(docRef.current.revision===current.revision)replaceDoc({...docRef.current,pinned:saved.pinned,revision:saved.revision,updatedAt:saved.updatedAt})}else setSolutions(items=>items.map(item=>item.id===saved.id?saved:item)) }
  const filteredReports=filterReports(solutions,listQuery,reportProject,reportTag,reportSort)
  const displayedReports=groupProjects?[...filteredReports].sort((a,b)=>(a.projectName||'未关联项目').localeCompare(b.projectName||'未关联项目','zh-CN')):filteredReports
  const closeChapterAction = useCallback(() => setChapterAction(null), [])
  const closeImport = useCallback(() => { if (!importPending.current) setImportOpen(false) }, [])
  async function importReport(input: SolutionInput) {
    if (importPending.current) return
    importPending.current = true
    setBusy('import'); setImportError('')
    try {
      if (!await flushAll()) { setImportError('当前报告尚未保存，请先重试保存或处理版本冲突。导入预览已保留。'); return }
      const value = await client.create(input)
      setSolutions(items => [value, ...items.filter(item => item.id !== value.id)])
      setImportOpen(false)
      // A background answer may have changed the original draft during creation.
      if (!await flushAll()) { setNotice('导入报告已创建，可在报告列表中打开；当前报告仍有未保存修改。'); return }
      await openDoc(value.id)
      setNotice('文档已导入为新报告，原报告已保留。')
    } catch (reason) { setImportError(message(reason)) }
    finally { importPending.current = false; setBusy('') }
  }
  const closeCreate = useCallback(() => { setCreateOpen(false); setCopyFrom(undefined) }, []), closeReview = useCallback(() => setReviewAction(null), []), closeInsert = useCallback(() => setInsert(null), []), closeVersions = useCallback(() => { if(!versionOperation.current) setVersions(null) }, []), closePreview = useCallback(() => setSourceOpen(null), []), closeConflict = useCallback(() => setRemoteDoc(null), []), closeMetadata = useCallback(() => setMetadata(false), [])
  return <div ref={appElement} className={`ks-app${focusedWorkspace ? ' ks-focus-writing' : ''}`} data-focus-tool={focusTool || 'none'}>
    <aside className="ks-rail" hidden={focusedWorkspace}><a href={preview ? "/?preview=1" : "/"} className="ks-brand" aria-label="返回工作台"><BookOpenCheck size={24} /></a><span className="ks-rail-line" /><Button className={listOpen ? 'is-active' : ''} aria-label="报告列表" title="报告列表" onClick={() => setListOpen(true)}><List size={21} /></Button><Button className={!listOpen ? 'is-active' : ''} aria-label="撰写报告" title="撰写报告" onClick={() => setListOpen(false)} disabled={!doc}><FileText size={21} /></Button><div className="ks-rail-bottom"><span className="ks-avatar" title={userName}>{userName.slice(0, 1)}</span></div></aside>
    <div className="ks-main"><header className="ks-topbar"><div className="ks-topbar-title"><span className="ks-app-name">研究报告</span><button type="button" className="app-workbench-link ks-report-home" aria-label="研究报告主页" title="研究报告主页" onClick={() => void run('home', async () => { if (!await flushAll()) { setError('当前修改尚未保存，请先处理保存失败后再返回主页。'); return } setListOpen(true) })}><FileText size={15} /><span className="ks-report-home-label">研究报告主页</span><span className="ks-report-home-short" aria-hidden="true">报告主页</span></button>{preview && <span className="ks-demo-badge">演示空间 · 本机保存</span>}</div><div className="ks-top-actions"><Button className="ks-new-report" onClick={() => { setCopyFrom(undefined); setCreateOpen(true) }}><Plus size={15} />新建报告</Button>{!doc && <Button aria-label="导入" title="导入 Word、PDF 或 Markdown" disabled={!!busy || loading} onClick={() => { setImportError(''); setImportOpen(true) }}><Upload size={16} />导入</Button>}{doc && <><Button aria-label="历史版本" title="历史版本" disabled={!!busy} onClick={() => void run('versions', async () => { if (!await flushAll()) return; setVersions(await client.versions(doc.id)) })}><History size={17} /><span className="ks-action-text">历史</span></Button><Button aria-label="导入" title="导入 Word、PDF 或 Markdown" disabled={!!busy || loading} onClick={() => { setImportError(''); setImportOpen(true) }}><Upload size={16} /><span className="ks-action-text">导入</span></Button><ReportExportMenu solution={doc} busy={!!busy} onPrepare={async()=>{const id=doc.id;if(!await flushAll() || docRef.current?.id!==id)throw new Error('报告尚未保存或已切换，请重试导出。');return client.get(id)}} onWordExport={async () => { if (!await flushAll()) throw new Error('报告尚未保存'); await client.exportWord(doc.id) }} />{doc.status === 'in_review' && <Button primary disabled={!!busy} onClick={() => setReviewAction(doc.reviewerId === userId ? 'approve' : 'withdraw')}>{doc.reviewerId === userId ? '评审确认' : '撤回评审'}<CheckCheck size={15} /></Button>}{doc.status === 'final' && doc.ownerId === userId && <Button primary disabled={!!busy} onClick={() => setReviewAction('revise')}>修订报告<Plus size={15} /></Button>}</>}{doc && <div className="ks-global-layout" role="group" aria-label="工作区设置"><Button className="ks-layout-open" aria-label="排列布局" title="排列布局" onClick={() => setLayoutOpen(true)}><LayoutDashboard size={16} /><span className="ks-layout-label">排列布局</span><ChevronDown size={12} /></Button></div>}<ApplicationActions userName={userName} preview={preview} /></div></header>
      {recoveryStorageError && <div className="ks-notice ks-error" role="status">浏览器暂时无法保存研究现场，请保留本页并复制未发送的问题，避免重新登录时丢失。</div>}
      {(sourcesRestoring || recoverySourceError) && <div className="ks-notice" role="status"><span>{sourcesRestoring ? '正在重新核对上次选择的资料权限，完成后可继续提问。' : recoverySourceError}</span><Button onClick={() => { sourceSelectionEpoch.current += 1; recoveringSourceIds.current = []; setSourcesRestoring(false); setRecoverySourceError(''); setSelectedSources([]); setProjectFilter('') }}>清除原范围，使用全部授权资料</Button></div>}
      {error && <div className="ks-notice ks-error" role="alert"><span>{error}</span><Button onClick={() => setError('')} aria-label="关闭错误"><X size={14} /></Button></div>}{notice && <div className="ks-notice" role="status"><Check size={15} /><span>{notice}</span>{undo && editable && <Button onClick={undoInsert}><Undo2 size={14} />撤销插入</Button>}<Button onClick={() => setNotice('')} aria-label="关闭提示"><X size={14} /></Button></div>}
      {deletedChapter && doc && doc.id === deletedChapter.solutionId && !listOpen && <div className="ks-notice ks-chapter-undo" role="status"><Trash2 size={14} /><span>已删除“{deletedChapter.section.title}”及 {deletedChapter.references.length} 条章节引用。{deletedChapter.formulaBindings.length > 0 && ` ${deletedChapter.formulaBindings.length} 个配方项已移除关联并标为待验证。`}附带的 AI 上下文已清除。{doc.sections.length >= 60 && '当前已有 60 章，请先腾出名额再撤销。'}</span><Button disabled={!chapterEditable || doc.sections.length >= 60} title={doc.sections.length >= 60 ? '报告最多保留 60 个章节，请先腾出章节名额' : '恢复最近删除的章节'} onClick={undoChapterDeletion}><Undo2 size={14} />撤销删除</Button></div>}
      {loading ? <div className="ks-loading"><LoaderCircle size={24} className="ks-spin" /><p>正在打开研究报告…</p></div> : listOpen || !doc ? <section className="ks-library-page"><div className="ks-page-intro"><span className="ks-eyebrow">KNOWLEDGE INTO PRACTICE</span><h1>每一个报告，都有据可循。</h1><p>连接论文与实践，让专家思考沉淀为可复用的研究报告。</p></div><div className="ks-section-heading"><h2>我的报告 <span className="ks-count">{solutions.length}</span></h2><div className="ks-report-list-controls"><Button onClick={() => { setTrashOpen(true); setTrashLoading(true); setError(''); void client.trash().then(setTrashedReports).catch(reason => setError(message(reason))).finally(() => setTrashLoading(false)) }}><Trash2 size={15} />回收站</Button><label className="ks-search"><Search size={16} /><input aria-label="搜索报告" placeholder="搜索报告、项目或产品" value={listQuery} onChange={e => setListQuery(e.target.value)} /></label></div></div><div className="ks-report-filters"><select aria-label="按项目筛选" value={reportProject} onChange={e=>setReportProject(e.target.value)}><option value="">全部项目</option>{[...new Set(solutions.map(s=>s.projectName).filter(Boolean))].map(project=><option key={project}>{project}</option>)}</select><select aria-label="按标签筛选" value={reportTag} onChange={e=>setReportTag(e.target.value)}><option value="">全部标签</option>{[...new Set(solutions.flatMap(s=>s.tags||[]))].map(tag=><option key={tag}>{tag}</option>)}</select><select aria-label="报告排序" value={reportSort} onChange={e=>setReportSort(e.target.value)}><option value="updated">最近编辑优先</option><option value="title">按名称排序</option></select><Button onClick={()=>setListView(v=>!v)}>{listView?'卡片视图':'列表视图'}</Button><label><input type="checkbox" checked={groupProjects} onChange={e=>setGroupProjects(e.target.checked)}/>按项目分组</label></div><div className={`ks-solution-grid${listView?' is-list':''}`}>{displayedReports.map((item,index) => <div style={{display:'contents'}} key={item.id}>{groupProjects&&(index===0||displayedReports[index-1].projectName!==item.projectName)&&<h3 className="ks-project-group-title">{item.projectName||'未关联项目'}</h3>}<article key={item.id} className="ks-solution-card"><div className="ks-section-heading"><FileText size={23} /><span className={`ks-status ks-status-${item.status}`}>{statuses[item.status]}</span></div><button className="ks-card-link" onClick={() => void openDoc(item.id)}><h3>{item.title}</h3></button><p>{item.projectName || '未关联项目'} · {item.productName || '未指定产品'}</p><div className="ks-report-tags">{item.tags?.map(tag=><span key={tag}>{tag}</span>)}</div><div className="ks-card-footer"><span>v{item.version} · {dateText(item.updatedAt)}</span><div className="ks-card-actions">{item.ownerId === userId && <Button disabled={!!busy || !item.canEdit} aria-label={`${item.pinned ? '取消置顶' : '置顶'}${item.title}`} title={item.pinned?'取消置顶':'置顶报告'} onClick={()=>void run('pin',()=>togglePin(item))}>{item.pinned?'已置顶':'置顶'}</Button>}{item.ownerId === userId && <Button aria-label={`修改${item.title}名称`} title={item.canEdit && item.status === 'draft' ? '修改报告名称' : '仅作者的草稿可以修改名称'} disabled={!!busy || !item.canEdit || item.status !== 'draft'} onClick={() => { setRenameReport(item); setRenameName(item.title); setRenameError('') }}><Pencil size={15} /></Button>}<Button aria-label={`复制${item.title}`} title="复制报告" onClick={() => { setCopyFrom(item); setCreateOpen(true) }}><Copy size={15} /></Button>{item.ownerId === userId && <Button className="ks-report-delete" aria-label={`删除${item.title}`} title="删除报告" disabled={!!busy} onClick={() => { setError(''); setDeleteReport(item) }}><Trash2 size={16} /></Button>}</div></div></article></div>)}{!displayedReports.length && <p className="ks-muted">没有匹配的报告。</p>}<button className="ks-new-card" onClick={() => { setCopyFrom(undefined); setCreateOpen(true) }}><Plus size={23} /><strong>建立新的研究报告</strong><span>从模板开始，保留每一步思考</span></button></div></section> : <>
        {(saveState === 'error' || saveState === 'conflict') && <div className="ks-notice ks-error" role="alert"><span>{saveError} 当前修改仍保留。</span><Button onClick={() => void flushAll()}>重试保存</Button>{saveState === 'conflict' && <Button onClick={() => void run('compare', async () => setRemoteDoc(await client.get(doc.id)))}>比较服务器版本</Button>}<Button onClick={() => { setCopyFrom(doc); setCreateOpen(true) }}>另存副本</Button></div>}
        {!focusWriting && Object.values(panels.visible).some(value => !value) && <div className="ks-hidden-module-bar"><span>已收起</span><div className="ks-module-legend">{workspaceLayout.order.map((module, index) => !panels.visible[module] && <Button key={module} aria-label={`展开${moduleLabels[module]}`} onClick={() => toggleModule(module)}><b>{index + 1}</b><span>{moduleLabels[module]} · 展开</span></Button>)}</div></div>}
        <div ref={workspaceElement} className={`ks-workspace ks-custom-workspace${focusWriting ? ' ks-focus-workspace' : ''}`} role="region" aria-label="报告工作区" data-arrangement={workspaceLayout.arrangement} data-visible-count={Object.values(visibleModules).filter(Boolean).length} style={getSizedGrid(workspaceLayout, visibleModules, workspaceSizes)}>
          <WorkspaceResizers containerRef={workspaceElement} layout={workspaceLayout} visible={panels.visible} sizes={workspaceSizes} onChange={setWorkspaceSizes} disabled={focusWriting} />
          <nav className="ks-focus-tools" aria-label="写作工具" hidden={!focusWriting}>
            {([{ id: 'outline', label: '章节目录', short: '目录', icon: List }, { id: 'knowledge', label: '知识库资料', short: '知识库', icon: Library }, { id: 'ai', label: 'AI研究助手', short: 'AI助手', icon: Sparkles }, { id: 'references', label: '参考依据', short: '引用', icon: BookOpen }, { id: 'info', label: '报告信息', short: '信息', icon: Info }] as const).map(({ id, label, short, icon: Icon }) => <Button key={id} aria-label={`${focusTool === id ? '收起' : '打开'}${label}`} title={label} aria-pressed={focusTool === id} aria-controls={id === 'outline' ? 'ks-chapter-outline' : id === 'knowledge' ? 'ks-knowledge-content' : id === 'ai' ? 'ks-ai-content' : 'ks-supplement-panel'} onClick={() => openFocusTool(id)}><Icon size={19} /><span>{short}</span></Button>)}

          </nav>
          {(['editor', 'knowledge', 'ai'] as WorkspaceModule[]).map(module => ({
            editor: <section key="editor" {...moduleProps('editor')} className="ks-editor-pane ks-workspace-module" aria-label="撰写报告"><div className="ks-focus-toolbar" hidden={!focusWriting}>
          <div className="ks-focus-report"><FocusModeSwitch active={focusWriting} onChange={toggleFocusMode} /><strong title={doc.title}>{doc.title}</strong><span className={`ks-status ks-status-${doc.status}`}>{statuses[doc.status]}</span><button className={`ks-save-status ks-save-${saveState}`} onClick={() => void flushAll()} disabled={saveState === 'saving'}>{saveState === 'saving' ? <LoaderCircle className="ks-spin" size={14} /> : <CheckCheck size={14} />}{({ saved: preview ? '已保存到本机' : '已保存', dirty: '有修改 · 将自动保存', saving: '保存中…', error: '保存失败 · 重试', conflict: '版本冲突 · 待处理' })[saveState]}</button></div>
          <div className="ks-focus-chapter">{notesClient && <Button disabled={!editable} onClick={()=>setNotesPicker(true)}>我的笔记</Button>}<select aria-label="当前章节" value={currentSection?.id || ''} onChange={event => { setSectionId(event.target.value); setSelection('') }}>{doc.sections.map((section, index) => <option key={section.id} value={section.id}>{String(index + 1).padStart(2, '0')} · {section.title}</option>)}</select>{currentSection && (chapterEditable ? <ChapterTitleInput key={currentSection.id} compact title={currentSection.title} onChange={title => editDoc({ sections: doc.sections.map(section => section.id === currentSection.id ? { ...section, title } : section) })} /> : <strong className="ks-focus-chapter-title">{currentSection.title}</strong>)}<div className="ks-editor-tabs"><button className={!readMode ? 'is-active' : ''} onClick={() => setReadMode(false)}>撰写</button><button className={readMode ? 'is-active' : ''} onClick={() => setReadMode(true)}>预览</button></div><Button aria-label={selection ? '就选中文字提问' : '就本章节提问'} title={selection ? '就选中文字提问' : '就本章节提问'} onClick={askAboutChapter}><Sparkles size={15} /><span>提问</span></Button><Button aria-label="添加专家判断" title="添加专家判断" disabled={!editable} onClick={addExpertJudgment}><Plus size={14} /><span>专家判断</span></Button></div>
        </div><div className="ks-pane-heading" hidden={focusWriting}><div className="ks-writing-identity"><span className="ks-module-number">{workspaceLayout.order.indexOf('editor') + 1}</span><FileText size={16} /><strong className="ks-writing-label">撰写报告</strong><span className="ks-pane-report-title" title={doc.title}>{doc.title}</span><Button aria-label="报告信息" title="项目、作者与报告详情" onClick={() => setMetadata(true)}><Info size={14} /></Button></div><div className="ks-writing-actions"><button aria-label={({ saved: preview ? '已保存到本机' : '已保存', dirty: '有修改 · 将自动保存', saving: '保存中…', error: '保存失败 · 重试', conflict: '版本冲突 · 待处理' })[saveState]} className={`ks-save-status ks-save-${saveState}`} title={`${doc.ownerName} · ${dateText(doc.updatedAt)}`} onClick={() => void flushAll()} disabled={saveState === 'saving'}>{saveState === 'saving' ? <LoaderCircle className="ks-spin" size={14} /> : <CheckCheck size={14} />}<span>{({ saved: preview ? '已保存到本机' : '已保存', dirty: '有修改 · 将自动保存', saving: '保存中…', error: '保存失败 · 重试', conflict: '版本冲突 · 待处理' })[saveState]}</span></button><FocusModeSwitch active={focusWriting} onChange={toggleFocusMode} /><Button aria-label={outlineVisible ? '隐藏章节目录' : '展开章节目录'} title={outlineVisible ? '隐藏章节目录' : '展开章节目录'} aria-expanded={outlineVisible} aria-controls="ks-chapter-outline" onClick={toggleOutline}><List size={15} /><span>{outlineVisible ? '目录' : '展开目录'}</span></Button><Button title="复制报告" aria-label="复制当前报告" onClick={() => { setCopyFrom(doc); setCreateOpen(true) }}><Copy size={15} /></Button><Button title="收起撰写报告" aria-label="收起撰写报告" onClick={() => toggleModule('editor')}><PanelLeftClose size={17} /></Button></div></div><div className="ks-writing-area" ref={writingArea} style={{ '--ks-outline-width': `${panels.outlineWidth}px` } as CSSProperties}><nav id="ks-chapter-outline" className="ks-outline" aria-label="章节目录" hidden={!outlineVisible}><div className="ks-outline-title"><span>章节目录 · {doc.sections.length}</span><Button aria-label="隐藏整个章节目录" title="隐藏章节目录" onClick={toggleOutline}><PanelLeftClose size={13} />隐藏</Button></div>{doc.sections.map((section, index) => <div className={`ks-outline-item ${currentSection?.id === section.id ? 'is-active' : ''}`} key={section.id} draggable={chapterEditable} onDragStart={e=>{setChapterDrag(section.id);e.dataTransfer.setData('text/plain',section.id)}} onDragOver={e=>{if(chapterEditable)e.preventDefault()}} onDrop={e=>{e.preventDefault();if(chapterDrag)reorderChapter(chapterDrag,section.id);setChapterDrag('')}} onDragEnd={()=>setChapterDrag('')} style={{paddingLeft:chapterDepth(doc.sections,section.id)*12}}><button className="ks-outline-link" aria-label={`打开章节：${section.title}`} aria-current={currentSection?.id === section.id ? 'page' : undefined} title={section.title} onClick={() => { setSectionId(section.id); setSelection(''); if (focusWriting) closeFocusTool() }}><span>{String(index + 1).padStart(2, '0')}</span><span className="ks-outline-label">{section.title}</span></button><Button className="ks-chapter-actions-button" aria-label={`章节操作：${section.title}`} title={chapterEditable ? `修改或删除「${section.title}」` : '当前为只读状态，无法修改章节'} disabled={!chapterEditable} onClick={() => openChapterAction(section.id)}><MoreHorizontal size={15} /></Button></div>)}<Button className="ks-add-chapter" aria-label="添加章节" title={doc.sections.length >= 60 ? '报告最多保留 60 个章节' : '添加章节'} disabled={!chapterEditable || doc.sections.length >= 60} onClick={() => { const current = docRef.current; if (!chapterEditable || !current || current.sections.length >= 60) return; const id = uid(); editDoc({ sections: [...current.sections, { id, title: '新章节', content: '' }] }); setSectionId(id) }}><Plus size={14} /><span>添加章节</span></Button><div className="ks-template-tools"><Button disabled={!chapterEditable} onClick={()=>{setTemplateName(doc.title+'章节模板');setTemplateOpen(true)}}>保存章节模板</Button><Button onClick={()=>setFullPreview(true)}>整份预览</Button></div><div className="ks-outline-bottom"><span><BookOpen size={14} />{doc.references.length} 处参考依据</span></div></nav>
            <div className="ks-outline-resizer" hidden={!outlineVisible} role="separator" tabIndex={0} aria-label="调整章节目录宽度" aria-orientation="vertical" aria-valuemin={160} aria-valuemax={360} aria-valuenow={panels.outlineWidth} title="拖动调整目录宽度；也可使用左右方向键" onKeyDown={event => { const delta = event.key === 'ArrowLeft' ? -16 : event.key === 'ArrowRight' ? 16 : 0; if (delta || event.key === 'Home' || event.key === 'End') { event.preventDefault(); setPanels(current => ({ ...current, outlineWidth: clampOutlineWidth(event.key === 'Home' ? 160 : event.key === 'End' ? 360 : current.outlineWidth + delta) })) } }} onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); resizeOutline(event.clientX) }} onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) resizeOutline(event.clientX) }} onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }}><span /></div>
            <div className="ks-paper-scroll"><article className="ks-paper"><div className="ks-paper-meta" hidden={focusWriting}><span>研究报告 / {String(doc.sections.findIndex(s => s.id === currentSection?.id) + 1).padStart(2, '0')}</span><div className="ks-editor-tabs"><button className={!readMode ? 'is-active' : ''} onClick={() => setReadMode(false)}>撰写</button><button className={readMode ? 'is-active' : ''} onClick={() => setReadMode(true)}>预览</button></div></div>{currentSection && <><div className="ks-chapter-heading" hidden={focusWriting}><h2 className="ks-section-title" aria-label={currentSection.title}>{!focusWriting && chapterEditable ? <ChapterTitleInput key={currentSection.id} title={currentSection.title} onChange={title => editDoc({ sections: doc.sections.map(section => section.id === currentSection.id ? { ...section, title } : section) })} /> : currentSection.title}</h2></div><div className="ks-writing-toolbar" hidden={focusWriting}><span>正文</span><span className="ks-divider" /><Button onClick={askAboutChapter}><Sparkles size={14} />{selection ? '就选中文字提问' : '就本章节提问'}</Button><Button disabled={!editable} onClick={addExpertJudgment}>添加专家判断</Button>{notesClient && <Button disabled={!editable} onClick={()=>setNotesPicker(true)}>插入我的笔记</Button>}<Button onClick={()=>setFullPreview(true)}>整份预览</Button></div>{readMode ? <div className="ks-reading-content"><ReportMarkdown>{currentSection.content || '*本章节尚未撰写。*'}</ReportMarkdown></div> : <InlineAssistantEditor reportId={doc.id} onCursorChange={cursor => { cursorRef.current = { ...cursor, sectionId: currentSection.id } }} key={`${doc.id}:${currentSection.id}`} content={currentSection.content} cards={inlineCards.filter(card => card.sectionId === currentSection.id)} modelLabel={modelClient ? modelLabel : undefined} preview={preview} onSaveNote={notesClient ? saveExcerptToNotes : undefined} onAskSelectedText={askSelectedText} onPolishSelectedText={polishSelectedText} onAdoptSelectedAnswer={answer => stageInsert({ content: answer.content, refs: answer.references, sectionId: currentSection.id, type: answer.mode === 'ai' ? 'AI 辅助建议' : '知识摘录' })} disabled={!editable} scope={selectedSources.length ? `已选 ${selectedSources.length} 份资料` : '全部授权资料'} onEdit={editInlineText} onSelection={setSelection} onCreate={createInlineQuestion} onUpdate={updateInlineQuestion} onRemove={removeInlineQuestion} onAsk={id => void askInlineQuestion(id)} onAdopt={stageInlineAnswer} onSource={id => void previewSource(id)} />}<div className="ks-writing-footnote"><span>{currentSection.content.length.toLocaleString()} 字{selection && <small className="ks-selection-count"> · 已选 {selection.length} 字</small>}</span><span>{editable ? '停顿 3 秒自动保存' : '当前版本只读'}</span></div></>}
              <div id="ks-supplement-panel" className="ks-supplement-panel" hidden={focusWriting && !['references', 'info'].includes(focusTool || '')}>
                <div className="ks-supplement-heading" hidden={!focusWriting}><strong>{focusTool === 'references' ? '参考依据' : '报告信息'}</strong><Button aria-label="关闭辅助面板" onClick={closeFocusTool}><X size={17} /></Button></div>
                <div className="ks-supplement-content"><div hidden={focusWriting && focusTool !== 'references'}>
              <section className="ks-references"><Button className="ks-references-toggle" aria-expanded={focusWriting || referencesExpanded} aria-controls="ks-chapter-references" onClick={() => setReferencesExpanded(value => !value)}><span><BookOpen size={14} />本章节参考依据</span><span><span className="ks-count">{doc.references.filter(ref => ref.sectionId === currentSection?.id).length}</span>{referencesExpanded || focusWriting ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span></Button><div id="ks-chapter-references" hidden={!focusWriting && !referencesExpanded}>{doc.references.filter(ref => ref.sectionId === currentSection?.id).map((ref, i) => <div className="ks-reference" key={ref.id}><span>{String(i + 1).padStart(2, '0')}</span><button onClick={() => { locateReference(ref) }}><strong>{ref.title}</strong><small>{ref.sourceVersion} · {ref.locator}</small></button>{editable && <Button aria-label={`删除引用${i + 1}`} onClick={() => { if (window.confirm('删除引用后，请检查正文中的相关论点是否仍有依据。确定删除？')) editDoc({ references: doc.references.filter(item => item.id !== ref.id), formula: doc.formula.map(row => ({ ...row, evidenceIds: row.evidenceIds.filter(id => id !== ref.id) })) }) }}><X size={13} /></Button>}</div>)}{!doc.references.some(ref => ref.sectionId === currentSection?.id) && <p className="ks-empty-small">从知识库或回答中采纳内容，来源将记录在这里。</p>}</div></section></div><div hidden={focusWriting && focusTool !== 'info'}><div className="ks-focus-report-info" hidden={!focusWriting}><h3>{doc.title}</h3><dl><dt>所属项目</dt><dd>{doc.projectName || '未关联项目'}</dd><dt>产品 / 剂型</dt><dd>{doc.productName || '未指定'}</dd><dt>作者</dt><dd>{doc.ownerName}</dd><dt>状态</dt><dd>{statuses[doc.status]} · v{doc.version}</dd><dt>最后更新</dt><dd>{dateText(doc.updatedAt)}</dd></dl>{doc.reviewNotes && <div className="ks-focus-review-note"><strong>评审记录 · {doc.reviewerName || '评审者'}</strong><p>{doc.reviewNotes}</p></div>}<Button disabled={!editable} onClick={() => setMetadata(true)}><Settings2 size={14} />编辑报告信息</Button><Button aria-label="复制当前报告" onClick={() => { setCopyFrom(doc); setCreateOpen(true) }}><Copy size={14} />复制报告</Button></div>
              <div className="ks-document-actions">{doc.status === 'in_review' && doc.reviewerId === userId && <Button onClick={() => setReviewAction('return')}>退回修改</Button>}{doc.status === 'in_review' && doc.ownerId === userId && <Button onClick={() => setReviewAction('withdraw')}>撤回评审</Button>}{doc.status !== 'archived' && doc.status !== 'in_review' && doc.ownerId === userId && <Button onClick={() => setReviewAction('archive')}>归档报告</Button>}</div></div></div>
              </div>
            </article></div></div></section>,
            knowledge: <section key="knowledge" {...moduleProps('knowledge')} className="ks-knowledge-section ks-workspace-module" aria-label="知识库资料面板"><div className="ks-subheading"><div className="ks-subheading-title"><span className="ks-module-number">{workspaceLayout.order.indexOf('knowledge') + 1}</span><BookOpen size={15} /><strong>知识库资料</strong></div><div className="ks-subheading-actions"><Button className="ks-panel-toggle" onClick={() => toggleModule('knowledge')} aria-label={`${visibleModules.knowledge ? '隐藏' : '展开'}知识库资料`} aria-expanded={visibleModules.knowledge} aria-controls="ks-knowledge-content">{visibleModules.knowledge ? <ChevronDown size={13} /> : <ChevronRight size={13} />}{visibleModules.knowledge ? '隐藏' : '展开'}</Button></div></div><div id="ks-knowledge-content" className="ks-knowledge-content" hidden={!visibleModules.knowledge}><KnowledgeLibrary preview={preview} editable={editable} busy={!!busy} canAsk={doc.ownerId === userId} navigateTo={libraryNavigation} onUse={(path, action, quote) => void handleLibrarySource(path, action, quote)} scope={<><div className="ks-scope-foot" title={knowledgeMessage}>{selectedSources.length || projectFilter ? <>{selectedSources.length ? `已选 ${selectedSources.length} 份资料用于问答` : '上次的问答范围'}{projectFilter && ` · 限于${projectFilter}`}{!sourcesRestoring && !recoverySourceError && <Button onClick={() => { sourceSelectionEpoch.current += 1; recoveringSourceIds.current = []; setSourcesRestoring(false); setRecoverySourceError(''); setSelectedSources([]); setProjectFilter('') }}>{projectFilter ? '清除原范围，使用全部授权资料' : '清除选择'}</Button>}</> : <><span className="ks-project-dot" />问答范围：{'全部授权资料'}</>}</div></>} /></div></section>,
            ai: <section key="ai" {...moduleProps('ai')} className="ks-ai-section ks-workspace-module" aria-label="AI研究助手面板"><div className="ks-subheading"><div className="ks-subheading-title"><span className="ks-module-number">{workspaceLayout.order.indexOf('ai') + 1}</span><Sparkles size={16} /><strong>AI 研究助手</strong></div><div className="ks-subheading-actions">{visibleModules.ai && <span className="ks-evidence-label">自动选择回答方式</span>}<Button className="ks-panel-toggle" onClick={() => toggleModule('ai')} aria-label={`${visibleModules.ai ? '隐藏' : '展开'}AI 研究助手`} aria-expanded={visibleModules.ai} aria-controls="ks-ai-content">{visibleModules.ai ? <ChevronDown size={13} /> : <ChevronRight size={13} />}{visibleModules.ai ? '隐藏' : '展开'}</Button></div></div>{modelClient && doc.ownerId === userId && <div className="ks-ai-modelbar"><label><span>回答模型</span><select aria-label="当前 AI 模型" value={modelProfileId} disabled={modelBusy || modelsLoading} onChange={event => { setModelProfileId(event.target.value); setAskError('') }}><option value="system">企业默认模型</option><option value="retrieval">仅检索资料</option>{models.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name} · {modelPriceLabel(profile.provider, profile.baseUrl, profile.model)}{!preview && profile.provider !== 'custom' && !profile.keySet ? '（待填密钥）' : ''}</option>)}</select></label><Button primary className="ks-model-configure" aria-label="AI模型设置" title="添加、编辑与测试我的模型" disabled={modelBusy} onClick={() => setModelSettingsOpen(true)}><Settings2 size={14} />AI模型设置</Button>{preview && <small>本地预览演示自动问答与来源展示，不调用外部模型或联网搜索。</small>}{modelsLoading && <small>正在加载我的模型…</small>}{modelError && <div className="ks-model-load-error" role="status"><span>模型配置加载失败，当前仍可选择“仅检索资料”。</span><Button onClick={() => { setModelLoading(true); setModelReload(value => value + 1) }}>重试加载</Button></div>}</div>}<div id="ks-ai-content" className="ks-ai-content" hidden={!visibleModules.ai}>{doc.ownerId === userId && <><div className="ks-answer-modebar"><AnswerModeControl value={answerMode} onChange={setAnswerMode} disabled={modelBusy} /><Button onClick={() => setShowSearchStatus(value => !value)} aria-expanded={showSearchStatus}>搜索服务{preview ? '演示' : capabilities?.webSearch.configured ? '已就绪' : capabilities ? '未就绪' : '状态待确认'}<ChevronDown size={12} /></Button><small>{selectedSources.length || projectFilter ? '已限定资料范围，本轮仅知识库；清除资料选择或原范围可恢复自动判断。' : '直接提问，助手自动判断是否需要查资料'}</small></div>{showSearchStatus && <div className="ks-search-status"><SearchCapability value={capabilities} preview={preview} /></div>}<ConversationToolbar metadata={topicMetadata} busy={asking} onSave={client.saveTopic?changeTopic:undefined} onDelete={client.deleteTopic?deleteTopic:undefined} topics={topicOptions} activeId={activeTopicId} onSelect={switchConversation} onNew={startConversation} /></>}{asking && pendingTopicId !== activeTopicId && <div className="ks-topic-waiting" role="status">其他主题正在回答，可以先查看当前对话。<Button onClick={stopQuestion}>停止生成</Button></div>}<div className="ks-conversation" aria-live="polite" aria-label="当前主题问答" role="log">{historyError && <div className="ks-error-inline">问答历史加载失败：{historyError}<Button onClick={() => void run('history', async () => { const id = doc.id; const items = await client.history(id); if (docRef.current?.id === id) { setAnswers(items); setHistoryError('') } })}>重试</Button></div>}{doc.ownerId !== userId && <div className="ks-empty-small">问答记录仅作者可见。你可以查阅报告正文与有权访问的资料。</div>}{!topicAnswers.length && doc.ownerId === userId && <div className="ks-ai-welcome"><span className="ks-ai-symbol"><Sparkles size={20} /></span><h3>开始一个新的研究主题</h3><p>可直接提问通用问题，也可查知识库或了解最新研究。<br />查看原文后，再把有价值的内容写入报告。</p><div className="ks-question-suggestions">{['当前章节有哪些相关知识？','现有资料中的结论有哪些差异？'].map(text => <button key={text} onClick={() => { setTopicId(activeTopicId); setQuestion(text); setContext(aiContext(currentSection?.content || '').slice(0, 5000) || ''); setShowContext(true) }}>{text}<ArrowUpRight size={13} /></button>)}</div></div>}{topicAnswers.map(answer => <div className="ks-exchange" key={answer.id}><div className="ks-user-question"><MessageSquare size={14} /><span>{answer.question}</span></div><div className="ks-answer"><div className="ks-answer-label"><Sparkles size={15} /><strong>{answer.mode === 'ai' ? 'AI 辅助分析' : '知识检索结果'}</strong><span>{preview ? '演示' : answer.mode === 'retrieval' ? '未调用生成模型' : answer.model || '依据已选资料'}</span></div><AnswerEvidence answer={answer} preview={preview} part="status" /><Markdown>{answer.content}</Markdown><AnswerEvidence answer={answer} preview={preview} part="sources" referenceOrigin={{ originApp: 'solutions', originId: doc.id, answerId: answer.id }} /><div className="ks-answer-citations">{answer.references.map((ref, i) => <button key={ref.id || i} onClick={() => { locateReference(ref) }}><BookOpen size={12} />{i + 1}. {ref.title}</button>)}</div><div className="ks-answer-actions"><Button className="ks-insert-report" disabled={!editable} onClick={() => stageInsert({ content: answer.content, refs: answer.references, sectionId: currentSection?.id || '', type: answer.mode === 'ai' ? 'AI 辅助建议' : '知识摘录' })}><Plus size={13} />插入报告</Button><Button disabled={!editable} onClick={() => stageInsert({ content: answer.content, refs: answer.references, sectionId: currentSection?.id || '', type: '待验证项' })}>记为待验证</Button><Button aria-label="复制回答" onClick={() => void navigator.clipboard.writeText(answer.content).then(() => setNotice('回答已复制。')).catch(() => setError('浏览器未允许复制，请选择文本手动复制。'))}><Copy size={13} /></Button></div></div></div>)}{asking && pendingTopicId === activeTopicId && <div className="ks-thinking"><LoaderCircle className="ks-spin" size={16} />{preview ? '正在演示自动判断与回答流程…' : '正在判断并查找所需资料…'}<Button onClick={stopQuestion}>停止生成</Button></div>}{askError && (!askErrorTopicId || askErrorTopicId === activeTopicId) && <div className="ks-error-inline" role="alert">问答未完成：{askError}<Button onClick={() => void ask()}>重试提问</Button></div>}<div ref={answerEnd} /></div>
              <div className="ks-question-composer" hidden={doc.ownerId !== userId}><div className="ks-source-chips">{selectedSources.map(id=><span className="ks-source-chip" key={id}><button title="查看资料" onClick={()=>void previewSource(id)}><span>{sourceNames[id] || id.replace(/^kb:/,'').split('/').at(-1)}</span></button><button aria-label={`移除${sourceNames[id]||id}`} onClick={()=>{sourceSelectionEpoch.current+=1;setSelectedSources(items=>items.filter(item=>item!==id))}}>×</button></span>)}</div><div className="ks-context-bar"><button onClick={() => setShowContext(!showContext)}><FileText size={12} />{context ? `附带上下文 · ${context.length} 字` : '不附带正文'}<ChevronDown size={12} /></button><span>{selectedSources.length ? `知识库范围：指定 ${selectedSources.length} 份资料${projectFilter ? ` · 限于${projectFilter}` : ''}` : projectFilter ? `知识库范围：${projectFilter}` : '知识库范围：全部授权资料'}</span></div>{showContext && <div className="ks-context-editor"><div><Button onClick={() => setContext(selection || aiContext(currentSection?.content || '').slice(0, 5000) || '')}>{selection ? '使用当前选区' : '使用当前章节'}</Button><Button onClick={() => setContext('')}>移除上下文</Button></div><textarea aria-label="附带上下文" value={context} maxLength={10000} onChange={e => setContext(e.target.value)} rows={3} placeholder="发送前可查看、修改或移除上下文。" /></div>}<form onSubmit={e => { e.preventDefault(); void ask() }}><textarea ref={questionInput} aria-label="向AI提问" value={question} onChange={e => { setTopicId(activeTopicId); setQuestion(e.target.value) }} maxLength={4000} placeholder={topicAnswers.length ? '继续围绕当前主题提问…' : '输入问题，开始新的研究主题…'} rows={2} onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void ask() } }} /><div className="ks-composer-bottom"><small>AI 辅助查证 · 专家确认后采纳</small><button type="submit" className="ks-send" aria-label="发送问题" disabled={!question.trim() || asking || modelUnavailable}>{asking ? <LoaderCircle size={16} className="ks-spin" /> : <Send size={16} />}</button></div></form></div></div></section>,
          })[module])}
          {!Object.values(visibleModules).some(Boolean) && <div className="ks-workspace-empty"><LayoutDashboard size={30} /><h2>工作区已收起</h2><p>点击上方模块的“展开”继续工作。</p><Button onClick={() => setPanels(current => ({ ...current, visible: { editor: true, knowledge: true, ai: true } }))}>全部展开</Button></div>}
        </div>
      </>}
    </div>
    {modelSettingsOpen && modelClient && <Modal title="AI 模型设置" onClose={closeModelSettings} wide><ModelSettingsPanel client={modelClient} preview={preview} onClose={closeModelSettings} onChange={applyModelSettings} /></Modal>}
    {layoutOpen && <Modal title="排列布局" onClose={closeLayout} wide><LayoutPicker value={workspaceLayout} onClose={closeLayout} onApply={value => { setWorkspaceLayout(value); setFocusWriting(false); setFocusTool(null); setPanels(current => ({ ...current, visible: { editor: true, knowledge: true, ai: true } })); closeLayout() }} /></Modal>}
    {chapterAction && actionSection && doc && <Modal title={chapterAction.mode === 'rename' ? '修改章节名称' : chapterAction.mode === 'delete' ? '删除章节' : '章节操作'} onClose={closeChapterAction}>
      {chapterAction.mode === 'menu' ? <><p className="ks-chapter-dialog-title">{actionSection.title}</p><div className="ks-chapter-menu"><Button disabled={!chapterEditable || doc.sections.length>=60} onClick={()=>duplicateChapter(actionSection.id)}>复制章节</Button><Button disabled={!chapterEditable || doc.sections.length>=60 || chapterDepth(doc.sections,actionSection.id)>=5} onClick={()=>addChildChapter(actionSection.id)}>添加子章节</Button><Button disabled={!chapterEditable || doc.sections.filter(s=>(s.parentId||null)===(actionSection.parentId||null)).findIndex(s=>s.id===actionSection.id)<=0} onClick={()=>{const siblings=doc.sections.filter(s=>(s.parentId||null)===(actionSection.parentId||null)),index=siblings.findIndex(s=>s.id===actionSection.id);if(index>0)reorderChapter(actionSection.id,siblings[index-1].id);setChapterAction(null)}}>上移章节</Button><Button disabled={!chapterEditable || doc.sections.filter(s=>(s.parentId||null)===(actionSection.parentId||null)).at(-1)?.id===actionSection.id} onClick={()=>{const siblings=doc.sections.filter(s=>(s.parentId||null)===(actionSection.parentId||null)),index=siblings.findIndex(s=>s.id===actionSection.id),next=siblings[index+1];if(next)reorderChapter(next.id,actionSection.id);setChapterAction(null)}}>下移章节</Button><Button onClick={() => openChapterAction(actionSection.id, 'rename')} disabled={!chapterEditable}><Pencil size={16} />修改名称</Button><Button onClick={() => openChapterAction(actionSection.id, 'delete')} disabled={!chapterEditable || doc.sections.length <= 1} aria-describedby={doc.sections.length <= 1 ? 'ks-last-chapter-note' : undefined}><Trash2 size={16} />删除章节</Button></div>{doc.sections.length <= 1 && <p id="ks-last-chapter-note" className="ks-muted">报告至少保留一个章节，最后一章不能删除。</p>}</> : chapterAction.mode === 'rename' ? <form onSubmit={event => { event.preventDefault(); renameChapter() }}><label className="ks-field">新章节名称<input autoFocus required maxLength={200} value={chapterName} onChange={event => setChapterName(event.target.value)} /></label><p className="ks-muted">仅修改目录与正文中的章节标题，章节内容保持不变。</p><footer><Button onClick={closeChapterAction}>取消</Button><button type="submit" className="ks-button ks-primary" disabled={!chapterEditable || !chapterName.trim() || chapterName.trim().length > 200}>保存名称</button></footer></form> : <><p className="ks-chapter-dialog-title">删除“{actionSection.title}”？</p><p className="ks-muted">子章节将上移一级并保留。将删除本章正文及 {doc.references.filter(ref => ref.sectionId === actionSection.id).length} 条专属引用。引用了这些依据的配方项将移除关联并恢复为待验证；附带的 AI 上下文和未完成的采纳操作也会清除。</p><p className="ks-muted">删除后可撤销，直至离开本报告或再次删除章节。其他章节内容保持不变。撤销将补回本次移除的配方依据，之后修改的配方字段与验证状态不会被覆盖。</p><footer><Button onClick={closeChapterAction}>取消</Button><Button className="ks-danger" disabled={!chapterEditable || doc.sections.length <= 1} onClick={confirmChapterDeletion}><Trash2 size={14} />确认删除章节</Button></footer></>}
    </Modal>}
    {notesClient && <NoteSelectionCapture root={appElement} selector=".ks-reading-content,.ks-answer" onCapture={saveExcerptToNotes} />}
    {noteDraft && notesClient && <NoteEditor key={noteDraft.id} client={notesClient} draft={noteDraft} onClose={() => setNoteDraft(null)} onSaved={() => { setNoteDraft(null); setNotice('已存入我的笔记。') }} />}
    {importOpen && <Modal title="导入报告" onClose={closeImport} wide><ReportImportForm busy={busy === 'import'} error={importError} onCancel={closeImport} onImport={importReport} /></Modal>}
    {renameReport && <Modal title="修改报告名称" onClose={() => { if (!renameBusy) setRenameReport(null) }}><form onSubmit={event => { event.preventDefault(); void saveReportName() }}><label className="ks-field">报告名称<input autoFocus required maxLength={300} value={renameName} onChange={event => { setRenameName(event.target.value); setRenameError('') }} disabled={renameBusy} /></label>{renameError && <p role="alert" className="ks-report-action-error">{renameError}</p>}<p className="ks-muted">仅修改报告名称，正文、引用和历史版本保持不变。</p><footer><Button disabled={renameBusy} onClick={() => setRenameReport(null)}>取消</Button><button type="submit" className="ks-button ks-primary" disabled={renameBusy || !renameName.trim() || renameName.trim().length > 300}>{renameBusy ? '保存中…' : '保存名称'}</button></footer></form></Modal>}
    {deleteReport && <Modal title="删除研究报告" onClose={() => { if (busy !== 'delete-report') setDeleteReport(null) }}><p>将“{deleteReport.title}”移入回收站？</p>{error && <p role="alert" className="ks-report-action-error">{error}</p>}<p className="ks-muted">报告正文、版本与对话会保留在回收站，可随时恢复；评审者将暂时无法访问。已经发布到资料库的独立资料不会删除。</p><footer><Button disabled={!!busy} onClick={() => setDeleteReport(null)}>取消</Button><Button className="ks-danger" disabled={!!busy} onClick={() => void run('delete-report', async () => { const current = docRef.current; if (current?.id === deleteReport.id && !await flushAll()) { setError('当前报告尚未保存，请先处理保存失败后再删除。'); return } const revision = docRef.current?.id === deleteReport.id ? docRef.current.revision : deleteReport.revision; await client.remove(deleteReport.id, revision); if (docRef.current?.id === deleteReport.id) { docRef.current = null; setDoc(null); dirtyRef.current = false; updateInlineCards([]); try { sessionStorage.removeItem(backupKey(deleteReport.id)) } catch { /* Optional cache. */ } } setSolutions(items => items.filter(item => item.id !== deleteReport.id)); setDeleteReport(null); setNotice('报告已移入回收站，可随时恢复。') })}><Trash2 size={15} />确认删除</Button></footer></Modal>}
    {trashOpen && <Modal title="报告回收站" onClose={() => { if (!busy) setTrashOpen(false) }}><p className="ks-muted">这里显示本人删除的报告，恢复后会重新出现在“我的报告”中。</p>{error && <p role="alert" className="ks-report-action-error">{error}</p>}{trashLoading ? <p>正在加载…</p> : error && !trashedReports.length ? null : trashedReports.length ? <div className="ks-trash-list">{trashedReports.map(item => <div key={item.id} className="ks-trash-item"><div><strong>{item.title}</strong><span>删除于 {dateText(item.deletedAt)}</span></div><Button disabled={!!busy} onClick={() => void run('restore-report', async () => { const restored = await client.restore(item.id, item.revision); setTrashedReports(items => items.filter(entry => entry.id !== item.id)); setSolutions(items => [restored, ...items.filter(entry => entry.id !== restored.id)]); setNotice('报告已恢复。') })}>恢复</Button></div>)}</div> : <p className="ks-muted">回收站暂无报告。</p>}<footer><Button disabled={!!busy} onClick={() => setTrashOpen(false)}>关闭</Button></footer></Modal>}
    {createOpen && <NewSolution templates={templates} original={copyFrom} busy={busy === 'create'} onClose={closeCreate} onCreate={async input => { await run('create', async () => { const rescue = copyFrom?.id === docRef.current?.id && dirtyRef.current && (saveState === 'conflict' || saveState === 'error'); if (!rescue && !await flushAll()) return; const value = await client.create(input); if (rescue) { dirtyRef.current = false; try { sessionStorage.removeItem(backupKey(copyFrom!.id)) } catch { /* Optional cache. */ } } else if (!await flushAll()) { setSolutions(items => [value, ...items]); setNotice('新报告已创建；当前报告仍有未保存修改，请先处理。'); closeCreate(); return } closeCreate(); await openDoc(value.id) }) }} />}
    {reviewAction && doc && <ReviewDialog action={reviewAction} reviewers={reviewers} userId={userId} userName={userName} busy={!!busy} onClose={closeReview} onConfirm={async (note, reviewerId) => { await run('review', async () => { if (!await flushAll() || !docRef.current) return; const value = await client.review(docRef.current.id, { action: reviewAction, revision: docRef.current.revision, note, reviewerId }); replaceDoc(value); closeReview(); setSaveState('saved'); setNotice(`报告${statuses[value.status]}，操作已记录。`) }) }} />}
    {notesPicker && notesClient && <Modal title="从我的笔记插入" onClose={()=>setNotesPicker(false)} wide><ReportNotesPicker client={notesClient} onUse={note=>{if(!currentSection)return;stageInsert({content:`${note.content}\n\n[笔记来源：${note.title.replaceAll('[','').replaceAll(']','')}](/notes?note=${encodeURIComponent(note.id)})`,refs:[],sectionId:currentSection.id,type:'个人笔记'});setNotesPicker(false)}} /></Modal>}
    {fullPreview && doc && <Modal title="整份报告预览" onClose={()=>setFullPreview(false)} wide><div className="ks-full-report"><h1>{doc.title}</h1>{doc.sections.map(section=><section key={section.id}><h2 style={{paddingLeft:chapterDepth(doc.sections,section.id)*12}}>{section.title}</h2><ReportMarkdown>{section.content}</ReportMarkdown></section>)}</div></Modal>}
    {templateOpen && doc && <Modal title="章节模板" onClose={()=>setTemplateOpen(false)}><label className="ks-field">模板名称<input maxLength={100} value={templateName} onChange={e=>setTemplateName(e.target.value)} /></label><p>仅保存章节名称和层级，不包含正文及引用。</p><Button primary disabled={!templateName.trim() || !client.createTemplate || !!busy} onClick={()=>void run('template',async()=>{const created=await client.createTemplate!(templateName.trim(),doc.sections.map(({id,title,parentId})=>({id,title,parentId})));setTemplates(items=>[created,...items]);setTemplateOpen(false);setNotice('模板已保存，新建报告时可选择。')})}>保存模板</Button><h3>已有模板</h3>{templateError&&<p role="alert">{templateError}<Button onClick={()=>void client.templates?.().then(items=>{setTemplates(items);setTemplateError('')}).catch(reason=>setTemplateError(message(reason)))}>重试加载模板</Button></p>}{templates.map(template=><div key={template.id}><span>{template.name}</span><Button disabled={!!busy} onClick={()=>void run('delete-template',async()=>{await client.deleteTemplate?.(template.id);setTemplates(items=>items.filter(item=>item.id!==template.id))})}>删除模板</Button></div>)}</Modal>}
    {sourceOpen && <Modal title="知识资料 · 原文预览" onClose={closePreview} wide><div className="ks-source-preview"><div className="ks-source-meta"><span className="ks-source-kind">{kinds[sourceOpen.kind]}</span><span>{sourceOpen.version} · {sourceOpen.date || '日期未提供'}</span></div><h2>{sourceOpen.title}</h2><p className="ks-muted">{sourceOpen.authors || '作者未提供'} · {sourceOpen.projectName || '未关联项目'}</p><p className="ks-muted">原文位置：{sourceOpen.locator || '正文片段；未提供页码'}</p>{safeUrl(sourceOpen.url) && <a className="ks-text-link" href={safeUrl(sourceOpen.url)} target="_blank" rel="noreferrer">打开原始来源<ArrowUpRight size={14} /></a>}<Markdown>{sourceOpen.content}</Markdown><footer><Button onClick={() => { sourceSelectionEpoch.current += 1; recoveringSourceIds.current = []; setSourcesRestoring(false); setRecoverySourceError(''); setProjectFilter(''); setTopicId(activeTopicId); setSelectedSources([sourceOpen.id]); setQuestion(`请总结《${sourceOpen.title}》中与当前章节相关的依据及适用条件。`); closePreview(); showAssistant() }}><Sparkles size={14} />围绕此资料提问</Button><Button primary disabled={!editable} onClick={() => stageSource(sourceOpen)}>引用到当前章节<Plus size={14} /></Button></footer></div></Modal>}
    {insert && doc && <Modal title={`确认采纳 · ${insert.type}`} onClose={closeInsert} wide><label className="ks-field">{insert.inlineCardId ? '插入到本章问答卡片位置' : '目标章节'}<select disabled={!!insert.inlineCardId} value={insert.sectionId} onChange={e => setInsert({ ...insert, sectionId: e.target.value })}>{doc.sections.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}</select></label>{!insert.inlineCardId&&<label className="ks-field">插入位置<select aria-label="插入位置" value={insertMode} onChange={e=>setInsertMode(e.target.value)}><option value="end">章节末尾</option><option value="cursor" disabled={insertCursor?.sectionId!==insert.sectionId}>光标处</option><option value="after" disabled={!insertCursor?.text || insertCursor.sectionId!==insert.sectionId}>选中文字之后</option><option value="replace" disabled={!insertCursor?.text || insertCursor.sectionId!==insert.sectionId}>替换选中文字</option></select></label>}{insertMode==='replace'&&<div className="ks-insert-preview"><strong>将替换的原文</strong><p>{insertCursor?.text}</p></div>}<label className="ks-field">确认或改写内容<textarea rows={12} value={insert.content} onChange={e => setInsert({ ...insert, content: e.target.value })} /></label><p className="ks-muted">将保留 {insert.refs.length} 条来源记录。请核对事实、适用条件和未验证事项。</p><footer><Button onClick={closeInsert}>取消</Button><Button primary disabled={!editable || !insert.content.trim()} onClick={confirmInsert}>确认插入并保留引用<Check size={15} /></Button></footer></Modal>}
    {versions && doc && <Modal title="历史版本与评审记录" onClose={closeVersions} wide><VersionHistoryPanel doc={doc} versions={versions} busy={!!busy} onSnapshot={saveNamedVersion} onRestoreSection={restoreVersionSection} onRestoreReport={restoreVersionReport} /></Modal>}
    {remoteDoc && doc && <Modal title="比较未保存草稿与服务器版本" onClose={closeConflict} wide><p className="ks-muted">服务器已有其他修改。可将本地内容另存副本，或明确放弃本地修改并载入服务器版本。</p><div className="ks-compare"><section><h3>本地草稿 · revision {doc.revision}</h3>{doc.sections.map(s => <div key={s.id}><h4>{s.title}</h4><pre>{s.content}</pre></div>)}<h4>配方与引用</h4><pre>{JSON.stringify({ formula: doc.formula, references: doc.references }, null, 2)}</pre></section><section><h3>服务器 · revision {remoteDoc.revision}</h3>{remoteDoc.sections.map(s => <div key={s.id}><h4>{s.title}</h4><pre>{s.content}</pre></div>)}<h4>配方与引用</h4><pre>{JSON.stringify({ formula: remoteDoc.formula, references: remoteDoc.references }, null, 2)}</pre></section></div><footer><Button onClick={() => { if (!window.confirm('确认放弃本地未保存修改，载入服务器版本？')) return; dirtyRef.current = false; updateInlineCards([]); replaceDoc(remoteDoc); setDeletedChapter(null); setSaveState('saved'); setSaveError(''); try { sessionStorage.removeItem(backupKey(doc.id)) } catch { /* Optional cache. */ } closeConflict() }}>放弃本地修改并载入</Button><Button primary onClick={() => { setCopyFrom(doc); setCreateOpen(true); closeConflict() }}>将本地内容另存副本</Button></footer></Modal>}
    {metadata && doc && <Modal title="报告信息" onClose={closeMetadata}><label className="ks-field">报告名称<input disabled={!editable} value={doc.title} onChange={e => editDoc({ title: e.target.value })} /></label><label className="ks-field">所属项目<input disabled={!editable} value={doc.projectName} onChange={e => editDoc({ projectName: e.target.value })} /></label><label className="ks-field">产品 / 剂型<input disabled={!editable} value={doc.productName} onChange={e => editDoc({ productName: e.target.value })} /></label><label className="ks-field">标签（用逗号分隔）<input disabled={!editable} key={doc.id} defaultValue={(doc.tags||[]).join(', ')} maxLength={400} onBlur={e=>editDoc({tags:e.target.value.split(/[,，]/).map(tag=>tag.trim()).filter(Boolean)})} /></label><dl className="ks-report-detail-meta"><dt>作者</dt><dd>{doc.ownerName}</dd><dt>版本 / 状态</dt><dd>v{doc.version} · {statuses[doc.status]}</dd><dt>最后更新</dt><dd>{dateText(doc.updatedAt)}</dd></dl>{doc.reviewNotes && <div className="ks-focus-review-note"><strong>评审记录 · {doc.reviewerName || '评审者'}</strong><p>{doc.reviewNotes}</p></div>}<footer><Button primary onClick={closeMetadata}>完成</Button></footer></Modal>}
  </div>
}
