import { useCallback, useEffect, useRef, useState } from 'react'
import type { AssistantClient, AssistantRequest, AssistantTask, TaskQuestion, TaskSummary } from './client'

interface Callbacks {
  restore(job: AssistantRequest): void
  complete(row: AssistantTask, job: AssistantRequest): void
  fail(taskId: string, message: string, job?: AssistantRequest, context?: { requestId?: string; displayedInProgress: boolean }): void
}
export interface RequestProgress {
  requestId?: string
  job?: AssistantRequest
  phase: 'checking' | 'processing' | 'reconnecting' | 'auth' | 'failed'
  message?: string
}
const errorStatus = (reason: unknown) => typeof reason === 'object' && reason !== null && 'status' in reason ? Number(reason.status) : 0
const errorMessage = (reason: unknown) => reason instanceof Error ? reason.message : '读取回答进度未完成，请稍后重试。'
const failureMessage = (job: AssistantRequest) => {
  const text = job.error || '回答未完成，问题已保存，可以重新发送。'
  return /^[0-9a-f]{32}$/i.test(job.diagnosticId) && !text.includes(job.diagnosticId) ? `${text}（诊断编号：${job.diagnosticId}）` : text
}
const running = (job: AssistantRequest) => job.status === 'queued' || job.status === 'running'

