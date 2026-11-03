import { readDraft, writeDraft, readPreferences, writePreferences } from './localDrafts'
import { materialSections, selectedMaterial, type MaterialPart } from './materialSections'
import DataScopeNotice from './DataScopeNotice'
import { dataSourceLabel, normalizeDataSources, readDataSources, writeDataSources } from './dataSources'
import type { ApplicationDataSource } from './dataSources'
import { AnswerEvidence, AnswerModeControl, SearchCapability } from '../answerModes/AnswerTools'
import type { AnswerMode } from '../answerModes/types'
import { listenForSearchConfigurationChanges, useSearchCapabilities } from '../answerModes/useSearchCapabilities'
import { modelPriceLabel } from '../../lib/modelPricing'
import ApplicationActions from '../../components/application/ApplicationActions'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowDownToLine, ArrowUp, Bot, Check, ChevronDown, ChevronRight, Copy, ExternalLink, FileText, LoaderCircle, Maximize2, Menu, MessageSquare, Minimize2, MoreHorizontal, PanelLeftClose, PanelRightClose, PanelRightOpen, Paperclip, Plus, RefreshCw, RotateCcw, Search, Settings2, ShieldCheck, Sparkles, Trash2, X } from 'lucide-react'
import { taskSummary } from './client'
import type { AssistantArtifact, AssistantClient, AssistantRequest, AssistantTask, AssistantPreflight, TaskInput, TaskQuestion, TaskSummary } from './client'
import useAssistantRequests from './useAssistantRequests'
import useAssistantConfiguration from './useAssistantConfiguration'
import RequestProgressView from './RequestProgressView'
import type { ModelSettings, ModelSettingsClient } from '../solutions/modelSettings'
import { parseReportFile, REPORT_IMPORT_ACCEPT } from '../solutions/reportImport'
import AssistantDialog from './AssistantDialog'
import TaskForm from './TaskForm'
import Conversation from './Conversation'
import MarkdownView from './MarkdownView'
import './assistant.css'

