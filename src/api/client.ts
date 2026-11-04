// Axios 客户端 + IAM 会话 + snake_case ↔ camelCase 双向转换
//
// 后端是 Python（snake_case），前端是 TS（camelCase）。这里在拦截器层
// 自动转换，业务代码就只需要看到 camelCase 风格。
//
// 认证：由后端与 mb-casd（Casdoor）完成授权码 + PKCE 登录，浏览器只持有 HttpOnly
// 会话 cookie —— 前端不接触、也不存储任何 token。

import axios, { type AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios'

// ============= 数据源开关 =============

/** 是否启用后端 API。env 未设置 / false → 用 mock 数据。 */
export const USE_API = import.meta.env.VITE_USE_API === 'true'

// 默认相对路径 /api/v1（与页面同源）：
//   - 单镜像部署：FastAPI 同源托管前端；
//   - 本地 `npm run dev`：vite.config.ts 的 server.proxy 把 /api 转发到 FastAPI。
// 会话 cookie 与登录回调都依赖同源，一般无需用 VITE_API_URL 覆盖。
export const API_BASE = (import.meta.env.VITE_API_URL as string) || '/api/v1'

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

// ============= Axios 实例 =============

export const api = axios.create({
  baseURL: API_BASE,
  withCredentials: true,
  timeout: 15000,
})

// 请求：会话 cookie 由浏览器自动携带；body / query 转 snake_case
api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  if (config.data && typeof config.data === 'object') {
    config.data = snakeize(config.data)
  }
  if (config.params && typeof config.params === 'object') {
    config.params = snakeize(config.params)
  }
  return config
})

// 响应：body 转 camelCase；401（会话过期 / 已登出）广播给 auth store，由路由守卫跳登录页
api.interceptors.response.use(
  (response: AxiosResponse) => {
    if (response.data) response.data = camelize(response.data)
    return response
  },
  (error: AxiosError) => {
    if (error.response?.status === 401) {
      window.dispatchEvent(new Event('pms:unauthorized'))
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
    const data = err.response?.data as { detail?: unknown } | undefined
    const value = data?.detail
    const detail = typeof value === 'string' ? value
      : Array.isArray(value) ? value.map(item => typeof item?.msg === 'string' ? item.msg : '输入格式无效').join('；')
      : value && typeof value === 'object' && 'message' in value && typeof value.message === 'string' ? value.message
      : undefined
    return {
      detail: detail || err.message || '网络错误',
      status: err.response?.status,
    }
  }
  return { detail: String(err) }
}

/** 后端明确拒绝（4xx，如「仍负责本项目任务，不能移出团队」）时显示其说明；网络错误等显示 fallback。 */
export function rejectionText(err: unknown, fallback: string): string {
  const { status, detail } = asAPIError(err)
  return status !== undefined && status >= 400 && status < 500 && typeof detail === 'string' && detail ? detail : fallback
}
