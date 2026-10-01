// 认证 store —— 当前用户只来自后端 /auth/me（mb-casd IAM 会话），角色绝不从 localStorage 恢复。
import { create } from 'zustand'
import type { User } from '../types'
import { fetchMe, getLoginUrl, logoutUrl } from '../api/auth'
import { asAPIError } from '../api/client'

/**
 * loading   首次验证中
 * ready     已登录（currentUser 有值）
 * anonymous 未登录 / 会话过期 → 路由守卫跳 /login
 * offline   连不上后端（仅本地开发会出现）或未启用 API → 离线演示数据
 * error     连上了后端但身份不可用（如账号被停用、IAM 暂不可用）
 */
export type AuthStatus = 'loading' | 'ready' | 'anonymous' | 'offline' | 'error'

interface AuthState {
  currentUser: User | null
  status: AuthStatus
  error: string | null
  /** 重新向后端确认登录身份（并发调用合并为一次请求）。 */
  refresh: () => Promise<void>
  /** 跳转到 IAM 登录；returnTo 为登录成功后回到的站内路径。 */
  login: (returnTo?: string) => Promise<void>
  /** 退出：销毁业务会话并清除 Casdoor SSO，最后回到 /login。 */
  logout: () => void
}

let refreshing: Promise<void> | undefined

export const useAuth = create<AuthState>((set) => ({
  currentUser: null,
  status: 'loading',
  error: null,
  refresh: () => {
    if (!refreshing) {
      refreshing = fetchMe()
        .then((user) => set({ currentUser: user as unknown as User, status: 'ready', error: null }))
        .catch((err) => {
          const { status, detail } = asAPIError(err)
          set({
            currentUser: null,
            status: status === 401 ? 'anonymous' : status === undefined ? 'offline' : 'error',
            error: detail,
          })
        })
        .finally(() => { refreshing = undefined })
    }
    return refreshing
  },
  login: async (returnTo = '/') => {
    const url = new URL(await getLoginUrl())
    url.searchParams.set('return_to', returnTo)
    window.location.assign(url.toString())
  },
  logout: () => {
    // 顶层表单 POST（带 Origin，满足后端 CSRF 校验）；后端 303 → Casdoor /api/logout → /login。
    const form = document.createElement('form')
    form.method = 'POST'
    form.action = logoutUrl
    document.body.appendChild(form)
    form.submit()
  },
}))

// 任一请求 401（会话过期 / 在别处登出）→ 回到未登录态，路由守卫随即跳登录页。
window.addEventListener('pms:unauthorized', () => {
  useAuth.setState({ currentUser: null, status: 'anonymous', error: null })
})

// 清理旧版留在浏览器里的令牌（演示 JWT、oidc-client-ts 的用户与 token），不信任其内容。
try {
  localStorage.removeItem('cmc-pms-lite-jwt')
  Object.keys(localStorage)
    .filter((k) => k.startsWith('oidc.'))
    .forEach((k) => localStorage.removeItem(k))
} catch {
  // localStorage 不可用（隐私模式等）时忽略
}
