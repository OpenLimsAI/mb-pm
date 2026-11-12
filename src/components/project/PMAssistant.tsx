import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { format, parseISO, subDays } from 'date-fns'
import { Sparkles } from 'lucide-react'
import {
  pmAI,
  type PMAIContext,
  type PMAIEvidence,
  type PMAIRequest,
  type PMAIRun,
  type PMAIScenario,
  type PMAIScope,
} from '../../api/pmAI'
import { asAPIError } from '../../api/client'
import { useAuth } from '../../store/auth'
import { useDataStore } from '../../store/data'
import { findProject, findTask, TODAY } from '../../mock'
import { Button } from '../ui'
import { PMAgent, type AgentRequest } from './PMAgent'
import { PMAIActions } from './PMAIActions'
import { PMAIScheduleCompare } from './PMAIScheduleCompare'

const scenarios: Record<PMAIScenario, { name: string; prompt: string }> = {
  priorities: {
    name: '工作重点',
    prompt: '当前最需要处理哪些事项？请按优先顺序说明依据。',
  },
  explain: { name: '异常解释', prompt: '哪些任务或风险可能影响目标，为什么？' },
  weekly: {
    name: '项目周报',
    prompt: '按所选时间范围整理项目周报和待决定事项。',
  },
  meeting: {
    name: '纪要转更新',
    prompt: '提取纪要中的行动项、负责人、日期和待核对的变更。',
  },
  followup: {
    name: '措施跟踪',
    prompt: '核对已有措施的执行结果，指出仍阻塞或缺少证据的事项。',
  },
}
const states: Record<PMAIRun['state'], string> = {
  queued: '排队中',
  running: '正在分析',
  succeeded: '已完成',
  failed: '未完成',
  cancelled: '已取消',
}
const scenarioNames = {
  priorities: scenarios.priorities.name,
  explain: scenarios.explain.name,
  weekly: scenarios.weekly.name,
  meeting: scenarios.meeting.name,
  followup: scenarios.followup.name,
  schedule: '排期比较',
}

function scopeLabel(scope: PMAIScope, context: PMAIContext | null) {
  const projects = scope.projectIds.map((id) =>
    context?.projects.find((project) => project.id === id)?.name ?? findProject(id)?.name ?? id,
  )
  const tasks = scope.taskIds.map((id) =>
    context?.tasks.find((task) => task.id === id)?.name ?? findTask(id)?.name ?? id,
  )
  return [projects.length ? projects.join('、') : '全部可见项目', tasks.join('、')]
    .filter(Boolean)
    .join(' · ')
}

export function PMAssistant({
  projectId,
  taskId,
  disabled = false,
}: {
  projectId?: string
  taskId?: string
  disabled?: boolean
}) {
  const userId = useAuth((state) => state.currentUser?.id)
  const online = useDataStore((state) => state.mode) === 'api'
  const [params] = useSearchParams()
  const requestedRun = params.get('aiRun') || null
  if (!online || !userId) return null
  return (
    <AssistantPanel
      key={`${userId}:${projectId ?? 'all'}:${taskId ?? 'all'}:${requestedRun ?? ''}`}
      projectId={projectId}
      taskId={taskId}
      userId={userId}
      disabled={disabled}
      requestedRun={requestedRun}
    />
  )
}

