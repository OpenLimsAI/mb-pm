import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  pmAI,
  type PMAIAction,
  type PMAIChangePreview,
  type PMAIContext,
  type PMAIReceipt,
  type PMAIRun,
} from '../../api/pmAI'
import { asAPIError } from '../../api/client'
import { refreshAllData } from '../../data/bootstrap'
import { Button } from '../ui'
import { useDeadlineExpired } from './useDeadlineExpired'

const names = {
  task_update: '更新任务进展',
  task_create: '新增任务',
  register_create: '登记风险、问题或决策',
  register_update: '更新跟进事项',
}
const fields: Record<string, string> = {
  progress: '进度',
  status: '状态',
  actualEffort: '实际工时',
  notes: '进展说明',
  ownerId: '负责人',
  name: '名称',
  title: '标题',
  plannedStart: '计划开始',
  plannedEnd: '计划结束',
  dueDate: '期限',
  mitigation: '措施',
  closure: '处理结果',
  kind: '类型',
}
type SavedConfirmation = { preview: PMAIChangePreview; receipt?: PMAIReceipt }

function savedConfirmation(key: string): SavedConfirmation | null {
  try {
    const value = JSON.parse(
      sessionStorage.getItem(key) || 'null',
    ) as SavedConfirmation | null
    return typeof value?.preview?.confirmationToken === 'string' &&
      Array.isArray(value.preview.changes)
      ? value
      : null
  } catch {
    return null
  }
}
function saveConfirmation(key: string, value: SavedConfirmation | null) {
  try {
    if (value) sessionStorage.setItem(key, JSON.stringify(value))
    else sessionStorage.removeItem(key)
  } catch {
    /* The server still retains successful receipts. */
  }
}

