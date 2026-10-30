import axios from 'axios'
import { API_BASE, camelize, snakeize } from '../../api/client'

export type ModelProvider = 'deepseek' | 'minimax' | 'glm' | 'openai' | 'custom'
export interface ModelProfile { id: string; name: string; provider: ModelProvider; baseUrl: string; model: string; keySet: boolean }
export interface ModelSettings { profiles: ModelProfile[]; defaultProfileId: string | null; revision: number }
export interface ModelProfileDraft extends Omit<ModelProfile, 'keySet'> { apiKey?: string; clearKey?: boolean }
export type DraftModelProfile = ModelProfileDraft
export interface ModelSettingsInput { profiles: ModelProfileDraft[]; defaultProfileId: string | null; revision: number }
export interface ModelTestResult { ok: boolean; model: string; ms: number }
export interface ModelSettingsClient { get(): Promise<ModelSettings>; save(input: ModelSettingsInput): Promise<ModelSettings>; test(profile: ModelProfileDraft): Promise<ModelTestResult> }

export const MAX_MODEL_PROFILES = 20
export const modelProviderLabels: Record<ModelProvider, string> = { deepseek: 'DeepSeek', minimax: 'MiniMax', glm: '智谱 GLM', openai: 'OpenAI', custom: '自定义 / OpenAI 兼容' }
export const modelProviderEndpoints: Record<ModelProvider, string> = { deepseek: 'https://api.deepseek.com', minimax: 'https://api.minimax.io/v1', glm: 'https://open.bigmodel.cn/api/paas/v4', openai: 'https://api.openai.com/v1', custom: '' }
const providers = Object.keys(modelProviderLabels) as ModelProvider[]
const emptySettings = (): ModelSettings => ({ profiles: [], defaultProfileId: null, revision: 0 })

