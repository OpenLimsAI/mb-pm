import { useMemo, useState } from 'react'
import { addWeeks, startOfWeek } from 'date-fns'
import { Link } from 'react-router-dom'
import { pmAI, type PMAIContext } from '../../api/pmAI'
import {
  applyScheduleAssist,
  type ScheduleAssistPreview,
  type ScheduleAssistReceipt,
} from '../../api/projectAIWork'
import { asAPIError } from '../../api/client'
import { refreshAllData } from '../../data/bootstrap'
import {
  getProjectTasks,
  taskDependencies,
  tasks,
  users,
  TODAY,
} from '../../mock'
import { computeCPM } from '../../lib/cpm'
import { getWorkingCalendar } from '../../lib/workingCalendar'
import {
  availableWeekHours,
  taskAssignees,
  userWeekHours,
} from '../../lib/workload'
import { useAuth } from '../../store/auth'
import { useDataStore } from '../../store/data'
import { Button } from '../ui'
import { useDeadlineExpired } from './useDeadlineExpired'

export function PMAIScheduleCompare({
  projectId,
  taskId,
  userId,
  context,
  disabled,
}: {
  projectId: string
  taskId?: string
  userId: string
  context: PMAIContext | null
  disabled: boolean
}) {
  const [pickedId, setPickedId] = useState(taskId ?? '')
  const user = useAuth((state) => state.currentUser)
  const allowed =
    user?.role === 'admin' ||
    user?.role === 'cmc_lead' ||
    (user?.role === 'project_lead' &&
      context?.projects.find((project) => project.id === projectId)?.ownerId ===
        user.id)
  const options =
    context?.tasks.filter((task) => task.projectId === projectId) ?? []
  const selected = taskId || pickedId || options[0]?.id || ''
  if (!allowed)
    return <p className="text-ink-500">排期比较与调整由当前项目负责人维护。</p>
  return (
    <div className="space-y-3">
      <label className="block">
        推演起点
        <select
          className="input mt-1"
          value={selected}
          disabled={!!taskId || disabled}
          onChange={(event) => setPickedId(event.target.value)}
        >
          {options.map((task) => (
            <option key={task.id} value={task.id}>
              {task.code} · {task.name}
            </option>
          ))}
        </select>
      </label>
      {selected && (
        <ScheduleOptions
          key={`${projectId}:${selected}`}
          projectId={projectId}
          taskId={selected}
          userId={userId}
          disabled={disabled}
        />
      )}
    </div>
  )
}

type Pending = {
  plan: ScheduleAssistPreview
  reason: string
  receipt?: ScheduleAssistReceipt
}
function readPending(key: string): Pending | null {
  try {
    const value = JSON.parse(
      sessionStorage.getItem(key) ?? 'null',
    ) as Pending | null
    return typeof value?.plan?.confirmationToken === 'string' &&
      Array.isArray(value.plan.schedule?.changes)
      ? value
      : null
  } catch {
    return null
  }
}
function savePending(key: string, value: Pending | null) {
  try {
    if (value) sessionStorage.setItem(key, JSON.stringify(value))
    else sessionStorage.removeItem(key)
  } catch {
    /* Retry still uses the in-memory confirmation. */
  }
}