export function PMAIActions({
  run,
  context,
  userId,
  disabled,
}: {
  run: PMAIRun
  context: PMAIContext | null
  userId: string
  disabled: boolean
}) {
  const key = `pm-ai-confirmation:${userId}:${run.id}`
  const [saved] = useState(() => savedConfirmation(key))
  const defaults = (draft: PMAIAction): PMAIAction => ({
    ...draft,
    ...(['task_create', 'register_create'].includes(draft.kind) &&
    !draft.projectId &&
    context?.projects.length === 1
      ? { projectId: context.projects[0].id }
      : {}),
    ...(draft.kind === 'register_create'
      ? {
          registerKind: draft.registerKind ?? 'risk',
          severity: draft.severity ?? 'medium',
        }
      : {}),
    ...(draft.kind === 'register_update'
      ? { status: draft.status ?? 'open' }
      : {}),
  })
  const [drafts, setDrafts] = useState<PMAIAction[]>(() =>
    (saved?.preview.actions ?? run.result?.draftActions ?? [])
      .filter((draft) => draft.kind in names)
      .map(defaults),
  )
  const [included, setIncluded] = useState(() => drafts.map(() => true))
  const [preview, setPreview] = useState<PMAIChangePreview | null>(
    saved?.preview ?? null,
  )
  const [receipt, setReceipt] = useState<PMAIReceipt | null>(
    saved?.receipt ?? null,
  )
  const [uncertain, setUncertain] = useState(!!saved && !saved.receipt)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [syncError, setSyncError] = useState('')
  const [pastReceipts, setPastReceipts] = useState<
    (PMAIReceipt & { createdAt: string })[]
  >([])
  const [historyUnavailable, setHistoryUnavailable] = useState(false)
  const expired = useDeadlineExpired(preview?.expiresAt)
  const taskIds = new Set(
    run.source.refs
      .filter((ref) => ref.type === 'task')
      .map((ref) => ref.entityId),
  )
  const entryIds = new Set(
    run.source.refs
      .filter((ref) => ref.type === 'register')
      .map((ref) => ref.entityId),
  )
  const availableTasks =
    context?.tasks.filter((task) => taskIds.has(task.id)) ?? []
  const availableEntries =
    context?.registerEntries.filter((entry) => entryIds.has(entry.id)) ?? []
  useEffect(() => {
    let active = true
    pmAI
      .receipts(run.id)
      .then((rows) => {
        if (active) {
          setPastReceipts(rows)
          setHistoryUnavailable(false)
        }
      })
      .catch(() => {
        if (active) setHistoryUnavailable(true)
      })
    return () => {
      active = false
    }
  }, [run.id, receipt?.receiptId])
  const update = (index: number, patch: Partial<PMAIAction>) => {
    setDrafts((current) =>
      current.map((draft, row) =>
        row === index ? { ...draft, ...patch } : draft,
      ),
    )
    setPreview(null)
    setError('')
  }
  const changeKind = (index: number, kind: PMAIAction['kind']) => {
    setDrafts((current) =>
      current.map((draft, row) =>
        row === index
          ? defaults({
              kind,
              evidenceIds: draft.evidenceIds,
              reason: draft.reason,
            })
          : draft,
      ),
    )
    setPreview(null)
    setError('')
  }
  const add = () => {
    setDrafts((current) => [
      ...current,
      {
        kind: 'task_update',
        evidenceIds: [],
        reason: '',
        taskId: '',
        expectedRevision: 1,
      },
    ])
    setIncluded((current) => [...current, true])
    setPreview(null)
  }
  async function review() {
    setBusy(true)
    setError('')
    try {
      setPreview(
        await pmAI.preview(
          run.id,
          drafts
            .filter((_, index) => included[index])
            .map((draft) => ({
              ...draft,
              ...(draft.kind === 'task_update' && !draft.expectedRevision
                ? {
                    expectedRevision: availableTasks.find(
                      (task) => task.id === draft.taskId,
                    )?.revision,
                  }
                : {}),
              ...(draft.kind === 'register_update' && !draft.expectedRevision
                ? {
                    expectedRevision: availableEntries.find(
                      (item) => item.id === draft.entryId,
                    )?.revision,
                  }
                : {}),
            })),
        ),
      )
    } catch (e) {
      setError(asAPIError(e).detail)
    } finally {
      setBusy(false)
    }
  }
  async function synchronize() {
    setSyncError('')
    try {
      await refreshAllData()
    } catch {
      setSyncError('操作已完成，页面同步暂未成功，可重新同步。')
    }
  }
  async function apply() {
    if (!preview) return
    if (!uncertain && !(Date.parse(preview.expiresAt) > Date.now())) {
      setError('预览已过期，请重新预览。')
      return
    }
    setBusy(true)
    setError('')
    saveConfirmation(key, { preview })
    try {
      const result = await pmAI.apply(run.id, preview.confirmationToken)
      saveConfirmation(key, { preview, receipt: result })
      setReceipt(result)
      setUncertain(false)
      void synchronize()
    } catch (e) {
      const failure = asAPIError(e)
      if (
        failure.status &&
        failure.status >= 400 &&
        failure.status < 500 &&
        ![408, 429].includes(failure.status)
      ) {
        saveConfirmation(key, null)
        setPreview(null)
        setUncertain(false)
        setError(failure.detail)
      } else {
        setUncertain(true)
        setError(
          '暂未收到回执。重试本次确认会完成已批准的操作，已执行时返回原回执。',
        )
      }
    } finally {
      setBusy(false)
    }
  }
  return (
    <section
      className="space-y-3 border-t border-ink-200 pt-3"
      aria-label="AI 操作草稿"
    >
      <h4 className="font-medium">操作草稿</h4>
      {pastReceipts.length > 0 && (
        <details className="rounded border border-emerald-200 p-3">
          <summary className="cursor-pointer">
            已应用记录（{pastReceipts.length}）
          </summary>
          {pastReceipts.map((item) => (
            <div key={item.receiptId} className="mt-2 space-y-1 text-xs">
              <p>
                {new Date(item.createdAt).toLocaleString()} · {item.receiptId}
              </p>
              {item.results.map((result, index) => (
                <p key={index}>
                  <Link
                    to={result.href}
                    target="_blank"
                    rel="noreferrer"
                    className="text-brand-700 underline"
                  >
                    {result.title}
                  </Link>
                </p>
              ))}
            </div>
          ))}
        </details>
      )}
      {historyUnavailable && (
        <p className="text-xs text-amber-800">
          暂时无法读取已应用记录，请刷新分析后再核对。
        </p>
      )}
      <p className="text-xs text-ink-500">
        核对对象、负责人、日期和依据，先预览差异，再确认写入。
      </p>
      {!receipt && !uncertain && (
        <fieldset
          disabled={busy || disabled || !context}
          className="space-y-3 disabled:opacity-60"
        >
          {drafts.map((draft, index) => (
            <details
              key={index}
              open
              className="rounded border border-ink-200 p-3"
            >
              <summary className="cursor-pointer font-medium">
                {index + 1}. {names[draft.kind]}
              </summary>
              <label className="my-2 flex gap-2 items-center">
                <input
                  type="checkbox"
                  checked={!!included[index]}
                  onChange={(event) => {
                    setIncluded((current) =>
                      current.map((value, row) =>
                        row === index ? event.target.checked : value,
                      ),
                    )
                    setPreview(null)
                  }}
                />
                纳入本次操作
              </label>
              <div className="grid gap-2 md:grid-cols-2">
                <label>
                  操作类型
                  <select
                    className="input mt-1"
                    value={draft.kind}
                    onChange={(event) =>
                      changeKind(
                        index,
                        event.target.value as PMAIAction['kind'],
                      )
                    }
                  >
                    {Object.entries(names).map(([value, name]) => (
                      <option key={value} value={value}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
                {['task_create', 'register_create'].includes(draft.kind) && (
                  <label>
                    所属项目
                    <select
                      className="input mt-1"
                      value={draft.projectId ?? ''}
                      onChange={(event) =>
                        update(index, {
                          projectId: event.target.value,
                          subProjectId: '',
                          ownerId: '',
                        })
                      }
                    >
                      <option value="">请选择项目</option>
                      {context?.projects.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.code} · {item.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {draft.kind === 'task_update' && (
                  <>
                    <label>
                      任务
                      <select
                        className="input mt-1"
                        value={draft.taskId ?? ''}
                        onChange={(event) => {
                          const task = availableTasks.find(
                            (item) => item.id === event.target.value,
                          )
                          update(index, {
                            taskId: event.target.value,
                            expectedRevision: task?.revision,
                          })
                        }}
                      >
                        <option value="">请选择任务</option>
                        {availableTasks.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.code} · {item.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      状态
                      <select
                        className="input mt-1"
                        value={draft.status ?? ''}
                        onChange={(event) =>
                          update(index, {
                            status: event.target.value || undefined,
                          })
                        }
                      >
                        <option value="">保持当前状态</option>
                        {['未开始', '进行中', '已完成', '延迟', '阻塞'].map(
                          (value) => (
                            <option key={value}>{value}</option>
                          ),
                        )}
                      </select>
                    </label>
                    <label>
                      进度 %
                      <input
                        className="input mt-1"
                        type="number"
                        min={0}
                        max={100}
                        value={draft.progress ?? ''}
                        onChange={(event) =>
                          update(index, {
                            progress:
                              event.target.value === ''
                                ? undefined
                                : Number(event.target.value),
                          })
                        }
                      />
                    </label>
                    <label>
                      实际工时（人天）
                      <input
                        className="input mt-1"
                        type="number"
                        min={0}
                        value={draft.actualEffort ?? ''}
                        onChange={(event) =>
                          update(index, {
                            actualEffort:
                              event.target.value === ''
                                ? undefined
                                : Number(event.target.value),
                          })
                        }
                      />
                    </label>
                    <label className="md:col-span-2">
                      进展说明
                      <textarea
                        className="input mt-1"
                        value={draft.notes ?? ''}
                        onChange={(event) =>
                          update(index, { notes: event.target.value })
                        }
                      />
                    </label>
                  </>
                )}
                {draft.kind === 'task_create' && (
                  <>
                    <label>
                      子项目
                      <select
                        className="input mt-1"
                        value={draft.subProjectId ?? ''}
                        onChange={(event) =>
                          update(index, { subProjectId: event.target.value })
                        }
                      >
                        <option value="">请选择子项目</option>
                        {context?.subProjects
                          .filter((item) => item.projectId === draft.projectId)
                          .map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.name}
                            </option>
                          ))}
                      </select>
                    </label>
                    <label>
                      任务名称
                      <input
                        className="input mt-1"
                        value={draft.name ?? ''}
                        maxLength={200}
                        onChange={(event) =>
                          update(index, { name: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      计划开始
                      <input
                        type="date"
                        className="input mt-1"
                        value={draft.plannedStart ?? ''}
                        onChange={(event) =>
                          update(index, { plannedStart: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      计划结束
                      <input
                        type="date"
                        className="input mt-1"
                        value={draft.plannedEnd ?? ''}
                        onChange={(event) =>
                          update(index, { plannedEnd: event.target.value })
                        }
                      />
                    </label>
                  </>
                )}
                {['task_create', 'register_create'].includes(draft.kind) && (
                  <label>
                    负责人
                    <select
                      className="input mt-1"
                      value={draft.ownerId ?? ''}
                      onChange={(event) =>
                        update(index, { ownerId: event.target.value })
                      }
                    >
                      <option value="">请选择负责人</option>
                      {context?.members.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {draft.kind === 'register_create' && (
                  <>
                    <label>
                      事项类型
                      <select
                        className="input mt-1"
                        value={draft.registerKind ?? 'risk'}
                        onChange={(event) =>
                          update(index, {
                            registerKind: event.target
                              .value as PMAIAction['registerKind'],
                          })
                        }
                      >
                        <option value="risk">风险</option>
                        <option value="issue">问题</option>
                        <option value="decision">决策</option>
                      </select>
                    </label>
                    <label>
                      标题
                      <input
                        className="input mt-1"
                        value={draft.title ?? ''}
                        maxLength={200}
                        onChange={(event) =>
                          update(index, { title: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      处理期限
                      <input
                        type="date"
                        className="input mt-1"
                        value={draft.dueDate ?? ''}
                        onChange={(event) =>
                          update(index, { dueDate: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      严重程度
                      <select
                        className="input mt-1"
                        value={draft.severity ?? 'medium'}
                        onChange={(event) =>
                          update(index, {
                            severity: event.target
                              .value as PMAIAction['severity'],
                          })
                        }
                      >
                        <option value="low">低</option>
                        <option value="medium">中</option>
                        <option value="high">高</option>
                      </select>
                    </label>
                  </>
                )}
                {draft.kind === 'register_update' && (
                  <>
                    <label>
                      跟进事项
                      <select
                        className="input mt-1"
                        value={draft.entryId ?? ''}
                        onChange={(event) => {
                          const item = availableEntries.find(
                            (row) => row.id === event.target.value,
                          )
                          update(index, {
                            entryId: event.target.value,
                            expectedRevision: item?.revision,
                          })
                        }}
                      >
                        <option value="">请选择事项</option>
                        {availableEntries.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.title}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      事项状态
                      <select
                        className="input mt-1"
                        value={draft.status ?? 'open'}
                        onChange={(event) =>
                          update(index, { status: event.target.value })
                        }
                      >
                        <option value="open">待处理</option>
                        <option value="closed">已关闭</option>
                      </select>
                    </label>
                    <label className="md:col-span-2">
                      处理结果
                      <textarea
                        className="input mt-1"
                        value={draft.closure ?? ''}
                        onChange={(event) =>
                          update(index, { closure: event.target.value })
                        }
                      />
                    </label>
                  </>
                )}
                {['register_create', 'register_update'].includes(
                  draft.kind,
                ) && (
                  <label className="md:col-span-2">
                    措施
                    <textarea
                      className="input mt-1"
                      value={draft.mitigation ?? ''}
                      onChange={(event) =>
                        update(index, { mitigation: event.target.value })
                      }
                    />
                  </label>
                )}
                <label className="md:col-span-2">
                  操作原因
                  <input
                    className="input mt-1"
                    value={draft.reason}
                    maxLength={2000}
                    onChange={(event) =>
                      update(index, { reason: event.target.value })
                    }
                  />
                </label>
                <label className="md:col-span-2">
                  依据
                  <select
                    multiple
                    size={3}
                    className="input mt-1"
                    value={draft.evidenceIds ?? []}
                    onChange={(event) =>
                      update(index, {
                        evidenceIds: Array.from(
                          event.target.selectedOptions,
                          (option) => option.value,
                        ),
                      })
                    }
                  >
                    {run.source.refs.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.title}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </details>
          ))}
          <div className="flex gap-2">
            <Button size="sm" onClick={add} disabled={drafts.length >= 20}>
              添加操作
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={!drafts.some((_, index) => included[index])}
              onClick={() => void review()}
            >
              {busy ? '正在核对…' : '预览操作差异'}
            </Button>
          </div>
        </fieldset>
      )}
      {preview && !receipt && (
        <div className="space-y-3 rounded border border-brand-200 bg-brand-50 p-3">
          <h4 className="font-medium">
            待确认的 {preview.changes.length} 项操作
          </h4>
          {preview.changes.map((change, index) => (
            <div key={`${change.entityId}-${index}`} className="space-y-1">
              <strong>{change.title}</strong>
              <dl className="text-xs space-y-1">
                {Object.keys(change.after)
                  .filter((field) =>
                    JSON.stringify(change.before[field]) !==
                    JSON.stringify(change.after[field]),
                  )
                  .map((field) => (
                    <div key={field}>
                      <dt className="inline text-ink-500">
                        {fields[field] ?? field}{' '}
                      </dt>
                      <dd className="inline break-words">
                        {displayValue(change.before[field])} →{' '}
                        {displayValue(change.after[field])}
                      </dd>
                    </div>
                  ))}
              </dl>
            </div>
          ))}
          <p className="text-xs">
            {uncertain
              ? '上次确认结果待核对，重试使用原确认记录。'
              : '请核对以上差异，确认后会写入业务数据。'}
          </p>
          {expired && !uncertain && (
            <p className="text-amber-800">预览已过期，请重新预览。</p>
          )}
          <Button
            size="sm"
            variant="primary"
            disabled={busy || disabled || (!uncertain && expired)}
            onClick={() => void apply()}
          >
            {busy
              ? '正在处理…'
              : uncertain
                ? '重试本次确认'
                : `确认应用 ${preview.changes.length} 项操作`}
          </Button>
        </div>
      )}
      {receipt && (
        <div
          role="status"
          className="space-y-2 rounded bg-emerald-50 p-3 text-emerald-900"
        >
          <p>
            {receipt.verified ? '操作已完成并核验' : '操作已完成'} · 回执{' '}
            {receipt.receiptId}
          </p>
          {receipt.results.map((result, index) => (
            <p key={`${result.entityId}-${index}`}>
              <Link
                className="underline"
                to={result.href}
                target="_blank"
                rel="noreferrer"
              >
                {result.title}
              </Link>
            </p>
          ))}
          {syncError && (
            <>
              <p>{syncError}</p>
              <Button size="sm" onClick={() => void synchronize()}>
                重新同步页面
              </Button>
            </>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-red-700 break-words">
          {error}
        </p>
      )}
    </section>
  )
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '未填写'
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}
