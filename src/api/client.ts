// Axios 客户端 + JWT 拦截器 + snake_case ↔ camelCase 双向转换
//
// 后端是 Python（snake_case），前端是 TS（camelCase）。这里在拦截器层
// 自动转换，业务代码就只需要看到 camelCase 风格。

import axios, { type AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios'

const TOKEN_KEY = 'cmc-pms-lite-jwt'  // Lite 版独立 token key

// ============= 数据源开关 =============

/** 是否启用后端 API。env 未设置 / false → 用 mock 数据。 */
export const USE_API = import.meta.env.VITE_USE_API === 'true'

const baseURL = (import.meta.env.VITE_API_URL as string) || 'http://localhost:8000/api/v1'

// ============= snake_case <-> camelCase =============

const toCamel = (s: string): string => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
const toSnake = (s: string): string => s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())

function deepConvertKeys(obj: unknown, conv: (k: string) => string): unknown {
  if (Array.isArray(obj)) return obj.map((v) => deepConvertKeys(v, conv))
  if (obj && typeof obj === 'object' && obj.constructor === Object) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) out[conv(k)] = deepConvertKeys(v, conv)
    return out
  }
  return obj
}

export const camelize = <T = unknown>(o: unknown): T => deepConvertKeys(o, toCamel) as T
export const snakeize = <T = unknown>(o: unknown): T => deepConvertKeys(o, toSnake) as T

// ============= JWT 存储 =============

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}
export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token)
  else localStorage.removeItem(TOKEN_KEY)
}

// ============= Axios 实例 =============

export const api = axios.create({
  baseURL,
  timeout: 15000,
})

// 请求：自动加 Bearer token + body 转 snake_case
api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const token = getToken()
  if (token) {
    config.headers.set?.('Authorization', `Bearer ${token}`)
  }
  if (config.data && typeof config.data === 'object') {
    config.data = snakeize(config.data)
  }
  if (config.params && typeof config.params === 'object') {
    config.params = snakeize(config.params)
  }
  return config
})

// 响应：body 转 camelCase + 401 处理
api.interceptors.response.use(
  (response: AxiosResponse) => {
    if (response.data) response.data = camelize(response.data)
    return response
  },
  (error: AxiosError) => {
    if (error.response?.status === 401) {
      // token 失效 → 清掉，业务侧捕获后跳登录页
      setToken(null)
    }
    if (error.response?.data) {
      error.response.data = camelize(error.response.data)
    }
    return Promise.reject(error)
  },
)

// ============= 通用错误辅助 =============

export interface APIError {
  detail: string
  status?: number
}

export function asAPIError(err: unknown): APIError {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as { detail?: string } | undefined
    return {
      detail: data?.detail || err.message || '网络错误',
      status: err.response?.status,
    }
  }
  return { detail: String(err) }
}
