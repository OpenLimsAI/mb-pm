import axios from 'axios'
import { api } from './client'

export type AIProvider = 'deepseek' | 'minimax' | 'kimi' | 'ollama'
export const providerLabels: Record<AIProvider, string> = {
  deepseek: 'DeepSeek', minimax: 'MiniMax', kimi: 'Kimi / 月之暗面', ollama: 'Ollama 本地模型',
}
/** 历史报告可能来自已下线的服务商，显示时兜底 */
export const providerLabel = (p: string) => providerLabels[p as AIProvider] ?? p
/** 分析提示词长度上限（与后端 MAX_PROMPT_LENGTH 一致） */
export const MAX_PROMPT_LENGTH = 4000
export interface ProviderConfig {
  baseUrl: string
  model: string
  keySet: boolean
  apiKey?: string
  clearKey?: boolean
}
export interface AISettings {
  revision?: number
  provider: string
  offlineFallback: boolean
  providers: Record<string, ProviderConfig>
  /** 默认项目分析提示词（分析什么、按什么结构输出） */
  analysisPrompt: string
  /** 系统默认提示词（只读，用于「恢复系统默认」） */
  defaultAnalysisPrompt: string
  /** 默认财务分析提示词 */
  financeAnalysisPrompt: string
  defaultFinanceAnalysisPrompt: string
}
export interface AISettingsWrite extends Omit<AISettings, 'provider' | 'providers'> {
  provider: AIProvider
  providers: Partial<Record<AIProvider, ProviderConfig>>
  preserveSharedModels?: boolean
}
export interface AIStatus {
  provider: AIProvider
  model: string
  ready: boolean
  offlineFallback: boolean
  /** 当前默认分析提示词（项目分析面板预填） */
  analysisPrompt: string
  /** 当前默认财务分析提示词（财务分析面板预填） */
  financeAnalysisPrompt: string
}
/** 同一套 AI 分析体系下的两类报告 */
export type AIAnalysisKind = 'project' | 'finance'
export interface AIAnalysis {
  id: string
  /** 项目分析才有 */
  projectId?: string
  createdAt: string
  provider: AIProvider
  model: string
  focus: string
  /** 本次实际使用的分析提示词 */
  prompt: string
  content: string
  stale: boolean
  source: {
    asOf: string
    budgetUnit: string
    // 项目分析
    taskCount?: number
    milestoneCount?: number
    overdueCount?: number
    // 财务分析
    projectCount?: number
    budgetedProjectCount?: number
    overBudgetCount?: number
  }
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

export const getAIStatus = async () => (await api.get<AIStatus>('/ai/status')).data
// 项目管理会话；请求与响应的键名由 api 拦截器统一转换。
export const getAISettings = async () => (await api.get<AISettings>('/ai/settings')).data
export const saveAISettings = async (settings: AISettingsWrite) => (await api.put<AISettings>('/ai/settings', settings)).data
export const getAIModels = async (provider: AIProvider, config: ProviderConfig) =>
  (await api.post<{ models: string[] }>('/ai/models', { provider, config }, { timeout: 35000 })).data
export const testAIConnection = async (provider: AIProvider, config: ProviderConfig) =>
  (await api.post<{ ok: boolean; ms: number; model: string }>('/ai/test', { provider, config }, { timeout: 135000 })).data
export const getAIAnalyses = async (id: string) => (await api.get<AIAnalysis[]>(`/projects/${encodeURIComponent(id)}/ai-analyses`)).data
export const generateAIAnalysis = async (id: string, focus: string, prompt: string) => (await api.post<AIAnalysis>(`/projects/${encodeURIComponent(id)}/ai-analyses`, { focus, prompt }, { timeout: 450000 })).data
export const getFinanceAIAnalyses = async () => (await api.get<AIAnalysis[]>('/finances/ai-analyses')).data
export const generateFinanceAIAnalysis = async (focus: string, prompt: string) => (await api.post<AIAnalysis>('/finances/ai-analyses', { focus, prompt }, { timeout: 450000 })).data
