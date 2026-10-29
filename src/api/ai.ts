import axios from 'axios'
import { api } from './client'

export type AIProvider = 'deepseek' | 'minimax' | 'openai' | 'custom' | 'ollama'
export const providerLabels: Record<AIProvider, string> = {
  deepseek: 'DeepSeek', minimax: 'MiniMax', openai: 'OpenAI', custom: '自定义兼容 API', ollama: 'Ollama 本地模型',
}
export interface ProviderConfig {
  baseUrl: string
  model: string
  keySet: boolean
  apiKey?: string
  clearKey?: boolean
}
export interface AISettings {
  provider: AIProvider
  offlineFallback: boolean
  providers: Record<AIProvider, ProviderConfig>
}
export interface AIStatus {
  provider: AIProvider
  model: string
  ready: boolean
  offlineFallback: boolean
}
export interface AIAnalysis {
  id: string
  projectId: string
  createdAt: string
  provider: AIProvider
  model: string
  focus: string
  content: string
  stale: boolean
  source: { asOf: string; taskCount: number; milestoneCount: number; overdueCount: number; budgetUnit: string }
  usage: { fallback: boolean; totalTokens?: number }
}

export function aiError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const detail = error.response?.data?.detail
    if (typeof detail === 'string') return detail
    if (Array.isArray(detail)) return detail.map((d: { msg?: string }) => d.msg || '输入无效').join('；')
    if (error.code === 'ECONNABORTED') return '等待模型响应超时，请稍后刷新分析记录，或换用响应更快的模型。'
    return '服务请求失败，请确认后端已启动后重试。'
  }
  return '操作失败，请重试。'
}

export const getAISettings = async () => (await api.get<AISettings>('/ai/settings')).data
export const saveAISettings = async (settings: AISettings) => (await api.put<AISettings>('/ai/settings', settings)).data
export const getAIStatus = async () => (await api.get<AIStatus>('/ai/status')).data
export const getAIModels = async (provider: AIProvider, config: ProviderConfig) => (await api.post<{ models: string[] }>('/ai/models', { provider, config }, { timeout: 35000 })).data
export const testAIConnection = async (provider: AIProvider, config: ProviderConfig) => (await api.post<{ ok: boolean; ms: number; model: string }>('/ai/test', { provider, config }, { timeout: 135000 })).data
export const getAIAnalyses = async (id: string) => (await api.get<AIAnalysis[]>(`/projects/${encodeURIComponent(id)}/ai-analyses`)).data
export const generateAIAnalysis = async (id: string, focus: string) => (await api.post<AIAnalysis>(`/projects/${encodeURIComponent(id)}/ai-analyses`, { focus }, { timeout: 450000 })).data
