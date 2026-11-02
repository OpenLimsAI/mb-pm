import axios from 'axios'
import { API_BASE, camelize, snakeize } from '../../api/client'

export interface AssistantLimits {
  perUserPending: number
  globalQueued: number
  perUserRunning: number
  retentionDays: number
}
export interface OperationRequest {
  requestId: string
  diagnosticId: string
  status: string
  stage: string
  errorCode: string
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  elapsedSeconds: number | null
  firstContentSeconds?: number | null
}
export interface AssistantOperations {
  limits: AssistantLimits
  totals: Record<string, number>
  windowHours: number
  failureCounts: Record<string, number>
  recent: OperationRequest[]
  canManage: boolean
}
const http = axios.create({ baseURL: `${API_BASE}/assistant/tasks/operations`, withCredentials: true, timeout: 15000 })
export const assistantOperationsApi = {
  async get(diagnosticId = ''): Promise<AssistantOperations> {
    const response = await http.get('', { params: diagnosticId ? { diagnostic_id: diagnosticId } : undefined })
    // Failure codes are values in a dictionary, not API field names.
    return { ...camelize<AssistantOperations>(response.data), failureCounts: response.data.failure_counts }
  },
  async save(input: AssistantLimits): Promise<AssistantLimits> {
    return camelize<{ limits: AssistantLimits }>((await http.put('/settings', snakeize(input))).data).limits
  },
  async prune(): Promise<{ pruned: number }> { return (await http.post('/prune', {})).data },
}
export function operationsError(reason: unknown): string {
  if (axios.isAxiosError(reason)) {
    if (reason.response?.status === 401) { window.dispatchEvent(new Event('portal:unauthorized')); return '登录已失效，请重新登录后查看。' }
    const detail = reason.response?.data?.detail
    if (typeof detail === 'string') return detail
  }
  return '暂时无法读取助手运行状态，请稍后重试。'
}

export function operationsDenied(reason: unknown) { return axios.isAxiosError(reason) && reason.response?.status === 403 }
