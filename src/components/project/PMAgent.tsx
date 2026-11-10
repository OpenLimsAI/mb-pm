import { useState } from 'react'
import { Link } from 'react-router-dom'
import { asAPIError } from '../../api/client'
import {
  pmAI,
  type PMAgentPlan,
  type PMAgentTarget,
  type PMAgentTriage,
  type PMAIContext,
  type PMAIScenario,
  type PMAIScope,
} from '../../api/pmAI'
import { safeMarkdownLink } from '../markdownSafety'
import { Button } from '../ui'

type AgentScenario = PMAIScenario | 'schedule'

export interface AgentRequest extends PMAIScope {
  scenario: AgentScenario
  question: string
  startDate: string
  endDate: string
  delays?: number[]
}

function targetOptions(context: PMAIContext | null, plan: PMAgentPlan) {
  const projects = new Map(
    context?.projects.map((project) => [project.id, project.name]),
  )
  for (const target of plan.targets) {
    const name = target.kind === 'project' ? target.name : target.projectName
    if (name && !projects.has(target.projectId)) {
      projects.set(target.projectId, name)
    }
  }
  const tasks = new Map<string, PMAgentTarget>(
    context?.tasks.map((task) => [
      task.id,
      { ...task, kind: 'task', projectName: projects.get(task.projectId) ?? '' },
    ]),
  )
  for (const target of plan.targets) {
    if (target.kind === 'task') tasks.set(target.id, target)
  }
  return { projects, tasks }
}

const multiple = '__multiple__'

