import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { format, parseISO, startOfWeek } from 'date-fns'
import { ArrowUp, History, Settings2 } from 'lucide-react'
import { pmAI, type PMAgentPlan, type PMAgentTarget, type PMAgentTriage, type PMAIContext, type PMAIEvidence, type PMAIRequest, type PMAIRun, type PMAIScenario, type PMAIScope } from '../../api/pmAI'
import { getAIStatus, generateFinanceAIAnalysis } from '../../api/ai'
import { startProjectAnalysis } from '../../api/projectAIWork'
import { asAPIError } from '../../api/client'
import { useAuth } from '../../store/auth'
import { useDataStore } from '../../store/data'
import { findProject, findTask, findSubProject, TODAY } from '../../mock'
import { can } from '../../lib/permissions'
import { assistantMode, type ProjectAssistantMode } from '../../lib/projectAssistantNavigation'
import { refreshAllData } from '../../data/bootstrap'
import type { Task } from '../../types'
import { Button } from '../ui'
import { PMAIActions } from './PMAIActions'
import { PMAssistantDraft } from './PMAssistantDraft'
import { PMAIScheduleCompare } from './PMAIScheduleCompare'
import { PMAssistantSurface } from './PMAssistantSurface'
import { PMAssistantReportResult, type AssistantReport } from './PMAssistantReportResult'

const ProjectAIWorkbench = lazy(() => import('./ProjectAIWorkbench').then(m => ({ default: m.ProjectAIWorkbench })))
const FinanceAIAnalysis = lazy(() => import('../finance/FinanceAIAnalysis').then(m => ({ default: m.FinanceAIAnalysis })))
const AISettingsPanel = lazy(() => import('../settings/AISettingsPanel').then(m => ({ default: m.AISettingsPanel })))
const AgentProposalReview = lazy(() => import('./AgentProposalReview').then(m => ({ default: m.AgentProposalReview })))
const ScheduleAssist = lazy(() => import('../task/ScheduleAssist').then(m => ({ default: m.ScheduleAssist })))
const toolModes = new Set<ProjectAssistantMode>(['assessment', 'finance', 'settings', 'proposal', 'schedule-assist'])
const scenarioNames: Record<PMAIScenario, string> = { priorities: '工作重点', explain: '异常解释', weekly: '项目周报', meeting: '会议记录整理', followup: '措施跟踪' }
const scenarioQuestions: Record<PMAIScenario, string> = { priorities: '当前有哪些需要优先处理的任务？', explain: '当前项目哪些任务可能延期，为什么？', weekly: '整理本周项目周报', meeting: '请整理会议记录并提取待核对的更新', followup: '已有措施落实了吗，还有哪些阻塞？' }
const states: Record<PMAIRun['state'], string> = { queued: '等待整理', running: '正在整理', succeeded: '已完成', failed: '未完成', cancelled: '已停止' }
const pendingRun = (value: PMAIRun | null) => value?.state === 'queued' || value?.state === 'running'
function scopeLabel(scope: PMAIScope, context: PMAIContext | null) {
  return [scope.projectIds.map(id => context?.projects.find(p => p.id === id)?.name ?? findProject(id)?.name ?? id).join('、') || '全部可见项目', scope.taskIds.map(id => context?.tasks.find(t => t.id === id)?.name ?? findTask(id)?.name ?? id).join('、')].filter(Boolean).join(' · ')
}
const runTitle = (run: PMAIRun) => run.request.question.trim() || scenarioNames[run.scenario] || '项目分析'

type ScheduleRequest = { projectId: string; taskId?: string; delays?: number[]; instruction?: string; requestId: number }

export function PMAssistant({ projectId, taskId, taskSnapshot, disabled = false, standalone = false }: { projectId?: string; taskId?: string; taskSnapshot?: Task; disabled?: boolean; standalone?: boolean }) {
  const userId = useAuth(s => s.currentUser?.id)
  const role = useAuth(s => s.currentUser?.role)
  const online = useDataStore(s => s.mode) === 'api'
  const [params] = useSearchParams()
  const requestedRun = params.get('aiRun') || null
  const projectSurface = !!projectId && !taskId
  const rawReport = params.get('agent_report'), rawProposal = params.get('agent_proposal')
  const reportKey = projectSurface && rawReport && /^[0-9a-f]{64}$/.test(rawReport) ? rawReport : null
  const proposalId = projectSurface && rawProposal && /^[a-zA-Z0-9_-]{1,64}$/.test(rawProposal) ? rawProposal : null
  const linkedMode = assistantMode(params.get('assistant'))
  const requestedMode = (taskId && linkedMode && toolModes.has(linkedMode) && linkedMode !== 'schedule-assist' ? null : linkedMode)
    ?? (proposalId ? 'proposal' : reportKey || (projectSurface && params.get('tab') === 'ai') ? 'assessment' : null)
  if (!online || !userId) return null
  return <AssistantPanel key={`${userId}:${role}:${projectId ?? 'all'}:${taskId ?? 'all'}:${requestedRun ?? ''}:${requestedMode ?? ''}`}
    projectId={projectId} taskId={taskId} taskSnapshot={taskSnapshot} userId={userId} disabled={disabled} standalone={standalone}
    requestedRun={requestedRun} requestedMode={requestedMode} reportKey={reportKey} proposalId={proposalId} />
}