function AssistantPanel({
  projectId,
  taskId,
  userId,
  disabled,
  requestedRun,
}: {
  projectId?: string
  taskId?: string
  userId: string
  disabled: boolean
  requestedRun: string | null
}) {
  const date =
    useDataStore((state) => state.businessDate) || format(TODAY, 'yyyy-MM-dd')
  const [open, setOpen] = useState(!!requestedRun)
  const [scenario, setScenario] = useState<PMAIScenario | 'schedule' | 'agent'>('agent')
  const [question, setQuestion] = useState('')
  const [material, setMaterial] = useState('')
  const [startDate, setStartDate] = useState(() =>
    format(subDays(parseISO(date), 7), 'yyyy-MM-dd'),
  )
  const [endDate, setEndDate] = useState(date)
  const [context, setContext] = useState<PMAIContext | null>(null)
  const [runs, setRuns] = useState<PMAIRun[]>([])
  const [run, setRun] = useState<PMAIRun | null>(null)
  const [selection, setSelection] = useState({ id: requestedRun })
  const [readingRun, setReadingRun] = useState(false)
  const selectionRef = useRef(selection)
  const loadVersion = useRef(0)
  const [preparedScope, setPreparedScope] = useState<PMAIScope | null>(null)
  const [scheduleDelays, setScheduleDelays] = useState<number[]>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [pollError, setPollError] = useState('')
  const matchesScope = useCallback(
    (value: PMAIRun) => {
      const scope = value.scope ?? value.request
      return (
        (!projectId || scope.projectIds.includes(projectId)) &&
        (!taskId || scope.taskIds.includes(taskId))
      )
    },
    [projectId, taskId],
  )
  const selectId = useCallback((id: string | null, reading = false) => {
    const next = { id }
    selectionRef.current = next
    setSelection(next)
    setReadingRun(reading)
    return next
  }, [])
  const readRun = useCallback(async (id: string | null, openScenario = false) => {
    const attempt = selectId(id, !!id)
    setRun((previous) => (previous?.id === id ? previous : null))
    setPollError('')
    setError('')
    if (!id) return
    try {
      const current = await pmAI.get(id)
      if (selectionRef.current !== attempt) return
      if (!matchesScope(current)) {
        setRun(null)
        setError('这份分析不属于当前项目或任务，请从原分析入口查看。')
        return
      }
      if (openScenario) setScenario(current.scenario)
      setRun(current)
      setRuns((history) =>
        history.some((item) => item.id === current.id)
          ? history.map((item) => (item.id === current.id ? current : item))
          : [current, ...history],
      )
    } catch (e) {
      if (selectionRef.current !== attempt) return
      const failure = asAPIError(e)
      if (failure.status === 403 || failure.status === 404) {
        setRun(null)
        setRuns((history) => history.filter((item) => item.id !== id))
      }
      setError(failure.detail)
    } finally {
      if (selectionRef.current === attempt) setReadingRun(false)
    }
  }, [matchesScope, selectId])
  const load = useCallback(async (openLinkedRun = false) => {
    const initialSelection = selectionRef.current
    const version = ++loadVersion.current
    const [current, history] = await Promise.allSettled([
      pmAI.context(projectId),
      pmAI.list(projectId, taskId),
    ])
    if (loadVersion.current !== version) return
    setContext(current.status === 'fulfilled' ? current.value : null)
    setLoadError(
      current.status === 'rejected'
        ? asAPIError(current.reason).detail
        : history.status === 'rejected' ? asAPIError(history.reason).detail : '',
    )
    if (selectionRef.current !== initialSelection) return
    const scoped = history.status === 'fulfilled'
      ? history.value.items.filter(matchesScope)
      : []
    if (history.status === 'fulfilled') setRuns(scoped)
    await readRun(initialSelection.id ?? scoped[0]?.id ?? null, openLinkedRun)
  }, [projectId, taskId, matchesScope, readRun])
  useEffect(() => {
    let active = true
    if (requestedRun)
      void Promise.resolve().then(() => {
        if (active) return load(true)
      })
    return () => {
      active = false
    }
  }, [requestedRun, load])
  const active = run?.state === 'queued' || run?.state === 'running'
  const runId = run?.id
  useEffect(() => {
    if (!open || !runId || !active || readingRun) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const current = await pmAI.get(runId)
        if (stopped || selectionRef.current !== selection) return
        setRun(current)
        setPollError('')
        setRuns((history) =>
          history.map((item) => (item.id === current.id ? current : item)),
        )
        if (current.state === 'queued' || current.state === 'running')
          timer = setTimeout(poll, 2000)
      } catch (e) {
        if (!stopped && selectionRef.current === selection) {
          const failure = asAPIError(e)
          if (failure.status === 403 || failure.status === 404) {
            setRun(null)
            setRuns((history) => history.filter((item) => item.id !== runId))
            setError(failure.detail)
            return
          }
          setPollError('暂未取得最新状态，正在重试。')
          timer = setTimeout(poll, 4000)
        }
      }
    }
    timer = setTimeout(poll, 1000)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [open, runId, active, readingRun, selection])

  const manualScope = preparedScope ?? {
    projectIds: projectId ? [projectId] : [],
    taskIds: taskId ? [taskId] : [],
  }

  async function submit(request: PMAIRequest) {
    setBusy(true)
    setError('')
    setPollError('')
    try {
      const value = await pmAI.create(request)
      selectId(value.id)
      setRun(value)
      setRuns((history) => [
        value,
        ...history.filter((item) => item.id !== value.id),
      ])
    } finally {
      setBusy(false)
    }
  }

  async function generate() {
    if (scenario === 'agent' || scenario === 'schedule' || disabled || busy || active) return
    try {
      await submit({
        scenario,
        ...manualScope,
        startDate,
        endDate,
        question: question.trim() || scenarios[scenario].prompt,
        material: scenario === 'meeting' ? material : '',
      })
    } catch (e) {
      setError(asAPIError(e).detail)
    }
  }

  async function proceedAgent({
    scenario, question, projectIds, taskIds, startDate, endDate, delays,
  }: AgentRequest) {
    if (disabled) return
    if (scenario === 'meeting' || scenario === 'schedule') {
      setPreparedScope({ projectIds, taskIds })
      setQuestion(question)
      setMaterial('')
      setStartDate(startDate)
      setEndDate(endDate)
      setScheduleDelays(delays)
      setScenario(scenario)
      return
    }
    if (busy || active) return
    await submit({ scenario, question, projectIds, taskIds, startDate, endDate, material: '' })
  }

  function reuseRun() {
    if (!run || disabled || busy) return
    const request = run.request
    setScenario(request.scenario)
    setPreparedScope(run.scope ?? { projectIds: request.projectIds, taskIds: request.taskIds })
    setQuestion(request.question)
    setMaterial(request.material)
    setStartDate(request.startDate ?? format(subDays(parseISO(date), 7), 'yyyy-MM-dd'))
    setEndDate(request.endDate ?? date)
    setError('')
  }

  function changeScenario(next: typeof scenario) {
    if (next === scenario) return
    setPreparedScope(null)
    setScheduleDelays(undefined)
    setScenario(next)
    setError('')
  }

  async function cancel() {
    if (!run) return
    const attempt = selectionRef.current
    setBusy(true)
    try {
      const value = await pmAI.cancel(run.id)
      if (selectionRef.current === attempt) {
        selectId(value.id)
        setRun(value)
      }
      setRuns((history) =>
        history.map((item) => (item.id === value.id ? value : item)),
      )
    } catch (e) {
      setError(asAPIError(e).detail)
    } finally {
      setBusy(false)
    }
  }
  const scopeName = preparedScope
    ? scopeLabel(preparedScope, context)
    : taskId
      ? (findTask(taskId)?.name ?? '当前任务')
      : projectId
        ? (findProject(projectId)?.name ?? '当前项目')
        : '全部可见项目'
  const scheduleProjectId = scenario === 'schedule' ? manualScope.projectIds[0] : undefined
  const scheduleTaskId = scenario === 'schedule' ? manualScope.taskIds[0] : undefined
  return (
    <details
      className="rounded-xl border border-brand-200 bg-white p-4"
      open={open}
      onToggle={(event) => {
        const isOpen = event.currentTarget.open
        setOpen(isOpen)
        if (isOpen && !open) void load()
      }}
    >
      <summary className="cursor-pointer text-sm font-semibold text-brand-700">
        <Sparkles className="mr-2 inline h-4 w-4" />
        项目 AI 助手
      </summary>
      {open && (
        <div className="mt-4 space-y-4 text-sm">
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="rounded bg-brand-50 px-2 py-1 break-words">
              {scopeName}
            </span>
            <span className="rounded bg-ink-100 px-2 py-1">
              按当前账号权限取数
            </span>
            {context && (
              <span className="px-2 py-1 text-ink-500">
                数据时间 {new Date(context.asOf).toLocaleString('zh-CN')}
              </span>
            )}
          </div>
          {disabled && (
            <p className="text-amber-800">
              请先保存或放弃当前进展草稿，再生成或应用建议。
            </p>
          )}
          {loadError && (
            <p className="break-words rounded bg-amber-50 p-2 text-amber-900" role="status">
              {loadError}
            </p>
          )}
          <div
            className="flex flex-wrap gap-2"
            role="group"
            aria-label="AI 使用场景"
          >
            <Button
              size="sm"
              variant={scenario === 'agent' ? 'primary' : 'secondary'}
              aria-pressed={scenario === 'agent'}
              onClick={() => changeScenario('agent')}
            >
              项目 Agent
            </Button>
            {Object.entries(scenarios).map(([value, item]) => (
              <Button
                key={value}
                size="sm"
                variant={scenario === value ? 'primary' : 'secondary'}
                aria-pressed={scenario === value}
                onClick={() => changeScenario(value as PMAIScenario)}
              >
                {item.name}
              </Button>
            ))}
            {(projectId || scheduleProjectId) && (
              <Button
                size="sm"
                variant={scenario === 'schedule' ? 'primary' : 'secondary'}
                aria-pressed={scenario === 'schedule'}
                onClick={() => changeScenario('schedule')}
              >
                排期比较
              </Button>
            )}
          </div>
          <div hidden={scenario !== 'agent'}>
            <PMAgent
              projectId={projectId}
              taskId={taskId}
              context={context}
              startDate={startDate}
              endDate={endDate}
              disabled={disabled}
              analysisPending={active || busy}
              scenarioNames={scenarioNames}
              onProceed={proceedAgent}
            />
          </div>
          {scheduleProjectId && (
            <PMAIScheduleCompare
              key={`${scheduleProjectId}:${scheduleTaskId ?? ''}`}
              projectId={scheduleProjectId}
              taskId={scheduleTaskId}
              userId={userId}
              context={context}
              disabled={disabled}
              initialDelays={scheduleDelays}
            />
          )}
          {scenario !== 'agent' && scenario !== 'schedule' && (
              <fieldset
                disabled={busy || disabled}
                className="space-y-3 disabled:opacity-60"
              >
                <div className="flex flex-wrap gap-3">
                  <label>
                    开始日期
                    <input
                      type="date"
                      className="input mt-1"
                      value={startDate}
                      onChange={(event) => setStartDate(event.target.value)}
                    />
                  </label>
                  <label>
                    结束日期
                    <input
                      type="date"
                      className="input mt-1"
                      value={endDate}
                      onChange={(event) => setEndDate(event.target.value)}
                    />
                  </label>
                </div>
                <label className="block">
                  {scenario === 'meeting' ? '整理要求' : '希望了解的问题'}
                  <textarea
                    className="input mt-1"
                    maxLength={2000}
                    rows={2}
                    value={question}
                    onChange={(event) => setQuestion(event.target.value)}
                    placeholder={scenarios[scenario].prompt}
                  />
                </label>
                {scenario === 'meeting' && (
                  <label className="block">
                    会议文字
                    <textarea
                      className="input mt-1"
                      maxLength={16000}
                      rows={6}
                      value={material}
                      onChange={(event) => setMaterial(event.target.value)}
                      placeholder="粘贴本次会议文字，生成后逐项核对任务、负责人和日期。"
                    />
                  </label>
                )}
                <Button
                  variant="primary"
                  size="sm"
                  disabled={
                    active ||
                    (!context && !preparedScope) ||
                    !startDate ||
                    !endDate ||
                    startDate > endDate ||
                    (scenario === 'meeting' && !material.trim())
                  }
                  onClick={() => void generate()}
                >
                  {busy ? '正在提交…' : '生成分析'}
                </Button>
              </fieldset>
          )}
              <div className="flex flex-wrap items-end gap-3 border-t border-ink-200 pt-3">
                <label className="min-w-0 flex-1">
                  分析记录
                  <select
                    className="input mt-1"
                    value={selection.id ?? ''}
                    disabled={busy}
                    onChange={(event) => {
                      void readRun(event.target.value || null)
                    }}
                  >
                    <option value="">选择记录</option>
                    {runs.map((item) => (
                      <option key={item.id} value={item.id}>
                        {new Date(item.createdAt).toLocaleString('zh-CN')} ·{' '}
                        {scenarios[item.scenario]?.name ?? '项目分析'} ·{' '}
                        {states[item.state]}
                      </option>
                    ))}
                  </select>
                </label>
                <Button size="sm" disabled={busy} onClick={() => void load()}>
                  刷新记录
                </Button>
                {active && (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => void cancel()}
                  >
                    取消本次分析
                  </Button>
                )}
                {run && !active && (
                  <Button size="sm" disabled={disabled || busy} onClick={reuseRun}>
                    沿用分析条件
                  </Button>
                )}
              </div>
              {pollError && (
                <p role="status" className="text-amber-800">
                  {pollError}
                </p>
              )}
              {readingRun && !run && <p role="status">正在读取分析记录…</p>}
              {run && (
                <div className="space-y-3">
                  <p role="status" className="font-medium">
                    <span>{scenarios[run.scenario]?.name ?? '项目分析'} · </span>
                    <span>{states[run.state]}</span>
                    {run.model ? ` · ${run.model}` : ''}
                  </p>
                  <p className="break-words text-xs text-ink-600">
                    分析范围 {scopeLabel(run.scope ?? run.request, context)}
                  </p>
                  {run.error && (
                    <p role="alert" className="text-red-700">
                      {run.error}
                    </p>
                  )}
                  {(run.stale || run.staleReason === 'context_budget') && (
                    <p className="rounded bg-amber-50 p-2 text-amber-900">
                      {run.staleReason === 'context_budget'
                        ? '当前资料规模超过单次核对上限，暂时无法判断结果是否仍然有效。可缩小范围重新分析。'
                        : '分析后数据已有变化，应用建议前会重新核对当前版本。'}
                    </p>
                  )}
                  {run.result && (
                    <>
                      <p className="whitespace-pre-wrap break-words leading-6">
                        {run.result.summary}
                      </p>
                      {run.source.complete === false && (
                        <p className="rounded bg-amber-50 p-2 text-amber-900">
                          本次资料范围有限，请结合下方依据核对完整情况。
                        </p>
                      )}
                      <div className="space-y-3">
                        {run.result.findings.map((finding, index) => (
                          <article
                            key={index}
                            className="rounded border border-ink-200 p-3"
                          >
                            <h4 className="font-semibold">
                              <span className="mr-2 rounded bg-ink-100 px-1.5 py-0.5 text-xs font-normal">
                                {
                                  {
                                    fact: '事实',
                                    inference: '分析判断',
                                    gap: '资料缺口',
                                  }[finding.kind ?? 'inference']
                                }
                              </span>
                              {finding.title}
                            </h4>
                            <p className="mt-1 whitespace-pre-wrap break-words text-ink-700">
                              {finding.detail}
                            </p>
                            <div className="mt-2 flex flex-wrap gap-2">
                              {finding.evidenceIds.map((id) => {
                                const ref = run.source.refs.find(
                                  (item) => item.id === id,
                                )
                                return ref ? (
                                  <Evidence key={id} evidence={ref} />
                                ) : null
                              })}
                            </div>
                          </article>
                        ))}
                      </div>
                      <details className="rounded border border-ink-200 p-3">
                        <summary className="cursor-pointer">
                          本次取数依据（{run.source.refs.length}）
                        </summary>
                        <ul className="mt-2 max-h-60 space-y-2 overflow-auto">
                          {run.source.refs.map((ref) => (
                            <li key={ref.id}>
                              <Evidence evidence={ref} />
                              <span className="ml-2 text-xs text-ink-500">
                                {ref.type}
                              </span>
                              {ref.excerpt && (
                                <p className="mt-1 whitespace-pre-wrap text-xs text-ink-600">
                                  {ref.excerpt}
                                </p>
                              )}
                            </li>
                          ))}
                        </ul>
                      </details>
                      <PMAIActions
                        key={run.id}
                        run={run}
                        context={context}
                        userId={userId}
                        disabled={disabled}
                      />
                    </>
                  )}
                </div>
              )}
          {error && (
            <p role="alert" className="break-words text-red-700">
              {error}
            </p>
          )}
        </div>
      )}
    </details>
  )
}

function Evidence({ evidence }: { evidence: PMAIEvidence }) {
  if (
    evidence.href.startsWith('/') &&
    !evidence.href.startsWith('//') &&
    !Array.from(evidence.href).some(
      (character) => character === '\\' || character.charCodeAt(0) <= 32,
    )
  )
    return (
      <Link
        to={evidence.href}
        target="_blank"
        rel="noreferrer"
        className="rounded bg-brand-50 px-2 py-1 text-xs text-brand-700 underline"
      >
        {evidence.title}
      </Link>
    )
  return (
    <details className="rounded bg-brand-50 px-2 py-1 text-xs text-brand-700">
      <summary className="cursor-pointer">{evidence.title}</summary>
      <p className="mt-2 whitespace-pre-wrap text-ink-700">
        {evidence.excerpt || '本次提供的会议资料'}
      </p>
    </details>
  )
}
