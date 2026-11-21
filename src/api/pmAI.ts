import { api } from './client'
import type { ScheduleAssistPreview } from './projectAIWork'

export type PMAIScenario =
  | 'priorities'
  | 'explain'
  | 'weekly'
  | 'meeting'
  | 'followup'
export interface PMAIRequest {
  scenario: PMAIScenario
  projectIds: string[]
  taskIds: string[]
  startDate?: string
  endDate?: string
  question: string
  material: string
}
export interface PMAIScope {
  projectIds: string[]
  taskIds: string[]
}
export interface PMAgentTarget {
  kind: 'project' | 'task'
  id: string
  projectId: string
  code: string
  name: string
  projectName: string
}
export interface PMTaskFilters {
  ownerId?: string | null
  ownerName?: string | null
  priority?: '高' | '中' | '低' | null
  startDate?: string | null
  endDate?: string | null
}
export interface PMAgentPlan extends PMAIScope, PMTaskFilters {
  status: 'ready' | 'clarify'
  scenario: PMAIScenario | 'schedule' | 'assessment' | 'finance' | 'settings' | null
  targets: PMAgentTarget[]
  choices: PMAgentTarget[]
  message: string
  limit: number
  mineOnly?: boolean
  startDate?: string | null
  endDate?: string | null
  delays?: number[]
  taskFilter?: 'attention' | 'overdue' | 'delayed' | 'blocked'
  scheduleInstruction?: string | null
}
export interface PMAgentTriage {
  filters?: PMTaskFilters
  taskFilter?: 'attention' | 'overdue' | 'delayed' | 'blocked'
  businessDate: string
  items: {
    taskId: string
    projectId: string
    code: string
    name: string
    projectName: string
    status: string
    plannedEnd: string
    ownerName: string
    reasons: string[]
    href: string
  }[]
  totalCandidates: number
  limit: number
}
export interface PMAIEvidence {
  id: string
  type: string
  entityId: string
  title: string
  href: string
  observedAt: string
  revision?: number
  excerpt?: string
}
export interface PMAISource {
  schemaVersion: number
  asOf: string
  complete: boolean
  truncated?: boolean | string[]
  counts?: Record<string, number>
  refs: PMAIEvidence[]
}
export interface PMAIAction {
  kind: 'task_update' | 'task_create' | 'register_create' | 'register_update'
  evidenceIds: string[]
  reason: string
  projectId?: string
  taskId?: string
  subProjectId?: string
  ownerId?: string
  name?: string
  title?: string
  plannedStart?: string
  plannedEnd?: string
  expectedRevision?: number
  progress?: number
  status?: string
  actualEffort?: number
  notes?: string
  registerKind?: 'risk' | 'issue' | 'decision'
  dueDate?: string
  severity?: 'low' | 'medium' | 'high'
  mitigation?: string
  entryId?: string
  closure?: string
}
export interface PMAIGeneration {
  version: 1
  attempts: {
    number: number
    outputBudget: number
    finishReason: string | null
    errorCode: string | null
    usage: {
      promptTokens?: number
      completionTokens?: number
      totalTokens?: number
      reasoningTokens?: number
    }
    durationMs: number
  }[]
  recoveryAttempted: boolean
  recovered: boolean
  errorCode: string | null
}
export interface PMAIWorkflow {
  version: 1
  phase: 'analysis' | 'synthesis' | 'finalizing' | 'complete'
  completedSteps: number
  totalSteps: number
  callsUsed: number
  callLimit: number
  tokenBudgetUsed: number
  window: {
    number: number
    callsUsed: number
    callLimit: number
    tokenBudgetUsed: number
    tokenLimit: number
    secondsLimit: number
  }
  pauseReason: string | null
  canResume: boolean
  steps: {
    id: string
    title: string
    kind: 'analysis' | 'synthesis'
    state: 'pending' | 'running' | 'completed' | 'split'
    depth: number
    calls: number
    durationMs: number
  }[]
  sections: { title: string; summary: string; evidenceIds: string[] }[]
}
export interface PMAIRun {
  id: string
  state: 'queued' | 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled'
  request: PMAIRequest
  scope?: PMAIScope
  scenario: PMAIScenario
  createdAt: string
  startedAt?: string | null
  finishedAt?: string | null
  source: PMAISource
  result: {
    summary: string
    findings: {
      title: string
      detail: string
      kind?: 'fact' | 'inference' | 'gap'
      evidenceIds: string[]
    }[]
    draftActions: PMAIAction[]
  } | null
  provider?: string | null
  model?: string | null
  error: string
  generation?: PMAIGeneration | null
  workflow?: PMAIWorkflow | null
  stale?: boolean
  staleReason?: 'context_budget'
}
export interface PMAIContext {
  schemaVersion: number
  scope: PMAIScope
  asOf: string
  timezone: string
  projects: { id: string; code: string; name: string; ownerId: string }[]
  tasks: {
    id: string
    projectId: string
    subProjectId: string
    code: string
    name: string
    ownerId: string
    revision: number
  }[]
  members: { id: string; name: string }[]
  subProjects: { id: string; projectId: string; name: string }[]
  registerEntries: {
    id: string
    projectId: string
    title: string
    revision: number
  }[]
  source: PMAISource
}
export type PMAIReviewContext = Pick<PMAIContext, 'projects' | 'tasks' | 'members' | 'subProjects' | 'registerEntries' | 'asOf'>