function AssistantPanel({ projectId, taskId, taskSnapshot, userId, disabled, standalone, requestedRun, requestedMode, reportKey, proposalId }: {
  projectId?: string; taskId?: string; taskSnapshot?: Task; userId: string; disabled: boolean; standalone: boolean
  requestedRun: string | null; requestedMode: ProjectAssistantMode | null; reportKey: string | null; proposalId: string | null
}) {
  const role = useAuth(s => s.currentUser?.role)
  const date = useDataStore(s => s.businessDate) || format(TODAY, 'yyyy-MM-dd')
  const [params, setParams] = useSearchParams()
  const task = taskId ? (taskSnapshot?.id === taskId ? taskSnapshot : findTask(taskId)) : undefined
  const available = {
    assessment: !taskId && can(role, 'ai.analyze'), finance: !projectId && !taskId && can(role, 'ai.finance'), settings: !taskId && can(role, 'ai.config'),
    proposal: !!projectId && !taskId && !!proposalId,
    'schedule-assist': !!projectId && !!task && findSubProject(task.subProjectId)?.projectId === projectId && (role === 'admin' || role === 'cmc_lead' || (role === 'project_lead' && userId === findProject(projectId)?.ownerId)),
  }
  const canOpen = (mode: ProjectAssistantMode) => !toolModes.has(mode) || ((!disabled || mode === 'schedule-assist') && available[mode as keyof typeof available])
  const initialMode = requestedMode && toolModes.has(requestedMode) && canOpen(requestedMode) ? requestedMode : 'agent'
  const [open, setOpen] = useState(standalone || !!requestedRun || !!requestedMode)
  const [selectedMode, setMode] = useState<ProjectAssistantMode>(initialMode)
  const mode = canOpen(selectedMode) ? selectedMode : 'agent'
  const [draft, setDraft] = useState(requestedMode && requestedMode in scenarioQuestions ? scenarioQuestions[requestedMode as PMAIScenario] : requestedMode === 'schedule' ? taskId ? '比较当前任务分别顺延 2 或 5 个工作日的排期方案' : '比较项目任务的排期方案' : '')
  const [currentQuestion, setCurrentQuestion] = useState('')
  const [context, setContext] = useState<PMAIContext | null>(null)
  const [runs, setRuns] = useState<PMAIRun[]>([])
  const [run, setRun] = useState<PMAIRun | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [pollError, setPollError] = useState('')
  const [readingRun, setReadingRun] = useState(false)
  const [plan, setPlan] = useState<PMAgentPlan | null>(null)
  const [triage, setTriage] = useState<{ result: PMAgentTriage; scope: PMAIScope; question: string } | null>(null)
  const [schedule, setSchedule] = useState<ScheduleRequest | null>(null)
  const [report, setReport] = useState<AssistantReport | null>(null)
  const [lastRequest, setLastRequest] = useState<PMAIRequest | null>(null)
  const [preparedRequest, setPreparedRequest] = useState<PMAIRequest | null>(null)
  const [selection, setSelection] = useState({ id: requestedRun })
  const selectionRef = useRef(selection)
  const requestVersion = useRef(0), loadVersion = useRef(0), alive = useRef(true)
  const input = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { alive.current = true; return () => { alive.current = false; selectionRef.current = { id: null } } }, [])
  const matchesScope = useCallback((value: PMAIRun | PMAIScope) => {
    const scope = 'request' in value ? value.scope ?? value.request : value
    return (!projectId || scope.projectIds.includes(projectId)) && (!taskId || scope.taskIds.includes(taskId))
  }, [projectId, taskId])
  const selectId = useCallback((id: string | null, reading = false) => {
    const next = { id }; selectionRef.current = next; setSelection(next); setReadingRun(reading); return next
  }, [])
  const readRun = useCallback(async (id: string, preserveDraft = false) => {
    requestVersion.current++
    const attempt = selectId(id, true)
    setBusy(false); setPreparedRequest(null); if (!preserveDraft) setDraft('')
    setRun(previous => previous?.id === id ? previous : null); setMode('agent'); setTriage(null); setSchedule(null); setReport(null); setPlan(null); setError(''); setPollError(''); setHistoryOpen(false)
    try {
      const current = await pmAI.get(id)
      if (!alive.current || selectionRef.current !== attempt) return
      if (!matchesScope(current)) { setRun(null); setError('这份分析不属于当前项目或任务，请从原分析入口查看。'); return }
      setRun(current); setCurrentQuestion(runTitle(current)); setLastRequest({ ...current.request, ...(current.scope ?? { projectIds: current.request.projectIds, taskIds: current.request.taskIds }) })
      setRuns(rows => rows.some(r => r.id === current.id) ? rows.map(r => r.id === current.id ? current : r) : [current, ...rows])
    } catch (failure) {
      if (!alive.current || selectionRef.current !== attempt) return
      const e = asAPIError(failure)
      if (e.status === 403 || e.status === 404) { setRun(null); setRuns(rows => rows.filter(r => r.id !== id)) }
      setError(e.detail)
    } finally { if (alive.current && selectionRef.current === attempt) setReadingRun(false) }
  }, [matchesScope, selectId])
  const load = useCallback(async (includeContext = true) => {
    const version = ++loadVersion.current
    const results = await Promise.allSettled([includeContext ? pmAI.context(projectId) : Promise.resolve(null), pmAI.list(projectId, taskId)])
    if (!alive.current || loadVersion.current !== version) return
    const [current, history] = results
    if (current.status === 'fulfilled' && current.value) setContext(current.value)
    if (history.status === 'fulfilled') setRuns(history.value.items.filter(matchesScope))
    setLoadError(current.status === 'rejected' ? asAPIError(current.reason).detail : history.status === 'rejected' ? asAPIError(history.reason).detail : '')
  }, [projectId, taskId, matchesScope])
  useEffect(() => {
    let valid = true
    if (open && !toolModes.has(initialMode)) void Promise.resolve().then(() => { if (valid) return load() })
    return () => { valid = false }
  }, [open, initialMode, load])
  useEffect(() => { let valid = true; if (requestedRun) void Promise.resolve().then(() => { if (valid) return readRun(requestedRun) }); return () => { valid = false } }, [requestedRun, readRun])
  const active = pendingRun(run)
  const runId = run?.id
  useEffect(() => {
    if (!open || !runId || !active || readingRun) return
    let stopped = false; let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const current = await pmAI.get(runId)
        if (stopped || selectionRef.current !== selection) return
        if (!matchesScope(current)) { setRun(null); setError('这份分析不属于当前项目或任务。'); return }
        setRun(current); setPollError(''); setRuns(rows => rows.map(r => r.id === current.id ? current : r))
        if (pendingRun(current)) timer = setTimeout(poll, 2000)
      } catch (failure) {
        if (stopped || selectionRef.current !== selection) return
        const e = asAPIError(failure)
        if (e.status === 403 || e.status === 404) { setRun(null); setError(e.detail); setRuns(rows => rows.filter(r => r.id !== runId)); return }
        setPollError('暂未取得最新状态，正在重试。'); timer = setTimeout(poll, 4000)
      }
    }
    timer = setTimeout(poll, 1000)
    return () => { stopped = true; clearTimeout(timer) }
  }, [open, runId, active, readingRun, selection, matchesScope])

  const canSchedule = (id: string) => role === 'admin' || role === 'cmc_lead' || (role === 'project_lead' && userId === (findProject(id)?.ownerId ?? context?.projects.find(p => p.id === id)?.ownerId))
  const validAttempt = (attempt: number) => alive.current && requestVersion.current === attempt
  const scopeName = taskId ? task?.name ?? '当前任务' : projectId ? findProject(projectId)?.name ?? '当前项目' : '全部可见项目'
  const withinPage = (scope: PMAIScope) => matchesScope(scope) && (!projectId || (scope.projectIds.length === 1 && scope.projectIds[0] === projectId)) && (!taskId || (scope.taskIds.length === 1 && scope.taskIds[0] === taskId))
  function resetCurrent(keepPrepared = false) {
    if (!keepPrepared) setPreparedRequest(null)
    selectId(null); setRun(null); setPlan(null); setTriage(null); setSchedule(null); setReport(null); setError(''); setPollError(''); setCurrentQuestion(''); setHistoryOpen(false); setMode('agent')
  }
  function newQuestion() { requestVersion.current++; setBusy(false); resetCurrent(); setDraft(''); setLastRequest(null); input.current?.focus() }
  async function create(request: PMAIRequest, attempt: number) {
    if (!validAttempt(attempt)) return
    setLastRequest(request)
    const created = await pmAI.create(request)
    if (!validAttempt(attempt)) return
    setLastRequest({ ...request, ...(created.scope ?? { projectIds: request.projectIds, taskIds: request.taskIds }) }); selectId(created.id); setRun(created); setRuns(rows => [created, ...rows.filter(r => r.id !== created.id)]); setMode('agent')
  }
  async function ask(text: string, target?: PMAgentTarget) {
    if (disabled || busy || !text.trim()) return
    const prepared = preparedRequest
    const fullText = text, attempt = ++requestVersion.current
    resetCurrent(!!prepared); setBusy(true); setCurrentQuestion(fullText); setDraft(fullText)
    try {
      if (prepared) {
        if (!withinPage(prepared)) throw new Error('该分析超出当前页面范围，请从原范围打开后调整。')
        const meeting = prepared.scenario === 'meeting'
        if ((prepared.startDate || prepared.endDate) && (!prepared.startDate || !prepared.endDate)) throw new Error('请补齐开始和结束日期，或同时清空日期条件。')
        if (prepared.startDate && prepared.endDate && prepared.startDate > prepared.endDate) throw new Error('开始日期不能晚于结束日期。')
        if ((!meeting && fullText.length > 2000) || (meeting && fullText.length > 16000)) throw new Error(meeting ? '会议材料最多16000字，内容仍保留在输入框。' : '整理要求最多2000字，内容仍保留在输入框。')
        const request = { ...prepared, question: meeting ? prepared.question : fullText, material: meeting ? fullText : prepared.material }
        await create(request, attempt)
        if (validAttempt(attempt)) { setPreparedRequest(null); setDraft('') }
        return
      }
      const value = await pmAI.plan(fullText, projectId ?? target?.projectId, taskId ?? (target?.kind === 'task' ? target.id : undefined))
      if (!validAttempt(attempt)) return
      setPlan(value)
      if (value.status !== 'ready' || !value.scenario) return
      const requestedScope = { projectIds: value.projectIds, taskIds: value.taskIds }
      if (!['settings', 'finance'].includes(value.scenario) && !withinPage(requestedScope)) throw new Error('识别出的对象超出当前页面范围，请重新说明。')
      if (value.scenario === 'settings') {
        if (!available.settings) throw new Error('当前账号或任务范围不能打开 AI 设置。')
        setMode('settings'); setPlan(null); setDraft(''); return
      }
      if (value.scenario === 'finance') {
        if (!available.finance) throw new Error('组合财务需要相应权限及全部项目范围，请先切换项目范围。')
        const status = await getAIStatus(); if (!validAttempt(attempt)) return
        if (!status.ready) throw new Error('请先由有权限的管理员完成 AI 设置。')
        setReport({ kind: 'finance', requestId: attempt, question: fullText, pending: true }); setPlan(null); setDraft('')
        void generateFinanceAIAnalysis(fullText, status.financeAnalysisPrompt).then(result => { if (validAttempt(attempt)) setReport({ kind: 'finance', requestId: attempt, question: fullText, report: result }) }).catch(failure => { if (validAttempt(attempt)) { setError(asAPIError(failure).detail); setDraft(fullText); setReport(null) } })
        return
      }
      if (value.scenario === 'assessment') {
        if (!available.assessment || value.projectIds.length !== 1) throw new Error('请先选择一个有权评估的项目。')
        if (role === 'project_lead' && userId !== (findProject(value.projectIds[0])?.ownerId ?? context?.projects.find(p => p.id === value.projectIds[0])?.ownerId)) throw new Error('项目综合评估由该项目负责人发起，可从历史查看已有报告。')
        if (fullText.length > 1500) throw new Error('综合评估要求请控制在1500字以内，原文仍保留在输入框。')
        const status = await getAIStatus(); if (!validAttempt(attempt)) return
        if (!status.ready) throw new Error('请先由有权限的管理员完成 AI 设置。')
        const job = await startProjectAnalysis(value.projectIds[0], fullText, status.analysisPrompt)
        if (validAttempt(attempt)) { setReport({ kind: 'project', requestId: attempt, question: fullText, projectId: value.projectIds[0], job }); setPlan(null); setDraft('') }
        return
      }
      if (value.scenario === 'priorities') {
        const result = await pmAI.triage(requestedScope, value.limit, !!value.mineOnly, value.taskFilter ?? 'attention')
        if (validAttempt(attempt)) { setTriage({ result, scope: requestedScope, question: fullText }); setPlan(null); setDraft('') }
        return
      }
      if (value.scenario === 'schedule') {
        if (value.projectIds.length !== 1 || value.taskIds.length !== 1) { setPlan({ ...value, status: 'clarify', message: '请明确需要调整的起点任务。' }); return }
        if (!canSchedule(value.projectIds[0])) throw new Error('排期比较与调整由当前项目负责人维护。')
        if (value.scheduleInstruction && !(task?.id === value.taskIds[0] ? task : findTask(value.taskIds[0]))) throw new Error('请先从对应任务详情发起排期推演。')
        setSchedule({ projectId: value.projectIds[0], taskId: value.taskIds[0], delays: value.delays, instruction: value.scheduleInstruction ?? undefined, requestId: attempt })
        setMode('schedule'); setPlan(null); setDraft(''); return
      }
      const meeting = value.scenario === 'meeting'
      if (meeting && !/[:：\n]\s*\S/.test(fullText)) { setPlan({ ...value, status: 'clarify', message: '请在输入框粘贴本次会议记录，我会整理为待核对的更新。' }); return }
      if (!meeting && fullText.length > 2000) throw new Error('问题请控制在2000字以内；较长会议文字可直接粘贴并以“会议记录：”开头。原文仍保留在输入框。')
      const start = value.startDate ?? format(startOfWeek(parseISO(date), { weekStartsOn: 1 }), 'yyyy-MM-dd')
      const end = value.endDate ?? date
      if (!start || !end || start > end) { setPlan({ ...value, status: 'clarify', message: '请补充需要整理的开始和结束日期。' }); return }
      await create({ scenario: value.scenario, ...requestedScope, startDate: start, endDate: end, question: meeting ? '从本次会议记录提取行动项、负责人、日期和待核对变更。' : fullText, material: meeting ? fullText : '' }, attempt)
      if (validAttempt(attempt)) { setPlan(null); setDraft('') }
    } catch (failure) {
      if (validAttempt(attempt)) setError(failure instanceof Error && !('response' in failure) ? failure.message : asAPIError(failure).detail)
    } finally { if (validAttempt(attempt)) setBusy(false) }
  }
  function reuse(request: PMAIRequest, actualScope?: PMAIScope) {
    const restored = { ...request, ...(actualScope ?? { projectIds: request.projectIds, taskIds: request.taskIds }) }
    if (!withinPage(restored)) { setError('该历史分析涉及当前页面以外的项目或任务，请从原范围打开后调整。'); return }
    requestVersion.current++; setBusy(false); resetCurrent(); setLastRequest(restored); setPreparedRequest(restored)
    setDraft(restored.scenario === 'meeting' ? restored.material : restored.question); input.current?.focus()
  }
  async function retryBrief() {
    if (!lastRequest || disabled || busy) return
    if (!withinPage(lastRequest)) { setError('该历史分析超出当前页面范围，请从原范围打开后重新整理。'); return }
    const request = { ...lastRequest, question: `${lastRequest.question}\n请简明回答：最多3项关键结论，建议仅保留必要字段。` }
    if (request.question.length > 2000) { reuse(lastRequest); return }
    const attempt = ++requestVersion.current; resetCurrent(); setBusy(true); setCurrentQuestion(request.question)
    try { await create(request, attempt) } catch (failure) { if (validAttempt(attempt)) setError(asAPIError(failure).detail) } finally { if (validAttempt(attempt)) setBusy(false) }
  }
  async function cancel() {
    if (!run || !pendingRun(run)) return
    const attempt = selectionRef.current; setBusy(true)
    try {
      const cancelled = await pmAI.cancel(run.id)
      if (!alive.current) return
      setRuns(rows => rows.map(r => r.id === cancelled.id ? cancelled : r))
      if (selectionRef.current === attempt) setRun(cancelled)
    } catch (failure) { if (alive.current && selectionRef.current === attempt) setError(asAPIError(failure).detail) }
    finally { if (alive.current && selectionRef.current === attempt) setBusy(false) }
  }
  function closeReview(key: 'agent_report' | 'agent_proposal') {
    const next = new URLSearchParams(params); next.delete(key); next.set('assistant', key === 'agent_report' ? 'assessment' : 'agent'); setParams(next, { replace: true })
  }
  const analysisProject = projectId ?? plan?.projectIds[0]
  const scheduleTask = schedule?.taskId ? (task?.id === schedule.taskId ? task : findTask(schedule.taskId)) : undefined
  const background = runs.filter(item => pendingRun(item) && item.id !== run?.id)
  const showingResult = !!(preparedRequest || currentQuestion || run || triage || schedule || report || toolModes.has(mode) || readingRun)
  return <PMAssistantSurface standalone={standalone} open={open} onToggle={setOpen}>
    {open && <div className="space-y-5 text-sm">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-ink-200 pb-4">
        <div><h2 className="font-semibold text-ink-900">项目助手</h2><p className="mt-1 break-words text-xs text-ink-500">{scopeName}</p></div>
        <div className="flex flex-wrap items-center gap-1">
          {showingResult && <Button size="sm" variant="ghost" onClick={newQuestion}>新问题</Button>}
          <Button size="sm" variant="ghost" aria-expanded={historyOpen} onClick={() => { setHistoryOpen(v => !v); if (!historyOpen) void load(false) }} icon={<History className="h-4 w-4" />}>历史</Button>
          {available.settings && <Button size="sm" variant="ghost" aria-label="助手设置" disabled={disabled} onClick={() => { requestVersion.current++; setBusy(false); resetCurrent(); setMode('settings') }} icon={<Settings2 className="h-4 w-4" />} />}
        </div>
      </header>
      {requestedMode && !canOpen(requestedMode) && <p role="status" className="text-amber-800">{requestedMode === 'finance' && projectId ? '组合财务覆盖全部项目，请将项目范围切换为全部可见项目。' : '当前账号或页面范围不支持所请求的功能。'}</p>}
      {disabled && <p className="text-amber-800">请先保存或放弃当前进展草稿，再生成或应用建议。</p>}
      {historyOpen && <section aria-label="历史记录" className="space-y-3 rounded-lg bg-ink-50 p-3">
        <div className="flex items-center justify-between gap-2"><h3 className="font-medium">最近使用</h3><Button size="sm" variant="ghost" onClick={() => void load(false)}>刷新历史</Button></div>
        {loadError && <p role="status" className="text-amber-800">{loadError}</p>}
        {!runs.length && <p className="text-xs text-ink-500">暂无当前范围的分析记录。</p>}
        <ul className="space-y-1">{runs.map(item => <li key={item.id}><button type="button" onClick={() => void readRun(item.id)} className="w-full rounded p-2 text-left hover:bg-white">
          <span className="block break-words font-medium">{runTitle(item)}</span><span className="mt-1 block break-words text-xs text-ink-500">{scopeLabel(item.scope ?? item.request, context)} · {new Date(item.createdAt).toLocaleString('zh-CN')} · {states[item.state]}</span>
        </button></li>)}</ul>
        <div className="flex flex-wrap gap-2">
          {projectId && available.assessment && <Button size="sm" onClick={() => { requestVersion.current++; resetCurrent(); setMode('assessment') }}>项目综合报告</Button>}
          {available.finance && <Button size="sm" onClick={() => { requestVersion.current++; resetCurrent(); setMode('finance') }}>组合财务报告</Button>}
        </div>
      </section>}
      {!!background.length && <p className="flex flex-wrap items-center gap-2 text-xs text-ink-500">有{background.length}项后台整理尚未完成。<button type="button" className="text-brand-700 underline" onClick={() => void readRun(background[0].id)}>查看进度</button></p>}
      {currentQuestion && <p className="whitespace-pre-wrap break-words rounded-lg bg-brand-50 px-3 py-2 text-ink-700">{currentQuestion.length > 300 ? `${currentQuestion.slice(0, 300)}…` : currentQuestion}</p>}
      {busy && <p role="status" className="text-ink-500">正在处理这次请求…</p>}
      {readingRun && !run && <p role="status">正在读取分析记录…</p>}
      {plan?.status === 'clarify' && !busy && <section aria-label="补充信息" className="space-y-3 rounded-lg bg-amber-50 p-3">
        <p>{plan.message}</p><div className="flex flex-wrap gap-2">{plan.choices.map(target => <Button key={`${target.kind}:${target.id}`} size="sm" disabled={disabled} onClick={() => void ask(currentQuestion, target)}>{target.name}{target.code ? ` · ${target.code}` : ''}{target.kind === 'task' && target.projectName ? ` · ${target.projectName}` : ''}</Button>)}</div>
      </section>}
      {triage && <section aria-label="任务查询结果" className="space-y-3">
        <h3 className="font-medium">{triage.result.totalCandidates ? `找到${triage.result.totalCandidates}项符合条件的任务，当前显示${triage.result.items.length}项` : '当前范围内没有符合条件的任务'}</h3>
        <ul className="divide-y divide-ink-200">{triage.result.items.map(item => <li key={item.taskId} className="space-y-1 py-3">
          <Evidence evidence={{ id: item.taskId, type: 'task', entityId: item.taskId, title: `${item.code} · ${item.name}`, href: item.href, observedAt: triage.result.businessDate }} />
          <p className="break-words text-xs text-ink-600">{item.projectName} · {item.ownerName} · 计划完成{item.plannedEnd} · {item.status}</p><p className="text-xs text-ink-700">{item.reasons.join(' · ')}</p>
        </li>)}</ul>
        {triage.result.totalCandidates > triage.result.items.length && <p className="text-xs text-ink-500">当前显示前{triage.result.items.length}项，可在问题中指定最多20项，或缩小范围。</p>}
        <details><summary className="cursor-pointer text-xs text-ink-500">查看资料范围</summary><p className="mt-2 text-xs text-ink-500">{scopeLabel(triage.scope, context)} · 业务日期{triage.result.businessDate} · 按当前账号权限读取任务和日期规则。</p></details>
      </section>}
      {run && <section aria-label="当前分析结果" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">{active ? states[run.state] : run.state === 'succeeded' ? '整理结果' : run.state === 'cancelled' ? '这次整理已停止' : /截断|输出|长度/.test(run.error) ? '这次内容没有整理完整' : '这次请求未完成'}</h3>
          {active && <Button size="sm" disabled={busy} onClick={() => void cancel()}>停止整理</Button>}
        </div>
        {pollError && <p role="status" className="text-amber-800">{pollError}</p>}
        {active && <p role="status" className="text-ink-500">可以先处理其他问题，结果会保存在历史中。</p>}
        {run.state === 'failed' && <div className="space-y-3"><p>问题和材料已保留，可以调整要求后重新整理。</p><div className="flex flex-wrap gap-2"><Button size="sm" disabled={disabled || busy} onClick={() => void retryBrief()}>重新整理简版</Button><Button size="sm" disabled={disabled || busy} onClick={() => reuse(run.request, run.scope)}>调整要求</Button></div><details><summary className="cursor-pointer text-xs text-ink-500">查看详情</summary><p role="alert" className="mt-2 break-words text-red-700">{run.error}</p></details></div>}
        {run.result && <>{run.scenario === 'weekly' ? <PMAssistantDraft key={run.id} run={run}><AnalysisBody run={run} /></PMAssistantDraft> : <AnalysisBody run={run} />}
          {!!run.result.draftActions.length && <details className="rounded-lg border border-ink-200 p-3"><summary className="cursor-pointer font-medium">核对修改（{run.result.draftActions.length}）</summary><div className="mt-3"><PMAIActions key={run.id} run={run} context={context} userId={userId} disabled={disabled} /></div></details>}
        </>}
        {(run.stale || run.staleReason === 'context_budget') && <p className="text-xs text-amber-800">{run.staleReason === 'context_budget' ? '当前资料规模超过单次核对上限，暂时无法判断结果是否仍然有效。可缩小范围重新分析。' : '分析后数据已有变化，应用建议前会重新核对当前版本。'}</p>}
        {run.source.complete === false && <p className="text-xs text-amber-800">本次资料范围有限，请结合下方依据核对完整情况。</p>}
        <details><summary className="cursor-pointer text-xs text-ink-500">查看资料与依据（{run.source.refs.length}）</summary><div className="mt-2 space-y-2 text-xs text-ink-500"><p>分析范围 {scopeLabel(run.scope ?? run.request, context)}</p><p>数据时间 {run.source.asOf}{run.model ? ` · 模型${run.model}` : ''}</p>{run.source.refs.map(ref => <div key={ref.id}><Evidence evidence={ref} />{ref.excerpt && <p className="mt-1 whitespace-pre-wrap">{ref.excerpt}</p>}</div>)}</div></details>
        {(active || pollError || run.state === 'succeeded' || run.state === 'cancelled') && <div className="flex flex-wrap gap-2">{(active || pollError) && <Button size="sm" onClick={() => void readRun(run.id, true)} disabled={busy}>更新状态</Button>}{!active && run.state !== 'failed' && <Button size="sm" disabled={disabled || busy} onClick={() => reuse(run.request, run.scope)}>调整要求</Button>}</div>}
      </section>}
      {report && <PMAssistantReportResult key={report.job?.id ?? `${report.kind}:${report.requestId}`} value={report} disabled={disabled} />}
      <Suspense fallback={<p role="status">正在打开助手功能…</p>}>
        {mode === 'assessment' && analysisProject && available.assessment && <ProjectAIWorkbench key={analysisProject} projectId={analysisProject} projectName={findProject(analysisProject)?.name ?? '当前项目'} agentReportKey={reportKey} onCloseAgentReport={() => closeReview('agent_report')} />}
        {mode === 'assessment' && !analysisProject && <p role="status">请先选择一个项目，再查看综合报告。</p>}
        {mode === 'finance' && available.finance && <FinanceAIAnalysis />}
        {mode === 'settings' && available.settings && <AISettingsPanel online />}
        {mode === 'proposal' && projectId && proposalId && available.proposal && <AgentProposalReview key={proposalId} projectId={projectId} proposalId={proposalId} onClose={() => closeReview('agent_proposal')} onApplied={refreshAllData} />}
        {mode === 'schedule-assist' && projectId && task && available['schedule-assist'] && <ScheduleAssist key={`${userId}:${projectId}:${task.id}`} userId={userId} projectId={projectId} task={task} editorDirty={disabled} embedded />}
        {mode === 'schedule' && schedule?.instruction && scheduleTask && canSchedule(schedule.projectId) && <ScheduleAssist key={`${schedule.projectId}:${schedule.taskId}:${schedule.requestId}`} userId={userId} projectId={schedule.projectId} task={scheduleTask} editorDirty={disabled} embedded initialInstruction={schedule.instruction} autoPreview />}
      </Suspense>
      {mode === 'schedule' && schedule && !schedule.instruction && <PMAIScheduleCompare key={`${schedule.projectId}:${schedule.taskId}:${schedule.requestId}`} projectId={schedule.projectId} taskId={schedule.taskId} userId={userId} context={context} disabled={disabled} initialDelays={schedule.delays} autoCompare={!!schedule.delays?.length} />}
      {error && <section role="alert" className="space-y-2 rounded-lg bg-red-50 p-3 text-red-800"><p className="font-medium">这次请求未完成</p><p className="break-words">{error}</p><p className="text-xs">内容仍保留在输入框，可调整后重新发送。</p></section>}
      {preparedRequest && <section role="status" aria-label="正在调整此前请求" className="space-y-2 rounded-lg bg-brand-50 p-3 text-xs text-ink-700"><div className="flex flex-wrap items-center justify-between gap-2"><p className="font-medium">正在调整此前请求 · {scenarioNames[preparedRequest.scenario]}</p><Button size="sm" variant="ghost" onClick={newQuestion}>退出调整</Button></div><p className="break-words">范围：{scopeLabel(preparedRequest, context)}</p><p>日期：{preparedRequest.startDate ?? '未限定'} → {preparedRequest.endDate ?? '未限定'}</p><details><summary className="cursor-pointer">调整日期</summary><div className="mt-2 flex flex-wrap gap-3"><label>开始日期<input type="date" className="input mt-1" aria-label="调整开始日期" value={preparedRequest.startDate ?? ''} disabled={busy} onChange={event => setPreparedRequest(previous => previous ? { ...previous, startDate: event.target.value || undefined } : null)} /></label><label>结束日期<input type="date" className="input mt-1" aria-label="调整结束日期" value={preparedRequest.endDate ?? ''} disabled={busy} onChange={event => setPreparedRequest(previous => previous ? { ...previous, endDate: event.target.value || undefined } : null)} /></label></div></details>{preparedRequest.scenario === 'meeting' && <details><summary className="cursor-pointer">查看原整理要求</summary><p className="mt-1 whitespace-pre-wrap break-words">{preparedRequest.question}</p></details>}</section>}
      {mode === 'agent' && <><div className="space-y-2">{!showingResult && <div className="pb-2"><h3 className="text-lg font-medium">这个项目，有什么需要我帮你？</h3><p className="mt-1 text-ink-500">问项目情况、整理材料，也可以直接粘贴会议记录。</p></div>}
        <form className="rounded-xl border border-ink-300 bg-white p-3 focus-within:ring-2 focus-within:ring-brand-400" onSubmit={event => { event.preventDefault(); void ask(draft) }}>
          <label className="sr-only" htmlFor={`pm-assistant-${userId}-${projectId ?? 'all'}-${taskId ?? 'all'}`}>告诉我你想做什么</label>
          <textarea ref={input} id={`pm-assistant-${userId}-${projectId ?? 'all'}-${taskId ?? 'all'}`} aria-label="告诉我你想做什么" className="min-h-20 w-full resize-y bg-transparent text-sm outline-none" maxLength={16000} rows={3} disabled={disabled} value={draft} placeholder="例如：这个项目有哪些延期任务？" onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void ask(draft) } }} />
          <div className="mt-2 flex items-center justify-between gap-3"><span className="text-xs text-ink-500">当前范围 · 按你的权限查看</span><Button size="sm" variant="primary" disabled={disabled || busy || !draft.trim()} type="submit" icon={<ArrowUp className="h-4 w-4" />}>{busy ? '处理中…' : '发送'}</Button></div>
        </form>
      </div>{!showingResult && <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={disabled || busy} onClick={() => void ask(taskId ? '当前任务有哪些工作重点？' : projectId ? '当前项目有哪些需要优先处理的任务？' : '当前有哪些需要优先处理的任务？')}>查看待关注任务</Button>
        <Button size="sm" disabled={disabled || busy} onClick={() => void ask('整理本周项目周报')}>整理本周周报</Button>
        <Button size="sm" disabled={disabled || busy} onClick={() => { setDraft('会议记录：\n'); input.current?.focus() }}>粘贴会议记录</Button>
      </div>}</>}
      <p className="text-xs text-ink-500">查询直接返回，修改由你确认。</p>
    </div>}
  </PMAssistantSurface>
}
function AnalysisBody({ run }: { run: PMAIRun }) {
  if (!run.result) return null
  return <div className="space-y-3"><p className="whitespace-pre-wrap break-words leading-6">{run.result.summary}</p>
    {run.result.findings.slice(0, 3).map((finding, i) => <Finding key={i} finding={finding} refs={run.source.refs} />)}
    {run.result.findings.length > 3 && <details><summary className="cursor-pointer text-brand-700">展开其余{run.result.findings.length - 3}项分析</summary><div className="mt-3 space-y-3">{run.result.findings.slice(3).map((finding, i) => <Finding key={i} finding={finding} refs={run.source.refs} />)}</div></details>}
  </div>
}
function Finding({ finding, refs }: { finding: NonNullable<PMAIRun['result']>['findings'][number]; refs: PMAIEvidence[] }) {
  return <article className="space-y-1 border-b border-ink-100 py-2"><h4 className="font-medium"><span className="mr-2 text-xs font-normal text-ink-500">{{ fact: '记录事实', inference: '分析判断', gap: '资料缺口' }[finding.kind ?? 'inference']}</span>{finding.title}</h4><p className="whitespace-pre-wrap break-words text-ink-700">{finding.detail}</p><div className="flex flex-wrap gap-2">{finding.evidenceIds.map(id => { const ref = refs.find(r => r.id === id); return ref ? <Evidence key={id} evidence={ref} /> : null })}</div></article>
}
function Evidence({ evidence }: { evidence: PMAIEvidence }) {
  if (evidence.href.startsWith('/') && !evidence.href.startsWith('//') && !Array.from(evidence.href).some(c => c === '\\' || c.charCodeAt(0) <= 32)) return <Link to={evidence.href} target="_blank" rel="noreferrer" className="break-words text-brand-700 underline">{evidence.title}</Link>
  return <details><summary className="cursor-pointer text-brand-700">{evidence.title}</summary><p className="mt-2 whitespace-pre-wrap break-words text-ink-700">{evidence.excerpt || '本次提供的会议资料'}</p></details>
}