export function PMAgent({
  projectId,
  taskId,
  context,
  startDate,
  endDate,
  disabled,
  analysisPending,
  scenarioNames,
  onProceed,
}: {
  projectId?: string
  taskId?: string
  context: PMAIContext | null
  startDate: string
  endDate: string
  disabled: boolean
  analysisPending: boolean
  scenarioNames: Record<AgentScenario, string>
  onProceed: (request: AgentRequest) => Promise<void>
}) {
  const [question, setQuestion] = useState('')
  const [plan, setPlan] = useState<PMAgentPlan | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [triage, setTriage] = useState<{
    result: PMAgentTriage
    scope: string
  } | null>(null)

  async function planQuestion(target?: PMAgentTarget) {
    const text = question.trim()
    if (!text || disabled || busy) return
    setBusy(true)
    setError('')
    setTriage(null)
    try {
      const value = await pmAI.plan(
        text,
        projectId ?? target?.projectId,
        taskId ?? (target?.kind === 'task' ? target.id : undefined),
      )
      setPlan({
        ...value,
        startDate: value.startDate ?? startDate,
        endDate: value.endDate ?? endDate,
      })
    } catch (failure) {
      setError(asAPIError(failure).detail)
    } finally {
      setBusy(false)
    }
  }

  function editPlan(patch: Partial<PMAgentPlan>) {
    setPlan((value) => (value ? { ...value, ...patch } : value))
    setTriage(null)
    setError('')
  }

  const options = plan ? targetOptions(context, plan) : null
  const projectNames = plan?.projectIds.map((id) => options?.projects.get(id) ?? id)
  const taskNames = plan?.taskIds.map((id) => options?.tasks.get(id)?.name ?? id)
  const scopeLabel = [
    projectNames?.length ? projectNames.join('、') : '全部可见项目',
    ...(taskNames?.length ? [taskNames.join('、')] : []),
    ...(plan?.scenario === 'priorities' && plan.mineOnly ? ['我的任务'] : []),
  ].join(' · ')
  const isSchedule = plan?.scenario === 'schedule'
  const isTriage = plan?.scenario === 'priorities'
  const invalidSchedule =
    isSchedule && (plan.projectIds.length !== 1 || plan.taskIds.length !== 1)
  const invalidDates =
    !isSchedule && !isTriage &&
    (!plan?.startDate || !plan.endDate || plan.startDate > plan.endDate)
  const invalidLimit =
    isTriage && (!Number.isInteger(plan.limit) || plan.limit < 1 || plan.limit > 20)
  const needsModelNow = !isTriage && !isSchedule && plan?.scenario !== 'meeting'

  async function proceed() {
    if (
      !plan?.scenario || plan.status !== 'ready' || disabled || busy ||
      invalidSchedule || invalidDates || invalidLimit || (analysisPending && needsModelNow)
    ) return
    setBusy(true)
    setError('')
    try {
      const scope = { projectIds: plan.projectIds, taskIds: plan.taskIds }
      if (plan.scenario === 'priorities') {
        const result = await pmAI.triage(scope, plan.limit, !!plan.mineOnly)
        setTriage({ result, scope: scopeLabel })
      } else {
        await onProceed({
          ...scope,
          scenario: plan.scenario,
          question: question.trim(),
          startDate: plan.startDate ?? startDate,
          endDate: plan.endDate ?? endDate,
          delays: plan.delays,
        })
      }
    } catch (failure) {
      setError(asAPIError(failure).detail)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="space-y-3" aria-label="项目 Agent">
      <fieldset disabled={busy || disabled} className="space-y-3 disabled:opacity-60">
        <label className="block font-medium">
          向项目 Agent 提问
          <textarea
            className="input mt-1 font-normal"
            maxLength={2000}
            rows={2}
            value={question}
            placeholder="例如：列出 007Y 项目最需要处理的 3 项工作"
            onChange={(event) => {
              setQuestion(event.target.value)
              setPlan(null)
              setTriage(null)
              setError('')
            }}
          />
        </label>
        <Button size="sm" disabled={!question.trim()} onClick={() => void planQuestion()}>
          识别范围与操作
        </Button>
        {plan?.status === 'clarify' && (
          <div className="space-y-2 rounded-md bg-amber-50 p-3 text-amber-900" role="status">
            <p>{plan.message}</p>
            <div className="flex flex-wrap gap-2">
              {plan.choices.map((target) => (
                <Button
                  key={`${target.kind}:${target.id}`}
                  size="sm"
                  onClick={() => void planQuestion(target)}
                >
                  {target.name}
                  {target.code ? ` · ${target.code}` : ''}
                  {target.kind === 'task' && target.projectName ? ` · ${target.projectName}` : ''}
                </Button>
              ))}
            </div>
          </div>
        )}
        {plan?.status === 'ready' && plan.scenario && options && (
          <div className="space-y-3 rounded-lg border border-brand-200 bg-brand-50 p-3">
            <h3 className="font-semibold">核对操作和范围</h3>
            {plan.message && <p className="text-ink-600">{plan.message}</p>}
            <p className="break-words text-xs text-ink-700">实际范围 {scopeLabel}</p>
            <div className="grid gap-2 sm:grid-cols-3">
              <label>
                操作
                <select
                  className="input mt-1"
                  value={plan.scenario}
                  onChange={(event) => editPlan({ scenario: event.target.value as AgentScenario })}
                >
                  {Object.entries(scenarioNames).map(([key, name]) => (
                    <option key={key} value={key}>{name}</option>
                  ))}
                </select>
              </label>
              <label>
                项目范围
                <select
                  className="input mt-1"
                  value={plan.projectIds.length > 1 ? multiple : plan.projectIds[0] ?? ''}
                  disabled={!!projectId}
                  onChange={(event) => editPlan({
                    projectIds: event.target.value ? [event.target.value] : [],
                    taskIds: [],
                  })}
                >
                  {!projectId && <option value="">全部可见项目</option>}
                  {plan.projectIds.length > 1 && (
                    <option value={multiple} disabled>{plan.projectIds.length} 个已识别项目</option>
                  )}
                  {[...options.projects].map(([id, name]) => (
                    <option key={id} value={id}>{name}</option>
                  ))}
                </select>
              </label>
              <label>
                任务范围
                <select
                  className="input mt-1"
                  value={plan.taskIds.length > 1 ? multiple : plan.taskIds[0] ?? ''}
                  disabled={!!taskId}
                  onChange={(event) => {
                    const target = options.tasks.get(event.target.value)
                    editPlan(target
                      ? { projectIds: [target.projectId], taskIds: [target.id] }
                      : { taskIds: [] },
                    )
                  }}
                >
                  {!taskId && <option value="">所选项目内的任务</option>}
                  {plan.taskIds.length > 1 && (
                    <option value={multiple} disabled>{plan.taskIds.length} 个已识别任务</option>
                  )}
                  {[...options.tasks.values()]
                    .filter((target) => !plan.projectIds.length || plan.projectIds.includes(target.projectId))
                    .map((target) => (
                      <option key={target.id} value={target.id}>{target.name} · {target.code}</option>
                    ))}
                </select>
              </label>
            </div>
            {isTriage && (
              <div className="flex flex-wrap items-end gap-3">
                <label>
                  最多显示
                  <input
                    className="input mt-1"
                    type="number"
                    min={1}
                    max={20}
                    value={plan.limit || ''}
                    onChange={(event) => editPlan({ limit: Number(event.target.value) })}
                  />
                </label>
                <label className="flex items-center gap-2 py-2">
                  <input
                    type="checkbox"
                    checked={!!plan.mineOnly}
                    onChange={(event) => editPlan({ mineOnly: event.target.checked })}
                  />
                  仅我的任务
                </label>
                <p className="text-xs text-ink-600">核对活跃项目中的逾期、阻塞、延迟与未来 7 天到期事项。</p>
              </div>
            )}
            {!isTriage && !isSchedule && (
              <div className="flex flex-wrap gap-3">
                <label>
                  分析开始日期
                  <input
                    className="input mt-1"
                    type="date"
                    value={plan.startDate ?? ''}
                    onChange={(event) => editPlan({ startDate: event.target.value })}
                  />
                </label>
                <label>
                  分析结束日期
                  <input
                    className="input mt-1"
                    type="date"
                    value={plan.endDate ?? ''}
                    onChange={(event) => editPlan({ endDate: event.target.value })}
                  />
                </label>
              </div>
            )}
            {isSchedule && (invalidSchedule ? (
              <p className="text-amber-900">请先选择一项任务作为推演起点。</p>
            ) : (
              <p className="text-ink-600">
                {plan.delays?.length
                  ? `建议比较顺延 ${plan.delays.join('、')} 个工作日。`
                  : '将在比较面板填写顺延天数。'}
              </p>
            ))}
            <Button
              size="sm"
              variant="primary"
              disabled={invalidSchedule || invalidDates || invalidLimit || (analysisPending && needsModelNow)}
              onClick={() => void proceed()}
            >
              {isTriage
                ? '查看工作重点'
                : isSchedule
                  ? '进入排期比较'
                  : plan.scenario === 'meeting' ? '继续整理纪要' : '按此范围分析'}
            </Button>
          </div>
        )}
      </fieldset>
      {busy && <p role="status" className="text-ink-600">正在处理…</p>}
      {error && <p role="alert" className="text-red-700">{error}</p>}
      {triage && <TriageResult result={triage.result} scope={triage.scope} />}
    </section>
  )
}

function TriageResult({ result, scope }: { result: PMAgentTriage; scope: string }) {
  return (
    <section aria-label="工作重点结果" className="space-y-2 rounded-lg border border-ink-200 p-3">
      <h3 className="font-semibold">工作重点</h3>
      <p className="break-words text-xs text-ink-600">
        {scope} · {result.businessDate} · 显示 {result.items.length} / {result.totalCandidates} 项
      </p>
      {result.items.length ? (
        <ol className="list-decimal space-y-2 ps-5">
          {result.items.map((item) => {
            const href = safeMarkdownLink(item.href)
            const details = [
              item.projectName, item.code, item.status, item.ownerName,
              item.plannedEnd ? `${item.plannedEnd} 截止` : '',
            ].filter(Boolean).join(' · ')
            return (
              <li key={item.taskId} className="break-words">
                {href?.startsWith('/') ? (
                  <Link to={href} className="font-semibold text-brand-700 underline">{item.name}</Link>
                ) : <strong>{item.name}</strong>}
                <p className="text-xs text-ink-600">{details}</p>
                <p className="text-xs text-ink-700">{item.reasons.join(' · ')}</p>
              </li>
            )
          })}
        </ol>
      ) : <p className="text-ink-600">这个范围内暂无需要优先处理的任务。</p>}
    </section>
  )
}