export interface PMAIChangePreview {
  actions: PMAIAction[]
  changes: {
    kind: string
    entityId: string
    title: string
    before: Record<string, unknown>
    after: Record<string, unknown>
    evidenceIds: string[]
  }[]
  confirmationToken: string
  expiresAt: string
}
export interface PMAIReceipt {
  receiptId: string
  replayed: boolean
  results: { kind: string; entityId: string; title: string; href: string }[]
  verified: boolean
}
const root = '/pm-ai'
const runPath = (id: string) => `${root}/runs/${encodeURIComponent(id)}`
const actionFields: Record<PMAIAction['kind'], string[]> = {
  task_update: [
    'taskId',
    'expectedRevision',
    'progress',
    'status',
    'actualEffort',
    'notes',
  ],
  task_create: [
    'projectId',
    'subProjectId',
    'ownerId',
    'name',
    'plannedStart',
    'plannedEnd',
  ],
  register_create: [
    'projectId',
    'registerKind',
    'title',
    'ownerId',
    'dueDate',
    'severity',
    'mitigation',
  ],
  register_update: [
    'entryId',
    'expectedRevision',
    'status',
    'closure',
    'mitigation',
  ],
}
function actionPayload(action: PMAIAction) {
  const allowed = new Set([
    'kind',
    'evidenceIds',
    'reason',
    ...actionFields[action.kind],
  ])
  return Object.fromEntries(
    Object.entries(action).filter(
      ([key, value]) => allowed.has(key) && value !== undefined,
    ),
  )
}
export const pmAI = {
  plan: async (question: string, projectId?: string, taskId?: string) =>
    (
      await api.post<PMAgentPlan>(`${root}/agent/plan`, {
        question,
        projectId,
        taskId,
      })
    ).data,
  triage: async (scope: PMAIScope, limit: number, mineOnly: boolean, taskFilter?: PMAgentPlan['taskFilter'], filters?: PMTaskFilters) =>
    (
      await api.post<PMAgentTriage>(`${root}/agent/triage`, {
        ...scope,
        limit,
        mineOnly,
        ...(taskFilter ? { taskFilter } : {}),
        ...(filters ? { ownerId: filters.ownerId, priority: filters.priority, startDate: filters.startDate, endDate: filters.endDate } : {}),
      })
    ).data,
  context: async (projectId?: string) =>
    (await api.get<PMAIContext>(`${root}/context`, { params: { projectId } }))
      .data,
  list: async (projectId?: string, taskId?: string) =>
    (
      await api.get<{ items: PMAIRun[]; total: number }>(`${root}/runs`, {
        params: { pageSize: 30, projectId, taskId },
      })
    ).data,
  reviewContext: async (id: string, batch: number) =>
    (await api.get<PMAIReviewContext>(`${runPath(id)}/review-context`, { params: { batch } })).data,
  create: async (request: PMAIRequest) =>
    (await api.post<PMAIRun>(`${root}/runs`, request)).data,
  get: async (id: string) => (await api.get<PMAIRun>(runPath(id))).data,
  cancel: async (id: string) =>
    (await api.post<PMAIRun>(`${runPath(id)}/cancel`)).data,
  resume: async (id: string) =>
    (await api.post<PMAIRun>(`${runPath(id)}/resume`)).data,
  preview: async (id: string, actions: PMAIAction[]) =>
    (
      await api.post<PMAIChangePreview>(`${runPath(id)}/changes/preview`, {
        actions: actions.map(actionPayload),
      })
    ).data,
  apply: async (id: string, confirmationToken: string) =>
    (
      await api.post<PMAIReceipt>(`${runPath(id)}/changes/apply`, {
        confirmationToken,
      })
    ).data,
  receipts: async (id: string) =>
    (
      await api.get<(PMAIReceipt & { createdAt: string })[]>(
        `${runPath(id)}/changes/receipts`,
      )
    ).data,
  compare: async (
    projectId: string,
    taskId: string,
    delays: number[],
    lockedIds: string[],
  ) =>
    (
      await api.post<{ plans: ScheduleAssistPreview[] }>(
        `${root}/schedule/compare`,
        { projectId, taskId, delays, lockedIds },
      )
    ).data,
}