function ScheduleOptions({
  projectId,
  taskId,
  userId,
  disabled,
}: {
  projectId: string
  taskId: string
  userId: string
  disabled: boolean
}) {
  const dataVersion = useDataStore((state) => state.version)
  const key = `pm-ai-comparison:${userId}:${projectId}:${taskId}`
  const [saved] = useState(() => readPending(key))
  const [delayText, setDelayText] = useState('1,3,5')
  const [lockedIds, setLockedIds] = useState<string[]>([])
  const [plans, setPlans] = useState<ScheduleAssistPreview[]>(
    saved ? [saved.plan] : [],
  )
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [reason, setReason] = useState(saved?.reason ?? '')
  const [receipt, setReceipt] = useState(saved?.receipt ?? null)
  const [uncertain, setUncertain] = useState(!!saved && !saved.receipt)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [syncFailed, setSyncFailed] = useState(false)
  const projectTasks = getProjectTasks(projectId)
  const selected = plans[selectedIndex]
  const expired = useDeadlineExpired(selected?.expiresAt)
  const impact = useMemo(() => {
    // The shared task and capacity arrays refresh in place.
    void dataVersion
    return selected ? previewMetrics(projectId, selected) : null
  }, [projectId, selected, dataVersion])
  const reset = () => {
    setPlans([])
    setError('')
  }
  async function compare() {
    const delays = [
      ...new Set(
        delayText
          .split(/[,，\s]+/)
          .filter(Boolean)
          .map(Number),
      ),
    ]
    if (
      !delays.length ||
      delays.length > 3 ||
      delays.some(
        (value) => !Number.isInteger(value) || value < 1 || value > 365,
      )
    ) {
      setError('请输入 1–3 个 1 到 365 之间的整数工作日。')
      return
    }
    setBusy(true)
    setError('')
    try {
      const value = await pmAI.compare(projectId, taskId, delays, lockedIds)
      setPlans(value.plans)
      setSelectedIndex(0)
    } catch (e) {
      setError(asAPIError(e).detail)
    } finally {
      setBusy(false)
    }
  }
  async function sync() {
    setSyncFailed(false)
    try {
      await refreshAllData()
    } catch {
      setSyncFailed(true)
    }
  }
  async function apply() {
    if (!selected?.confirmationToken || !reason.trim()) return
    if (!uncertain && !(Date.parse(selected.expiresAt ?? '') > Date.now())) {
      setError('预览已过期，请重新比较。')
      return
    }
    setBusy(true)
    setError('')
    savePending(key, { plan: selected, reason })
    try {
      const value = await applyScheduleAssist(
        projectId,
        selected.confirmationToken,
        reason.trim(),
      )
      savePending(key, { plan: selected, reason, receipt: value })
      setReceipt(value)
      setUncertain(false)
      void sync()
    } catch (e) {
      const failure = asAPIError(e)
      if (
        failure.status &&
        failure.status >= 400 &&
        failure.status < 500 &&
        ![408, 429].includes(failure.status)
      ) {
        savePending(key, null)
        setPlans([])
        setUncertain(false)
        setError(failure.detail)
      } else {
        setUncertain(true)
        setError('暂未收到回执，可重试本次确认。已执行的调整会返回原回执。')
      }
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-3">
      {!receipt && (
        <fieldset
          disabled={busy || disabled || uncertain}
          className="space-y-3 disabled:opacity-60"
        >
          <label className="block">
            顺延工作日方案
            <input
              className="input mt-1"
              value={delayText}
              onChange={(event) => {
                setDelayText(event.target.value)
                reset()
              }}
              placeholder="例如 1,3,5"
            />
          </label>
          <details className="rounded border border-ink-200 p-2">
            <summary className="cursor-pointer">
              固定里程碑（{lockedIds.length}）
            </summary>
            <div className="mt-2 max-h-48 space-y-1 overflow-auto">
              {projectTasks
                .filter((task) => task.isMilestone && task.id !== taskId)
                .map((task) => (
                  <label key={task.id} className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={lockedIds.includes(task.id)}
                      onChange={(event) => {
                        setLockedIds((ids) =>
                          event.target.checked
                            ? [...ids, task.id]
                            : ids.filter((id) => id !== task.id),
                        )
                        reset()
                      }}
                    />
                    <span>
                      {task.code} · {task.name}
                    </span>
                  </label>
                ))}
            </div>
          </details>
          <Button size="sm" variant="primary" onClick={() => void compare()}>
            {busy ? '正在计算…' : '比较排期方案'}
          </Button>
        </fieldset>
      )}
      {!!plans.length && (
        <div className="space-y-3">
          <div className="grid gap-2 md:grid-cols-3">
            {plans.map((plan, index) => (
              <button
                type="button"
                key={index}
                disabled={!!receipt || uncertain || busy}
                aria-pressed={selectedIndex === index}
                onClick={() => setSelectedIndex(index)}
                className={`rounded-lg border p-3 text-left ${selectedIndex === index ? 'border-brand-600 bg-brand-50' : 'border-ink-200'}`}
              >
                <strong>顺延 {plan.delayWorkdays} 个工作日</strong>
                <p className="mt-1 text-xs">
                  调整 {plan.schedule.changes.length} 项 · 冲突{' '}
                  {plan.schedule.conflicts.length} 项
                </p>
                <p className="mt-1 text-xs">
                  完工 {plan.schedule.previousFinish} →{' '}
                  {plan.schedule.newFinish}
                </p>
              </button>
            ))}
          </div>
          {selected && (
            <>
              {impact && (
                <p className="text-xs text-ink-600">
                  基于当前页面数据估算 · 关键路径任务 {impact.criticalBefore} →{' '}
                  {impact.criticalAfter} · 未来 8 周超负荷人周{' '}
                  {impact.overloadBefore} → {impact.overloadAfter}
                </p>
              )}
              {selected.schedule.conflicts.length > 0 && (
                <div
                  role="alert"
                  className="rounded bg-red-50 p-3 text-red-700"
                >
                  {selected.schedule.conflicts.map((conflict, index) => (
                    <p key={index}>
                      {conflict.name} · {conflict.reason}
                    </p>
                  ))}
                </div>
              )}
              <ul className="max-h-64 space-y-2 overflow-auto rounded border border-ink-200 p-3">
                {selected.schedule.changes.map((change) => (
                  <li key={change.taskId} className="text-xs">
                    <Link
                      to={`/projects/${encodeURIComponent(projectId)}?tab=wbs&task=${encodeURIComponent(change.taskId)}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-brand-700 underline"
                    >
                      {change.name}
                    </Link>
                    <p>
                      {change.oldStart} — {change.oldEnd} → {change.newStart} —{' '}
                      {change.newEnd}
                    </p>
                  </li>
                ))}
              </ul>
              {!receipt &&
                !!selected.confirmationToken &&
                !selected.schedule.conflicts.length && (
                  <>
                    <label className="block">
                      调整原因
                      <input
                        className="input mt-1"
                        value={reason}
                        disabled={busy || uncertain}
                        maxLength={2000}
                        onChange={(event) => setReason(event.target.value)}
                      />
                    </label>
                    {expired && !uncertain && (
                      <p className="text-amber-800">预览已过期，请重新比较。</p>
                    )}
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={
                        busy ||
                        disabled ||
                        !reason.trim() ||
                        (!uncertain && (!selected.expiresAt || expired))
                      }
                      onClick={() => void apply()}
                    >
                      {busy
                        ? '正在确认…'
                        : uncertain
                          ? '重试本次确认'
                          : '确认采用此方案'}
                    </Button>
                  </>
                )}
            </>
          )}
        </div>
      )}
      {receipt && (
        <div role="status" className="space-y-2 rounded bg-emerald-50 p-3">
          <p>排期已更新 · 回执 {receipt.receiptId}</p>
          {syncFailed && (
            <>
              <p>页面同步暂未完成。</p>
              <Button size="sm" onClick={() => void sync()}>
                重新同步
              </Button>
            </>
          )}
          <Button
            size="sm"
            onClick={() => {
              savePending(key, null)
              setReceipt(null)
              reset()
            }}
          >
            开始新的比较
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-red-700">
          {error}
        </p>
      )}
    </div>
  )
}

function previewMetrics(projectId: string, plan: ScheduleAssistPreview) {
  const original = getProjectTasks(projectId)
  if (!original.length) return null
  const changed = new Map(
    plan.schedule.changes.map((change) => [change.taskId, change]),
  )
  const proposed = original.map((task) => {
    const change = changed.get(task.id)
    return change
      ? { ...task, plannedStart: change.newStart, plannedEnd: change.newEnd }
      : task
  })
  const deps = taskDependencies.filter(
    (edge) =>
      original.some((task) => task.id === edge.predecessorId) &&
      original.some((task) => task.id === edge.successorId),
  )
  const calendar = getWorkingCalendar(projectId)
  const involved = new Set(original.flatMap(taskAssignees))
  const proposedAll = tasks.map(
    (task) => proposed.find((value) => value.id === task.id) ?? task,
  )
  const overload = (values: typeof tasks) =>
    users
      .filter((user) => involved.has(user.id))
      .reduce((total, user) => {
        let count = 0
        for (let week = 0; week < 8; week++) {
          const start = addWeeks(startOfWeek(TODAY, { weekStartsOn: 1 }), week)
          if (
            userWeekHours(values, start, user.id).hours >
            availableWeekHours(user, start)
          )
            count++
        }
        return total + count
      }, 0)
  return {
    criticalBefore: computeCPM(original, deps, calendar).criticalPathIds.size,
    criticalAfter: computeCPM(proposed, deps, calendar).criticalPathIds.size,
    overloadBefore: overload(tasks),
    overloadAfter: overload(proposedAll),
  }
}