/** Match the backend's harmless URL normalization without resolving paths or removing explicit ports. */
export function modelEndpointIdentity(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  const parts = /^([a-z]+):\/\/([^/?#]+)([^?#]*)$/i.exec(trimmed)
  if (!parts || parts[2].includes('@')) return trimmed
  const authority = parts[2].toLowerCase().replace(/^([^:[\]]+)(:\d+)?$/, (_match, host: string, port: string | undefined) => host.replace(/\.+$/, '') + (port || ''))
  return `${parts[1].toLowerCase()}://${authority}${parts[3]}`
}

/** Whitelist request fields so stored key flags and unrelated properties never travel to the API. */
export function modelProfileDraft(profile: ModelProfileDraft): ModelProfileDraft {
  return { id: profile.id, name: profile.name.trim(), provider: profile.provider, baseUrl: profile.baseUrl.trim(), model: profile.model.trim(), ...(profile.apiKey ? { apiKey: profile.apiKey } : {}), ...(profile.clearKey ? { clearKey: true } : {}) }
}

export function validateModelProfile(profile: ModelProfileDraft): string | null {
  if (!profile.id || profile.id.length > 80) return '配置标识无效，请重新添加此配置。'
  if (!profile.name.trim() || profile.name.trim().length > 80) return '请输入 1–80 字的配置名称。'
  if (!providers.includes(profile.provider)) return '请选择支持的服务商。'
  if (!profile.model.trim() || profile.model.trim().length > 160) return '请输入 1–160 字的模型名称。'
  if (!profile.baseUrl.trim() || profile.baseUrl.trim().length > 500) return '请输入服务地址，最多 500 字。'
  try { const url = new URL(profile.baseUrl.trim()); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return '服务地址须为 HTTP(S) 地址，不含账号、密钥、查询参数或片段。' } catch { return '请输入完整的 HTTP(S) 服务地址。' }
  if (profile.apiKey && (profile.apiKey.length > 2000 || /[\r\n]/.test(profile.apiKey))) return 'API 密钥最多 2,000 字，不能包含换行。'
  if (profile.apiKey && profile.clearKey) return '请在输入新密钥和清除密钥之间选择一项。'
  return null
}

function cleanSettings(value: unknown, preview = false): ModelSettings {
  if (!value || typeof value !== 'object') throw new Error('模型配置响应无效，请重试。')
  const data = value as ModelSettings
  if (!Array.isArray(data.profiles) || data.profiles.length > MAX_MODEL_PROFILES || !Number.isSafeInteger(data.revision) || data.revision < 0) throw new Error('模型配置响应无效，请重试。')
  const seen = new Set<string>()
  const profiles = data.profiles.map(profile => {
    if (!profile || typeof profile.id !== 'string' || typeof profile.name !== 'string' || typeof profile.baseUrl !== 'string' || typeof profile.model !== 'string' || !providers.includes(profile.provider) || typeof profile.keySet !== 'boolean' || seen.has(profile.id)) throw new Error('模型配置响应无效，请重试。')
    seen.add(profile.id)
    return { id: profile.id, name: profile.name, provider: profile.provider, baseUrl: profile.baseUrl, model: profile.model, keySet: preview ? false : profile.keySet }
  })
  if (data.defaultProfileId !== null && !profiles.some(profile => profile.id === data.defaultProfileId)) throw new Error('默认模型配置无效，请重新选择。')
  return { profiles, defaultProfileId: data.defaultProfileId, revision: data.revision }
}

export function createModelSettingsClient(): ModelSettingsClient {
  const http = axios.create({ baseURL: `${API_BASE}/solutions/ai`, withCredentials: true, timeout: 135000 })
  http.interceptors.request.use(config => { if (config.data) config.data = snakeize(config.data); return config })
  http.interceptors.response.use(response => { response.data = camelize(response.data); return response }, (error: unknown) => {
    const status = axios.isAxiosError(error) ? error.response?.status : undefined
    if (status === 401) window.dispatchEvent(new Event('solutions:unauthorized'))
    // Provider errors can contain request headers or credentials; never expose their payload/config/cause.
    const text = status === 401 ? '登录已失效，请重新登录后重试。'
      : status === 409 ? '模型设置已被其他页面更新。草稿仍保留，请重新打开设置后核对。'
        : status === 422 ? '配置未通过校验，请检查名称、模型、地址和密钥。'
          : status === 403 ? '当前账号无权访问模型设置。'
            : axios.isAxiosError(error) && error.code === 'ECONNABORTED' ? '连接测试超时，请检查服务地址后重试。'
              : '模型服务请求失败，请检查配置或稍后重试。'
    return Promise.reject(Object.assign(new Error(text), { status }))
  })
  return {
    get: async () => cleanSettings((await http.get('/settings')).data),
    save: async input => cleanSettings((await http.put('/settings', { profiles: input.profiles.map(modelProfileDraft), defaultProfileId: input.defaultProfileId, revision: input.revision })).data),
    test: async profile => { const data = (await http.post('/test', { profile: modelProfileDraft(profile) })).data as ModelTestResult; return { ok: data.ok === true, model: typeof data.model === 'string' ? data.model : '', ms: Number.isFinite(data.ms) ? Math.max(0, data.ms) : 0 } },
  }
}
export const modelSettingsApi = createModelSettingsClient()

export function createPreviewModelClient(namespace: string): ModelSettingsClient {
  const key = `ks-preview-model-settings:${encodeURIComponent(namespace)}`
  const read = (): ModelSettings => {
    try { const raw = localStorage.getItem(key); return raw ? cleanSettings(JSON.parse(raw), true) : emptySettings() }
    catch { throw new Error('无法读取本机模型配置，已有数据未被覆盖。请检查浏览器存储后重试。') }
  }
  return {
    get: async () => read(),
    save: async input => {
      if (input.profiles.some(profile => profile.apiKey)) throw new Error('预览模式不能保存真实 API 密钥，请移除密钥后重试。')
      if (input.profiles.length > MAX_MODEL_PROFILES) throw new Error(`最多保存 ${MAX_MODEL_PROFILES} 组模型配置。`)
      for (const profile of input.profiles) { const error = validateModelProfile(profile); if (error) throw new Error(error) }
      const current = read()
      if (current.revision !== input.revision) throw Object.assign(new Error('预览配置已在其他页面更新，请重新打开设置。'), { status: 409 })
      const saved = cleanSettings({ profiles: input.profiles.map(profile => ({ ...modelProfileDraft(profile), keySet: false })), defaultProfileId: input.defaultProfileId, revision: current.revision + 1 }, true)
      try { localStorage.setItem(key, JSON.stringify(saved)) } catch { throw new Error('浏览器未允许保存预览配置。当前草稿仍保留。') }
      return saved
    },
    test: async () => { throw new Error('预览不调用模型。请在真实登录环境配置并测试连接。') },
  }
}