// Only a request ID is stored in the browser. The owned server record holds the
// question and result, and every reconnect reads that record without resubmitting.
export default function useAssistantRequests(client: AssistantClient, namespace: string, callbacks: Callbacks) {
  const [tracked, setTracked] = useState<{ scope: string; items: Record<string, RequestProgress> }>({ scope: namespace, items: {} })
  const progress = tracked.scope === namespace ? tracked.items : {}
  const setProgress = useCallback((update: (old: Record<string, RequestProgress>) => Record<string, RequestProgress>) => setTracked(old => ({ scope: namespace, items: update(old.scope === namespace ? old.items : {}) })), [namespace])
  const callbacksRef = useRef(callbacks)
  const sessionGeneration = useRef(0)
  const alive = useRef(true), epochs = useRef(new Map<string, number>()), timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const watchers = useRef(new Map<string, () => Promise<void>>())
  const enabled = !!client.submitRequest && !!client.getRequest && !!client.activeRequest
  useEffect(() => { callbacksRef.current = callbacks }, [callbacks])
  const storageKey = useCallback((taskId: string) => `assistant-request:${namespace}:${taskId}`, [namespace])
  const remember = useCallback((taskId: string, requestId: string | null, expectedId?: string) => {
    try { if (requestId) localStorage.setItem(storageKey(taskId), requestId); else if (!expectedId || localStorage.getItem(storageKey(taskId)) === expectedId) localStorage.removeItem(storageKey(taskId)) } catch { /* The server remains authoritative. */ }
  }, [storageKey])
  const readRemembered = useCallback((taskId: string) => {
    try { const id = localStorage.getItem(storageKey(taskId)); return id && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) ? id : null } catch { return null }
  }, [storageKey])
  const clearTimer = useCallback((taskId: string) => { const timer = timers.current.get(taskId); if (timer) clearTimeout(timer); timers.current.delete(taskId) }, [])
  const stop = useCallback((taskId: string) => { clearTimer(taskId); watchers.current.delete(taskId) }, [clearTimer])
  const removeProgress = useCallback((taskId: string) => setProgress(old => { const next = { ...old }; delete next[taskId]; return next }), [setProgress])

  const watch = useCallback((taskId: string, initial?: AssistantRequest, knownId?: string) => {
    if (!enabled) return
    stop(taskId)
    const generation = sessionGeneration.current
    const epoch = (epochs.current.get(taskId) || 0) + 1
    epochs.current.set(taskId, epoch)
    let job = initial, requestId = initial?.requestId || knownId, polling = false, missingChecks = 0, settled = false, restored = false
    const current = () => !settled && alive.current && sessionGeneration.current === generation && epochs.current.get(taskId) === epoch
    const publish = (value: RequestProgress) => { if (current()) setProgress(old => ({ ...old, [taskId]: { ...value, requestId } })) }
    const schedule = (delay: number) => { if (current()) { clearTimer(taskId); timers.current.set(taskId, setTimeout(() => { void tick() }, delay)) } }
    const terminalFailure = (message: string, record?: AssistantRequest) => {
      if (!current()) return
      publish({ phase: 'failed', job: record, message }); settled = true; stop(taskId); callbacksRef.current.fail(taskId, message, record, { requestId, displayedInProgress: true })
    }
    const accept = async (record: AssistantRequest) => {
      if (!current()) return
      job = record; requestId = record.requestId
      if (!restored) {
        restored = true
        const remembered = readRemembered(taskId)
        if (!remembered || remembered === requestId || !initial && !knownId && running(record)) remember(taskId, requestId)
        if (!record.payloadExpired) callbacksRef.current.restore(record)
      }
      if (record.status === 'failed' || record.status === 'cancelled') {
        terminalFailure(failureMessage(record), record)
      } else if (record.status === 'completed') {
        publish({ phase: 'processing', job: record, message: '回答已生成，正在读取保存结果…' })
        const row = await client.get(taskId)
        if (!current()) return
        remember(taskId, null, record.requestId); settled = true; stop(taskId); removeProgress(taskId); callbacksRef.current.complete(row, record)
      } else {
        publish({ phase: 'processing', job: record }); schedule(1200)
      }
    }
    const handleError = (reason: unknown) => {
      if (!current()) return
      const status = errorStatus(reason)
      if (status === 401) {
        // Pause until focus / normal SSO recovery. Do not repeatedly trigger auth.
        publish({ phase: 'auth', message: '登录已失效，重新登录后可继续查看已保存的请求。' })
      } else if (status === 404 && !job && knownId && ++missingChecks < 3) {
        // A lost POST response can race with its server commit. Confirm before
        // releasing the send button, and retain the ID for an idempotent retry.
        publish({ phase: 'checking', message: '正在确认问题是否已保存，请勿重复发送。' }); schedule(1200)
      } else if (status === 403 || status === 404) {
        if (!knownId && status === 404) remember(taskId, null, requestId)
        terminalFailure(errorMessage(reason))
      } else {
        publish({ phase: 'reconnecting', job, message: job ? '连接暂时中断，正在重新读取进度。问题已保存，无需重复发送。' : '正在确认问题是否已提交，请勿重复发送。' })
        schedule(3000)
      }
    }
    const tick = async () => {
      if (!current() || polling) return
      polling = true; clearTimer(taskId)
      try {
        if (!requestId) {
          const active = await client.activeRequest!(taskId)
          if (!current()) return
          requestId = active.request?.requestId || readRemembered(taskId) || undefined
          if (active.request) { await accept(active.request); return }
          if (!requestId) { stop(taskId); removeProgress(taskId); return }
        }
        await accept(await client.getRequest!(taskId, requestId))
      } catch (reason) { handleError(reason)
      } finally { polling = false }
    }
    watchers.current.set(taskId, tick)
    publish({ phase: 'checking', job: initial })
    if (initial) { polling = true; void accept(initial).catch(handleError).finally(() => { polling = false }) }
    else void tick()
  }, [client, enabled, clearTimer, readRemembered, remember, removeProgress, setProgress, stop])

  const resume = useCallback((taskId: string) => { if (enabled) watch(taskId) }, [enabled, watch])
  const submit = useCallback(async (task: TaskSummary, input: TaskQuestion) => {
    if (!enabled) return
    stop(task.id)
    const generation = sessionGeneration.current
    const epoch = (epochs.current.get(task.id) || 0) + 1; epochs.current.set(task.id, epoch)
    remember(task.id, input.requestId)
    setProgress(old => ({ ...old, [task.id]: { phase: 'checking', requestId: input.requestId } }))
    try {
      const job = await client.submitRequest!(task, input)
      if (alive.current && sessionGeneration.current === generation && epochs.current.get(task.id) === epoch) watch(task.id, job)
    } catch (reason) {
      if (!alive.current || sessionGeneration.current !== generation || epochs.current.get(task.id) !== epoch) return
      const status = errorStatus(reason)
      if (status === 409) {
        try {
          const active = await client.activeRequest!(task.id)
          if (!alive.current || sessionGeneration.current !== generation || epochs.current.get(task.id) !== epoch) return
          if (active.request) { watch(task.id, active.request); return }
        } catch {
          if (alive.current && sessionGeneration.current === generation && epochs.current.get(task.id) === epoch) watch(task.id)
          return
        }
      }
      if (status === 401 || status === 403 || status === 404 || status === 409 || status === 422 || status === 429) {
        remember(task.id, null, input.requestId); removeProgress(task.id); callbacksRef.current.fail(task.id, errorMessage(reason), undefined, { requestId: input.requestId, displayedInProgress: false })
      } else {
        // The response can be lost after acceptance. Read by the same ID; never
        // start another paid model call merely because a POST response was lost.
        watch(task.id, undefined, input.requestId)
      }
    }
  }, [client, enabled, remember, removeProgress, setProgress, stop, watch])

  useEffect(() => {
    alive.current = true
    const pendingTimers = timers.current, pendingWatchers = watchers.current, pendingEpochs = epochs.current, activeGeneration = sessionGeneration.current
    const focus = () => { for (const poll of watchers.current.values()) void poll() }
    window.addEventListener('focus', focus)
    return () => { alive.current = false; sessionGeneration.current = activeGeneration + 1; for (const timer of pendingTimers.values()) clearTimeout(timer); pendingTimers.clear(); pendingWatchers.clear(); pendingEpochs.clear(); window.removeEventListener('focus', focus) }
  }, [client, namespace])
  const cancel = useCallback(async (taskId: string, requestId: string) => {
    if (!client.cancelRequest) return
    const generation = sessionGeneration.current, epoch = epochs.current.get(taskId)
    try {
      const record = await client.cancelRequest(taskId, requestId)
      if (alive.current && sessionGeneration.current === generation && epochs.current.get(taskId) === epoch) watch(taskId, record)
    } catch (reason) {
      if (alive.current && sessionGeneration.current === generation && epochs.current.get(taskId) === epoch) {
        callbacksRef.current.fail(taskId, `停止请求未确认：${errorMessage(reason)} 正在重新核对进度。`, undefined, { requestId, displayedInProgress: false })
        watch(taskId, undefined, requestId)
      }
    }
  }, [client, watch])
  const pending = Object.fromEntries(Object.entries(progress).map(([id, value]) => [id, value.phase !== 'failed' && (!value.job || running(value.job) || value.job.status === 'completed')]))
  return { enabled, progress, pending, resume, submit, cancel }
}