interface Props { client: AssistantClient; modelClient: ModelSettingsClient; userName: string; preview: boolean; namespace?: string }
interface Draft { question: string; context: string; label: string }
interface ComposerFailure { message: string; configurationRevision?: number; action?: 'data' | 'model' }
const emptyDraft = (): Draft => ({ question: '', context: '', label: '' })
const issue = (reason: unknown) => reason instanceof Error ? reason.message : '操作未完成，请重试。'
function download(artifact: AssistantArtifact) {
  const blob = new Blob([artifact.content], { type: 'text/markdown;charset=utf-8' }), url = URL.createObjectURL(blob), a = document.createElement('a')
  a.href = url; a.download = `${artifact.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'AI助手产物'}.md`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export default function AssistantApp(props: Props) {
  return <AssistantWorkspace key={`${props.namespace || props.userName}:${props.preview ? 'preview' : 'live'}`} {...props} />
}
function AssistantWorkspace({ client, modelClient, userName, preview, namespace = userName }: Props) {
  const preferenceScope = `${namespace}:${preview ? 'preview' : 'live'}`
  const initialPreferences = useRef(readPreferences(preferenceScope))
  const storageKey = `assistant-data-sources:${namespace}:${preview ? 'preview' : 'live'}`
  const { dataSources, setDataSources, answerMode, setAnswerMode, model, setModel, revision: configurationRevision, getSnapshot: configurationSnapshot } = useAssistantConfiguration(() => {
    const preferences = readPreferences(preferenceScope)
    let sources: ApplicationDataSource[] = []
    try { sources = readDataSources(localStorage, storageKey) } catch { /* Start without application data. */ }
    return { dataSources: sources, answerMode: preferences.answerMode || 'auto', model: preferences.model || 'enterprise' }
  })
  const [sourceDraft, setSourceDraft] = useState<ApplicationDataSource[]>(dataSources)
  const [tasks, setTasks] = useState<TaskSummary[]>([]), [total, setTotal] = useState(0), [task, setTask] = useState<AssistantTask | null>(null)
  const [search, setSearch] = useState(''), [trashed, setTrashed] = useState(false), [offset, setOffset] = useState(0), [reload, setReload] = useState(0)
  const [loading, setLoading] = useState(true), [opening, setOpening] = useState(false), [listError, setListError] = useState(''), [taskError, setTaskError] = useState(''), [notice, setNotice] = useState('')
  const [drafts, setDrafts] = useState<Record<string, Draft>>({}), [legacyPending, setPending] = useState<Record<string, boolean>>({}), [errors, setErrors] = useState<Record<string, ComposerFailure | undefined>>({})
  const [modelSettings, setModelSettings] = useState<ModelSettings | null>(null), [modelError, setModelError] = useState('')
  const capabilities = useSearchCapabilities(client, model, modelSettings?.revision)
  const [dialog, setDialog] = useState<'create' | 'settings' | 'data' | 'materials' | 'delete' | 'restore' | null>(null), [formBusy, setFormBusy] = useState(false), [formError, setFormError] = useState('')
  const [sourceView, setSourceView] = useState<{ taskId: string; path: string; title?: string; body?: string; offset?: number; totalChars?: number; nextOffset?: number | null; error?: string; loading?: boolean } | null>(null)
  const sourceSequence = useRef(0)
  const [preflightResult, setPreflight] = useState<{ revision: number; result: AssistantPreflight } | null>(null)
  const preflight = preflightResult?.revision === configurationRevision ? preflightResult.result : null
  const [materialParts, setMaterialParts] = useState<MaterialPart[]>([]), [selectedParts, setSelectedParts] = useState<string[]>([])
  const [actionTarget, setActionTarget] = useState<TaskSummary | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false), [resultOpen, setResultOpen] = useState(true), [resultPeek, setResultPeek] = useState(false), [expanded, setExpanded] = useState(false)
  const [resultTab, setResultTab] = useState<'overview' | 'artifacts'>('overview'), [artifactId, setArtifactId] = useState(''), [materialDraft, setMaterialDraft] = useState(''), [materialLabel, setMaterialLabel] = useState(''), [materialError, setMaterialError] = useState(''), [parsing, setParsing] = useState(false)
  const active = useRef<string | null>(null), alive = useRef(true), openSequence = useRef(0), listSequence = useRef(0), locked = useRef(new Set<string>()), formLock = useRef(false), createId = useRef(crypto.randomUUID())
  const retries = useRef<Record<string, { fingerprint: string; requestId: string }>>({}), importRequest = useRef<AbortController | null>(null), materialInput = useRef<HTMLInputElement>(null), messagesEnd = useRef<HTMLDivElement>(null)
  const moving = useRef(new Set<string>())
  const invalidate = useCallback(() => { openSequence.current++; listSequence.current++; importRequest.current?.abort() }, [])
  useEffect(() => { alive.current = true; return () => { alive.current = false; invalidate() } }, [invalidate])
  const refreshList = () => { setOffset(0); setReload(n => n + 1) }
  function restoreFailedDraft(job: AssistantRequest) {
    if (job.payloadExpired) return
    setDrafts(old => {
      const latest = old[job.taskId]
      return latest && (latest.question.trim() || latest.context) ? old : { ...old, [job.taskId]: { question: job.question, context: job.context, label: job.context ? '本轮资料' : '' } }
    })
  }
  const requests = useAssistantRequests(client, `${namespace}:${preview ? 'preview' : 'live'}`, {
    restore(job) {
      if (job.status === 'failed' || job.status === 'cancelled') { restoreFailedDraft(job); return }
      setDrafts(old => {
        const latest = old[job.taskId]
        return latest?.question.trim() === job.question && latest.context === job.context ? { ...old, [job.taskId]: emptyDraft() } : old
      })
    },
    complete(row) {
      setTasks(old => old.map(item => item.id === row.id ? taskSummary(row) : item)); refreshList()
      if (active.current === row.id) { openSequence.current++; setTask(row); setOpening(false) }
      setErrors(old => ({ ...old, [row.id]: undefined })); delete retries.current[row.id]
    },
    fail(taskId, message, job) {
      if (job?.status === 'failed' || job?.status === 'cancelled') { delete retries.current[taskId]; restoreFailedDraft(job) }
      setErrors(old => ({ ...old, [taskId]: job?.status === 'cancelled' ? undefined : { message } }))
    },
  })
  const resumeRequest = requests.resume
  const pending = { ...legacyPending, ...requests.pending }
  const openTask = useCallback(async (id: string) => {
    const token = ++openSequence.current
    active.current = id; sourceSequence.current++; setSourceView(null); setTask(null); setOpening(true); setTaskError(''); setArtifactId(''); setSidebarOpen(false); setExpanded(false); setResultPeek(false)
    importRequest.current?.abort(); setParsing(false)
    try { const row = await client.get(id); if (alive.current && token === openSequence.current) { setTask(row); setResultTab(row.finalArtifactId ? 'artifacts' : 'overview'); setArtifactId(row.finalArtifactId || ''); setDrafts(old => { const saved = readDraft(preferenceScope, id); return old[id] || !saved ? old : { ...old, [id]: saved } }); const preferences = readPreferences(preferenceScope, id); if (preferences.answerMode) setAnswerMode(preferences.answerMode); if (preferences.model) setModel(preferences.model); try { setDataSources(readDataSources(localStorage, localStorage.getItem(`${storageKey}:${id}`) ? `${storageKey}:${id}` : storageKey)) } catch { /* Selection stays in memory. */ } if (!row.deletedAt) resumeRequest(id) } }
    catch (reason) { if (alive.current && token === openSequence.current) { setTaskError(issue(reason)); setSidebarOpen(true) } }
    finally { if (alive.current && token === openSequence.current) setOpening(false) }
  }, [client, resumeRequest, preferenceScope, storageKey, setAnswerMode, setModel, setDataSources])
  useEffect(() => {
    const token = ++listSequence.current
    let current = true
    const timer = setTimeout(() => {
      setLoading(true); setListError('')
      client.list({ search, trashed, offset }).then(result => {
        if (!current || token !== listSequence.current) return
        setTasks(old => offset ? [...old, ...result.items.filter(t => !old.some(a => a.id === t.id))] : result.items); setTotal(result.total)
        if (!active.current && result.items[0]) void openTask(result.items[0].id)
      }).catch(reason => { if (current && token === listSequence.current) setListError(issue(reason)) }).finally(() => { if (current && token === listSequence.current) setLoading(false) })
    }, search ? 200 : 0)
    return () => { current = false; clearTimeout(timer) }
  }, [client, search, trashed, offset, reload, openTask])
  useEffect(() => {
    let current = true, initialized = false, generation = 0
    const load = () => { const token = ++generation; modelClient.get().then(value => { if (!current || token !== generation) return; setModelSettings(value); setModelError(''); const initialLoad = !initialized; initialized = true; setModel(previous => (!initialLoad || initialPreferences.current.model === 'enterprise') && previous === 'enterprise' || value.profiles.some(p => p.id === previous) ? previous : value.defaultProfileId || 'enterprise') }).catch(() => { if (current && token === generation) setModelError('模型配置暂时无法读取，可打开 AI 模型设置后重试。') }) }
    load(); const stopListening = listenForSearchConfigurationChanges(load)
    return () => { current = false; generation += 1; stopListening() }
  }, [modelClient, preferenceScope, setModel])
  useEffect(() => { if (task) { try { writeDataSources(localStorage, `${storageKey}:${task.id}`, dataSources) } catch { /* In-memory choice remains available. */ } } }, [task, dataSources, storageKey])
  useEffect(() => { for (const [id, value] of Object.entries(drafts)) { if (!writeDraft(preferenceScope, id, value)) { setNotice('浏览器暂时无法保存草稿，请在离开页面前复制重要输入。'); break } } }, [drafts, preferenceScope])
  useEffect(() => { if (!modelSettings) return; const value = { answerMode, model }; writePreferences(preferenceScope, 'default', value); if (task) writePreferences(preferenceScope, task.id, value) }, [answerMode, model, task, preferenceScope, modelSettings])
  useEffect(() => {
    if (!client.preflight) return
    let current = true
    client.preflight({ modelProfileId: model, answerMode, dataSources }).then(value => { if (current && configurationSnapshot().revision === configurationRevision) setPreflight({ revision: configurationRevision, result: value }) }).catch(() => { if (current && configurationSnapshot().revision === configurationRevision) setPreflight({ revision: configurationRevision, result: { ready: true, checks: [{ key: 'connection', status: 'warning', message: '暂时无法检查配置，发送时将再次确认。' }] } }) })
    return () => { current = false }
  }, [client, model, answerMode, dataSources, configurationRevision, configurationSnapshot])
  useEffect(() => { messagesEnd.current?.scrollIntoView?.({ block: 'end' }) }, [task?.id, task?.messageCount])
  useEffect(() => { const keyboard = (event: KeyboardEvent) => { if (event.key === 'Escape' && !dialog) { setSidebarOpen(false); setResultPeek(false); setExpanded(false) } }; document.addEventListener('keydown', keyboard); return () => document.removeEventListener('keydown', keyboard) }, [dialog])
  const draft = task ? drafts[task.id] || emptyDraft() : emptyDraft(), busy = !!task && !!pending[task.id]
  const taskFailure = task ? errors[task.id] : undefined
  const visibleFailure = taskFailure && (taskFailure.configurationRevision === undefined || taskFailure.configurationRevision === configurationRevision) ? taskFailure : undefined
  const artifact = task?.artifacts.find(item => item.id === artifactId) || task?.artifacts.find(item => item.id === task.finalArtifactId) || task?.artifacts.at(-1)
  const artifactAnswer = artifact && task?.messages.find(message => message.role === 'assistant' && message.id === artifact.id)
  const updateDraft = (patch: Partial<Draft>) => { if (!task) return; setDrafts(old => ({ ...old, [task.id]: { ...(old[task.id] || emptyDraft()), ...patch } })) }
  function changeFilter(next: { search?: string; trashed?: boolean }) {
    listSequence.current++; setTasks([]); setOffset(0); setLoading(true)
    if (next.search !== undefined) setSearch(next.search)
    if (next.trashed !== undefined && next.trashed !== trashed) { setTrashed(next.trashed); active.current = null; openSequence.current++; setTask(null); setOpening(false); setTaskError('') }
    setReload(n => n + 1)
  }
  function newTask() { createId.current = crypto.randomUUID(); setFormError(''); setDialog('create') }
  function showArtifact(id: string) { setArtifactId(id); setResultTab('artifacts'); setResultOpen(true); setResultPeek(true) }
  async function copy(text: string) { try { await navigator.clipboard.writeText(text); setNotice('已复制。') } catch { setNotice('复制未完成，请选中文字后复制。') } }
  async function submitTask(input: TaskInput) {
    if (formLock.current) return
    formLock.current = true; setFormBusy(true); setFormError('')
    const target = task, editing = dialog === 'settings'
    try {
      const row = editing && target ? await client.save(target, input) : await client.create({ ...input, id: createId.current })
      if (!alive.current) return
      if (!editing) { try { setDataSources(readDataSources(localStorage, storageKey)) } catch { /* Use the current explicit choice. */ } }
      openSequence.current++; active.current = row.id; setTask(row); setOpening(false); setTrashed(false); setSearch(''); refreshList(); setDialog(null); setSidebarOpen(false)
    } catch (reason) { if (alive.current) setFormError(issue(reason)) }
    finally { formLock.current = false; if (alive.current) setFormBusy(false) }
  }
  async function openSource(taskId: string, path: string, offset = 0) {
    if (!client.getSource) return
    const sequence = ++sourceSequence.current
    setSourceView({ taskId, path, loading: true })
    try { const value = await client.getSource(taskId, path, offset); if (alive.current && sourceSequence.current === sequence && active.current === taskId) setSourceView({ taskId, ...value }) }
    catch (reason) { if (alive.current && sourceSequence.current === sequence) setSourceView({ taskId, path, error: issue(reason) }) }
  }
  async function saveTaskExtras(patch: Partial<TaskInput>) {
    if (!task || busy || formLock.current) return
    const target = task; formLock.current = true; setFormBusy(true)
    try { const row = await client.save(target, { title: target.title, instructions: target.instructions, ...patch }); if (alive.current) { if (active.current === row.id) setTask(row); refreshList(); setNotice('任务设置已保存。') } }
    catch (reason) { if (alive.current) setNotice(issue(reason)) }
    finally { formLock.current = false; if (alive.current) setFormBusy(false) }
  }
  function chooseAction(target: TaskSummary, restore: boolean) {
    if (formLock.current || locked.current.has(target.id) || pending[target.id]) return
    setActionTarget(taskSummary(target)); setFormError(''); setDialog(restore ? 'restore' : 'delete')
  }
  async function move() {
    if (!actionTarget || formLock.current) return
    const target = actionTarget, restore = dialog === 'restore'
    if (locked.current.has(target.id) || pending[target.id]) { setFormError('请等待此任务的回答完成后再操作。'); return }
    formLock.current = true; moving.current.add(target.id); setFormBusy(true); setFormError('')
    try {
      await (restore ? client.restore(target) : client.trash(target))
      if (!alive.current) return
      // A different task may have been opened while this request was pending.
      if (active.current === target.id) {
        active.current = null; openSequence.current++; setTask(null); setOpening(false); setTaskError(''); setArtifactId(''); importRequest.current?.abort(); setParsing(false)
      }
      listSequence.current++; setTasks(old => old.filter(item => item.id !== target.id)); setDialog(null); setActionTarget(null); refreshList()
      setNotice(restore ? '任务已恢复，对话和产物已保留。' : '任务已移至回收站，可从左侧恢复。')
    } catch (reason) { if (alive.current) setFormError(`${issue(reason)} 任务和草稿已保留，可重试；如任务已更新，请返回列表刷新后再操作。`) }
    finally { formLock.current = false; moving.current.delete(target.id); if (alive.current) setFormBusy(false) }
  }
  async function send(options?: { continueFromRequest?: string; question?: string; context?: string; answerMode?: AnswerMode; dataSources?: ApplicationDataSource[]; model?: string }) {
    if (!task || task.deletedAt || pending[task.id] || locked.current.has(task.id) || moving.current.has(task.id)) return
    const settings = configurationSnapshot()
    const target = task, sent = { ...draft, ...(options?.question !== undefined ? { question: options.question, context: options.context || '' } : {}) }, chosenModel = options?.model || settings.value.model, chosenMode = options?.answerMode || settings.value.answerMode, chosenSources = options?.dataSources || settings.value.dataSources
    if (!sent.question.trim() || sent.question.length > 12000 || sent.context.length > 20000) return
    const fingerprint = JSON.stringify([sent.question, sent.context, chosenModel, chosenSources, chosenMode, options?.continueFromRequest]), retry = retries.current[target.id]
    const input: TaskQuestion = { requestId: retry?.fingerprint === fingerprint ? retry.requestId : crypto.randomUUID(), question: sent.question.trim(), context: sent.context, modelProfileId: chosenModel, data_sources: chosenSources, answerMode: chosenMode, ...(options?.continueFromRequest ? { continueFromRequest: options.continueFromRequest } : {}) }
    retries.current[target.id] = { fingerprint, requestId: input.requestId }
    locked.current.add(target.id); setPending(old => ({ ...old, [target.id]: true })); setErrors(old => ({ ...old, [target.id]: undefined }))
    let submitted = false
    const outdated = () => !alive.current || active.current !== target.id || configurationSnapshot().revision !== settings.revision
    try {
      if (client.preflight) {
        const checked = await client.preflight({ modelProfileId: chosenModel, answerMode: chosenMode, dataSources: chosenSources, question: sent.question, taskId: target.id, referenceMaterialAvailable: !!sent.context.trim() })
        if (outdated()) { if (alive.current && active.current === target.id) setNotice('设置已更新，刚才的提问尚未发送，请重新回答。'); return }
        if (!checked.ready) {
          const blocked = checked.checks.filter(check => check.status === 'blocked')
          setErrors(old => ({ ...old, [target.id]: { message: blocked.map(check => check.message).join('；') || checked.message || '请先检查数据与模型设置。', configurationRevision: settings.revision, action: blocked.some(check => ['scope', 'knowledge', 'projects'].includes(check.key)) ? 'data' : 'model' } }))
          return
        }
      }
      if (outdated()) return
      submitted = true
      if (requests.enabled) { await requests.submit(target, input); return }
      const row = await client.send(target, input)
      if (!alive.current) return
      setTasks(old => old.map(item => item.id === row.id ? taskSummary(row) : item)); refreshList()
      if (active.current === target.id) { openSequence.current++; setTask(row); setOpening(false) }
      setDrafts(old => {
        const latest = old[target.id] || emptyDraft()
        return latest.question === sent.question && latest.context === sent.context ? { ...old, [target.id]: emptyDraft() } : old
      })
      delete retries.current[target.id]
    } catch (reason) { if (alive.current && (submitted || !outdated())) setErrors(old => ({ ...old, [target.id]: { message: issue(reason) } })) }
    finally { locked.current.delete(target.id); if (alive.current) setPending(old => ({ ...old, [target.id]: false })) }
  }
  function materials() { if (!task) return; setMaterialParts([]); setSelectedParts([]); setMaterialDraft(draft.context); setMaterialLabel(draft.label); setMaterialError(''); setDialog('materials') }
  async function importMaterial(file?: File) {
    if (!file || !task) return
    importRequest.current?.abort(); const controller = new AbortController(); importRequest.current = controller
    const targetId = task.id
    setParsing(true); setMaterialError('')
    try {
      const parsed = await parseReportFile(file, controller.signal), raw = parsed.input.sections.map(section => section.content).join(''), text = `[资料：${file.name}]\n\n${raw}`
      if (controller.signal.aborted || active.current !== targetId) return
      const parts = materialSections(raw); setMaterialParts(parts); setMaterialLabel(file.name)
      if (text.length > 20000) { setMaterialDraft(''); setSelectedParts([]); setMaterialError('资料已完整解析，请选择本轮所需片段（合计最多 20,000 字）。未选择的部分不会发送。') }
      else { setMaterialDraft(text); setSelectedParts(parts.map(part => part.id)) }
    } catch (reason) { if (!controller.signal.aborted) setMaterialError(issue(reason)) }
    finally { if (!controller.signal.aborted) setParsing(false) }
  }
  const closeDialog = () => { if (formLock.current) return; importRequest.current?.abort(); setParsing(false); setDialog(null); setActionTarget(null) }
  return <div className={`aa-app${sidebarOpen ? ' aa-sidebar-visible' : ''}${resultOpen ? '' : ' aa-result-hidden'}${resultPeek ? ' aa-result-peek' : ''}${expanded ? ' aa-result-expanded' : ''}`}>
    <a className="aa-skip" href="#aa-chat">跳至对话内容</a>
    <header className="aa-topbar"><div className="aa-brand"><button type="button" className="aa-icon-button aa-mobile-menu" aria-label="打开任务导航" onClick={() => setSidebarOpen(v => !v)}><Menu size={19} /></button><span className="aa-brand-mark"><Sparkles size={20} /></span><h1>AI 助手</h1><span className="aa-top-subtitle">个人智能工作空间</span>{preview && <span className="aa-preview-tag">演示空间 · 本机保存</span>}</div><ApplicationActions userName={userName} preview={preview} /></header>
    <div className="aa-shell">
      {sidebarOpen && <button className="aa-sidebar-scrim" aria-label="关闭任务导航" onClick={() => setSidebarOpen(false)} />}
      <aside className="aa-sidebar" aria-label="任务导航"><button className="aa-button aa-new-task" type="button" onClick={newTask}><Plus size={17} />新建任务</button><nav aria-label="助手功能"><button type="button" onClick={() => { setSourceDraft(dataSources); setDialog('data') }}><Settings2 size={18} />数据设置<span>{dataSourceLabel(dataSources)}</span></button><a className="aa-sidebar-model" href={'/model-settings' + (preview ? '?preview=1' : '')} target="_blank" rel="noreferrer"><Settings2 size={18} />AI 模型设置<ExternalLink size={12} /></a><button type="button" className={trashed ? 'is-active' : ''} onClick={() => changeFilter({ trashed: !trashed, search: '' })}><Trash2 size={18} />{trashed ? '返回任务' : '回收站'}</button></nav>
        <div className="aa-task-list-heading"><span>{trashed ? '回收站' : '最近任务'}</span><button type="button" className="aa-icon-button" aria-label="刷新任务列表" onClick={refreshList}><RefreshCw size={13} /></button></div>
        <label className="aa-search"><Search size={14} /><input aria-label="搜索任务" placeholder="搜索任务和对话" maxLength={200} value={search} onChange={event => changeFilter({ search: event.target.value })} /></label>
        <div className="aa-task-list">{listError && <div className="aa-inline-error" role="alert">{listError}<button type="button" onClick={refreshList}>重试</button></div>}{loading && <span className="aa-loading"><LoaderCircle size={14} className="aa-spin" />读取任务…</span>}{tasks.map(item => <div key={item.id} className={`aa-task-row${active.current === item.id ? ' is-selected' : ''}`}><button type="button" className="aa-task-open" aria-label={`打开任务：${item.title}`} onClick={() => void openTask(item.id)} aria-current={active.current === item.id ? 'page' : undefined}><MessageSquare size={14} /><span><strong>{item.pinned ? '置顶 · ' : ''}{item.title}</strong>{item.excerpt && <small className="aa-search-excerpt">{item.excerpt}</small>}</span>{pending[item.id] ? <LoaderCircle size={13} className="aa-spin" /> : <ChevronRight size={12} />}</button><button type="button" className={`aa-icon-button aa-task-action${trashed ? '' : ' aa-task-delete'}`} aria-label={`${trashed ? '恢复' : '删除'}任务：${item.title}`} title={pending[item.id] ? '请等待回答完成后再操作' : trashed ? '恢复任务' : '移至回收站'} disabled={formBusy || !!pending[item.id]} onClick={() => chooseAction(item, trashed)}>{trashed ? <RotateCcw size={15} /> : <Trash2 size={15} />}</button></div>)}{!tasks.length && !loading && !listError && <p className="aa-no-tasks">{search ? '没有匹配的任务' : trashed ? '回收站为空' : '新建任务，开始与 AI 协作。'}</p>}{tasks.length < total && <button className="aa-clear-filter" type="button" disabled={loading} onClick={() => setOffset(tasks.length)}>加载更多任务</button>}</div>
        <div className="aa-profile"><span>{Array.from(userName || '我')[0]}</span><div><strong>{userName}</strong><small><ShieldCheck size={11} />个人工作空间</small></div></div>
      </aside>
      <main className="aa-chat" id="aa-chat">
        <div className="aa-chat-header"><div className="aa-task-heading"><div className="aa-breadcrumb"><span>个人助手</span><ChevronRight size={11} /><span>任务</span></div><h2>{opening ? '正在打开任务…' : task?.title || '今天想完成什么？'}</h2></div><div className="aa-chat-tools">{task && <button type="button" className="aa-icon-button" aria-label="任务设置" title="任务设置" disabled={busy || !!task.deletedAt} onClick={() => { setFormError(''); setDialog('settings') }}><MoreHorizontal size={20} /></button>}<button type="button" className="aa-icon-button aa-desktop-result" aria-label={resultOpen ? '隐藏结果区' : '展开结果区'} title="切换结果区" onClick={() => setResultOpen(v => !v)}>{resultOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}</button><button type="button" className="aa-icon-button aa-mobile-result" aria-label="查看结果区" onClick={() => setResultPeek(true)}><PanelRightOpen size={18} /></button></div></div>
        {notice && <div className="aa-notice" role="status"><Check size={14} /><span>{notice}</span><button type="button" className="aa-icon-button" aria-label="关闭提示" onClick={() => setNotice('')}><X size={13} /></button></div>}
        {taskError && <div className="aa-error" role="alert"><span>{taskError}</span><button type="button" className="aa-button" onClick={() => setSidebarOpen(true)}>任务列表</button>{active.current && <button type="button" className="aa-button" onClick={() => void openTask(active.current!)}>重新打开</button>}</div>}
        <div className="aa-messages" aria-label="任务对话">{!task && !opening && !taskError && <div className="aa-welcome"><span className="aa-welcome-icon"><Sparkles size={29} /></span><h2>把一个想法，变成一份成果</h2><p>与 AI 一起解读资料、整理思路、规划任务和撰写内容。</p><button className="aa-button aa-primary" type="button" onClick={newTask}><Plus size={15} />创建第一项任务</button></div>}{task && !task.messages.length && !busy && <div className="aa-welcome"><span className="aa-welcome-icon"><Bot size={29} /></span><h2>从一个清晰的目标开始</h2><p>告诉助手你想完成什么，也可以先导入资料。</p></div>}{task && <Conversation taskId={task.id} messages={task.messages} artifacts={task.artifacts} userName={userName} onCopy={content => void copy(content)} onArtifact={showArtifact} onSource={path => { if (task) void openSource(task.id, path) }} onReask={(question, context, mode) => { setAnswerMode(mode); void send({ question, context, answerMode: mode }) }} busy={busy} />}{task && requests.progress[task.id] ? <RequestProgressView progress={requests.progress[task.id]} onCancel={client.cancelRequest && requests.progress[task.id].job ? () => requests.cancel(task.id, requests.progress[task.id].job!.requestId) : undefined} onRetry={() => { const job = requests.progress[task.id].job; if (job) void send({ question: job.question, context: job.context }) }} onContinue={() => { const job = requests.progress[task.id].job; if (job) void send({ question: job.question, context: job.context, continueFromRequest: job.requestId, answerMode: job.requestedMode, dataSources: job.dataSources, model: job.modelProfileId || undefined }) }} onCopyDiagnostic={text => void copy(text)} onSettings={() => { setSourceDraft(dataSources); setDialog('data') }} onEditQuestion={() => document.querySelector<HTMLTextAreaElement>('.aa-composer textarea')?.focus()} preview={preview} /> : busy && <div className="aa-thinking" role="status"><LoaderCircle size={16} className="aa-spin" />{preview ? '正在演示自动判断与回答流程…' : '正在判断并查找所需资料…'}</div>}<div ref={messagesEnd} /></div>
        {task?.deletedAt ? <div className="aa-readonly"><Trash2 size={17} /><span>此任务在回收站，对话和产物仍保留。</span><button className="aa-button" type="button" onClick={() => setSidebarOpen(true)}>在任务列表中恢复</button></div> : <div className="aa-composer-wrap">{task && visibleFailure && <div className="aa-error" role="alert">{visibleFailure.message}{visibleFailure.action === 'data' ? <button type="button" className="aa-button" onClick={() => { setSourceDraft(dataSources); setDialog('data') }}>打开数据设置</button> : visibleFailure.action === 'model' ? <a className="aa-button" href={'/model-settings' + (preview ? '?preview=1' : '')} target="_blank" rel="noreferrer">打开 AI 模型设置</a> : <button type="button" className="aa-button" onClick={() => void openTask(task.id)}>刷新任务</button>}</div>}<div className="aa-composer-mode"><AnswerModeControl value={answerMode} onChange={setAnswerMode} disabled={busy} /><small aria-label="当前应用数据范围">应用数据：{dataSourceLabel(dataSources)}</small></div><form className="aa-composer" onSubmit={event => { event.preventDefault(); void send() }}><textarea aria-label="给 AI 助手的任务" placeholder={task ? '描述你想完成的工作，或继续追问…' : '先新建任务，开始与 AI 协作'} value={draft.question} maxLength={12000} disabled={!task || opening} onChange={event => updateDraft({ question: event.target.value })} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); void send() } }} />{draft.context && <div className="aa-attached"><button type="button" onClick={materials}><Paperclip size={13} />{draft.label || '本轮资料'} · {draft.context.length.toLocaleString()} 字</button><button type="button" aria-label="移除本轮资料" onClick={() => updateDraft({ context: '', label: '' })}><X size={12} /></button></div>}<div className="aa-composer-actions"><button className="aa-icon-button" type="button" aria-label="添加任务资料" title="导入或粘贴本轮资料" disabled={!task} onClick={materials}><Plus size={20} /></button>{(draft.question || draft.context) && !busy && <button type="button" className="aa-clear-filter" onClick={() => updateDraft(emptyDraft())}>清空草稿</button>}<span className="aa-composer-spacer" /><label className="aa-model-select"><Bot size={13} /><select aria-label="助手回答模型" value={model} onChange={event => setModel(event.target.value)} disabled={busy}><option value="enterprise">企业默认模型</option>{modelSettings?.profiles.map(profile => <option value={profile.id} key={profile.id}>{profile.name} · {modelPriceLabel(profile.provider, profile.baseUrl, profile.model)}</option>)}</select><ChevronDown size={12} /></label><button className="aa-send" aria-label="发送任务消息" title="发送 · Enter" type="submit" disabled={!task || busy || !draft.question.trim() || opening}>{busy ? <LoaderCircle size={17} className="aa-spin" /> : <ArrowUp size={18} />}</button></div></form>{preflight && <div className="aa-preflight" role="status">{preflight.checks.filter(check => check.status !== 'ready').map(check => <p key={check.key}>{check.message}</p>)}{preflight.ready && preflight.checks.every(check => check.status === 'ready') && <small>配置检查通过；实际可用性以本次请求结果为准。</small>}</div>}{modelError && <p className="aa-model-error" role="status">{modelError}</p>}<p className="aa-disclaimer">{preview ? '本地交互演示 · 不调用外部模型' : 'AI 生成内容请核对后使用'}<span>草稿在此浏览器保留 7 天 · Enter 发送</span></p></div>}
      </main>
      {resultPeek && <button className="aa-result-scrim" aria-label="收起结果区" onClick={() => setResultPeek(false)} />}
      <aside className="aa-result-pane" aria-label="任务结果区"><div className="aa-result-header"><div role="tablist" aria-label="结果内容"><button role="tab" type="button" aria-selected={resultTab === 'overview'} onClick={() => setResultTab('overview')}>概览</button><button role="tab" type="button" aria-selected={resultTab === 'artifacts'} onClick={() => setResultTab('artifacts')}>产物<span>{task?.artifacts.length || 0}</span></button></div><div><button type="button" className="aa-icon-button" aria-label={expanded ? '还原结果区' : '最大化结果区'} onClick={() => setExpanded(v => !v)}>{expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button><button type="button" className="aa-icon-button" aria-label="关闭结果区" onClick={() => { setResultPeek(false); setResultOpen(false); setExpanded(false) }}><PanelLeftClose size={16} /></button></div></div>
        {resultTab === 'overview' ? <div className="aa-result-scroll"><div className="aa-overview-icon"><Sparkles size={24} /></div><h2>{task ? '任务概览' : '你的 AI 工作空间'}</h2><p className="aa-overview-intro">将对话、资料和成果放在同一个任务中，持续推进工作。</p><div className="aa-overview-stats"><div><strong>{Math.floor((task?.messageCount || 0) / 2)}</strong><span>轮对话</span></div><div><strong>{task?.artifacts.length || 0}</strong><span>份产物</span></div></div><section className="aa-overview-section"><h3>任务信息</h3><dl><div><dt>最近更新</dt><dd>{task ? new Date(task.updatedAt).toLocaleString('zh-CN') : '尚未创建'}</dd></div></dl></section><section className="aa-overview-section"><h3>任务指引</h3><p className="aa-pre-wrap">{task?.instructions || '可以在任务设置中写明目标、回答风格及需要注意的事项。'}</p></section><section className="aa-overview-section"><h3>任务摘要</h3><p className="aa-pre-wrap">{task?.memory || '在任务设置中记录已确认的目标与结论，后续对话会使用这份摘要。'}</p></section><section className="aa-overview-section"><h3>本任务资料</h3><p>{task?.messages.filter(m => m.role === 'user' && m.context).length || 0} 轮对话附带了资料，保留在对应消息中。</p></section></div> : <>{task && task.artifacts.length > 0 && <div className="aa-artifact-picker"><FileText size={14} /><select aria-label="选择任务产物" value={artifact?.id || ''} onChange={event => setArtifactId(event.target.value)}>{task.artifacts.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></div>}{artifact ? <><div className="aa-result-scroll aa-document"><div className="aa-document-overline"><FileText size={13} />Markdown 文档<span>{artifact.model}</span></div><h2>{artifact.title}</h2>{artifactAnswer && <AnswerEvidence answer={artifactAnswer} preview={artifactAnswer.mode === 'preview'} part="status" showSourceScope />}<MarkdownView>{artifact.content}</MarkdownView></div><div className="aa-result-footer"><span>{artifact.content.length.toLocaleString()} 字{task?.finalArtifactId === artifact.id ? ' · 最终成果' : ''}</span><button className="aa-button" type="button" disabled={busy || formBusy || !!task?.deletedAt} onClick={() => void saveTaskExtras({ finalArtifactId: task?.finalArtifactId === artifact.id ? null : artifact.id })}>{task?.finalArtifactId === artifact.id ? '取消最终成果' : '设为最终成果'}</button><button className="aa-button" type="button" onClick={() => void copy(artifact.content)}><Copy size={13} />复制</button><button className="aa-button aa-primary" type="button" onClick={() => download(artifact)}><ArrowDownToLine size={13} />导出 Markdown</button></div></> : <div className="aa-result-empty"><FileText size={30} /><h3>成果在这里汇集</h3><p>每轮回答保留在对话中。选择有价值的回答，设为任务最终成果。</p></div>}</>}
      </aside>
    </div>
    {sourceView && <AssistantDialog title={sourceView.title || '知识库原文'} description={sourceView.path} onClose={() => { sourceSequence.current++; setSourceView(null) }} wide>{sourceView.loading ? <p role="status">正在读取有权限的原文…</p> : sourceView.error ? <p role="alert">{sourceView.error}</p> : <><p>第 {(sourceView.offset || 0) + 1}–{(sourceView.offset || 0) + (sourceView.body?.length || 0)} 字 / 共 {sourceView.totalChars} 字</p><div className="aa-source-body"><MarkdownView>{sourceView.body || ''}</MarkdownView></div><div className="aa-form-footer"><button className="aa-button" disabled={!sourceView.offset} onClick={() => void openSource(sourceView.taskId, sourceView.path, Math.max(0, (sourceView.offset || 0) - 8000))}>上一段</button><button className="aa-button" disabled={sourceView.nextOffset == null} onClick={() => void openSource(sourceView.taskId, sourceView.path, sourceView.nextOffset || 0)}>下一段</button></div></>}</AssistantDialog>}
    {(dialog === 'create' || dialog === 'settings') && <AssistantDialog title={dialog === 'create' ? '新建任务' : '任务设置'} description="明确目标，保留对话和每一步成果。" onClose={closeDialog}><TaskForm questions={dialog === 'settings' ? task?.messages.filter(message => message.role === 'user').map(message => message.content) : []} key={dialog === 'create' ? createId.current : task?.id} initial={dialog === 'settings' && task ? { title: task.title, instructions: task.instructions, memory: task.memory, pinned: task.pinned, finalArtifactId: task.finalArtifactId } : { title: '', instructions: '' }} busy={formBusy} error={formError} onSubmit={submitTask} onCancel={closeDialog} /></AssistantDialog>}
    {(dialog === 'delete' || dialog === 'restore') && actionTarget && <AssistantDialog title={dialog === 'restore' ? '恢复任务' : '删除任务'} description={dialog === 'restore' ? '任务将返回最近任务，对话和产物会保留。' : '任务将移至回收站，您可以随时恢复，对话和产物会保留。'} onClose={closeDialog}><p className="aa-delete-title">确定{dialog === 'restore' ? '恢复' : '删除'}「{actionTarget.title}」吗？</p>{formError && <div className="aa-error" role="alert"><span>{formError}</span><button className="aa-button" type="button" disabled={formBusy} onClick={() => { closeDialog(); setSidebarOpen(true); refreshList() }}>返回列表并刷新</button></div>}<div className="aa-form-footer"><span /><button className="aa-button" type="button" disabled={formBusy} onClick={closeDialog}>取消</button><button className={`aa-button ${dialog === 'restore' ? 'aa-primary' : 'aa-delete-confirm'}`} type="button" disabled={formBusy || !!pending[actionTarget.id]} onClick={() => void move()}>{formBusy ? dialog === 'restore' ? '正在恢复…' : '正在删除…' : dialog === 'restore' ? '确认恢复' : '移至回收站'}</button></div></AssistantDialog>}
    {dialog === 'data' && <AssistantDialog title="数据设置" description="选择助手可以查询的应用数据。不选择也能正常提问。" onClose={closeDialog}>
      <DataScopeNotice sources={sourceDraft} />
      <div className="aa-data-sources">{([{ id: 'projects', label: '项目管理', description: '允许按问题需要只读查询你有权限的项目目录、状态与进度' }, { id: 'knowledge', label: '知识库', description: '允许按问题需要查询你有权限的知识库资料' }] as const).map(source => <label key={source.id}><input type="checkbox" checked={sourceDraft.includes(source.id)} onChange={event => setSourceDraft(current => normalizeDataSources(event.target.checked ? [...current, source.id] : current.filter(id => id !== source.id)))} /><span><strong>{source.label}</strong><small>{source.description}</small></span></label>)}</div>
      {answerMode === 'knowledge' && !sourceDraft.includes('knowledge') && <p className="aa-data-requirement" role="note">当前为“仅知识库”，请勾选知识库后保存；不使用知识库时，请将回答方式改为“自动”或“通用回答”。</p>}
      <section className="aa-data-network" aria-label="独立的联网搜索设置"><h3>联网搜索单独判断</h3><p>不勾选应用数据，不代表禁止联网。是否搜索公开网页，由“回答方式”和搜索服务是否可用决定。</p><SearchCapability value={capabilities} preview={preview} /></section>
      <div className="aa-form-footer"><span>保存后用于后续提问，历史回答保持原样</span><button className="aa-button" type="button" onClick={closeDialog}>取消</button><button className="aa-button aa-primary" type="button" onClick={() => { setDataSources(sourceDraft); try { writeDataSources(localStorage, storageKey, sourceDraft) } catch { /* Current session still uses the selection. */ } setNotice(visibleFailure?.configurationRevision !== undefined || busy ? '数据设置已保存，请重新回答。' : '数据设置已保存，将用于后续提问。'); closeDialog() }}>保存设置</button></div>
    </AssistantDialog>}
    {dialog === 'materials' && <AssistantDialog title="本轮任务资料" description="发送问题时，以下正文会随本轮问题一起交给所选模型。" onClose={closeDialog} wide><div className="aa-material-toolbar"><input ref={materialInput} type="file" accept={REPORT_IMPORT_ACCEPT} aria-label="导入助手资料文件" hidden onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; void importMaterial(file) }} /><button className="aa-button" type="button" disabled={parsing} onClick={() => materialInput.current?.click()}>{parsing ? <LoaderCircle size={14} className="aa-spin" /> : <Paperclip size={14} />}导入 Word / PDF / Markdown</button><span>本轮最多 20,000 字</span></div>{materialError && <p className="aa-error" role="alert">{materialError}</p>}{materialParts.length > 0 && <details className="aa-material-parts" open={materialParts.length > 3}><summary>选择资料片段 · 共 {materialParts.length} 段（位置为提取正文字符范围）</summary>{materialParts.map(part => <label key={part.id}><input type="checkbox" checked={selectedParts.includes(part.id)} onChange={event => { const ids = event.target.checked ? [...selectedParts, part.id] : selectedParts.filter(id => id !== part.id); setSelectedParts(ids); setMaterialDraft(selectedMaterial(materialLabel, materialParts, ids)); setMaterialError('') }} /><span>{part.title}<small>第 {part.start + 1}–{part.end} 字</small></span></label>)}</details>}<label className="aa-field">资料正文<textarea rows={12} aria-label="本轮资料正文" maxLength={20000} value={materialDraft} onChange={event => { setMaterialDraft(event.target.value); setMaterialLabel('本轮资料'); setMaterialParts([]); setSelectedParts([]) }} placeholder="导入文件，或直接粘贴与本次任务相关的内容…" /></label><div className="aa-form-footer"><span>{materialDraft.length.toLocaleString()} / 20,000 字</span><button className="aa-button" type="button" onClick={closeDialog}>取消</button><button className="aa-button aa-primary" type="button" disabled={parsing || materialDraft.length > 20000} onClick={() => { updateDraft({ context: materialDraft, label: materialDraft ? materialLabel || '本轮资料' : '' }); closeDialog() }}>应用资料</button></div>{task && task.messages.some(m => m.context) && <div className="aa-history-materials"><h3>已用于历史对话的资料</h3>{task.messages.filter(m => m.role === 'user' && m.context).map(m => <details key={m.id}><summary>{m.content.slice(0, 65)} · {m.context.length.toLocaleString()} 字</summary><pre>{m.context}</pre></details>)}</div>}</AssistantDialog>}
  </div>
}
