import { create } from 'zustand'
import { asAPIError } from '../api/client'
import {
  fetchPortalIdentity, getPortalLoginUrl, portalLogoutUrl,
  type PortalApplication, type PortalUser,
} from '../api/portal'

type PortalStatus = 'loading' | 'ready' | 'anonymous' | 'error'

interface PortalState {
  user: PortalUser | null
  identityNamespace?: string
  applications: PortalApplication[]
  mustChangePassword: boolean
  canConfigureAi: boolean
  status: PortalStatus
  error: string | null
  /** A temporary identity-service failure after a previously verified login. */
  refreshError: string | null
  refresh: () => Promise<void>
  login: (returnTo?: string) => Promise<void>
  logout: () => void
}

let refreshing: Promise<void> | undefined

export const usePortal = create<PortalState>((set, get) => ({
  user: null,
  applications: [],
  mustChangePassword: false,
  canConfigureAi: false,
  status: 'loading',
  error: null,
  refreshError: null,
  refresh: () => {
    if (!refreshing) {
      refreshing = fetchPortalIdentity()
        .then(({ user, identityNamespace, applications, mustChangePassword, canConfigureAi }) => set({ user, identityNamespace, applications, mustChangePassword: !!mustChangePassword, canConfigureAi: !!canConfigureAi, status: 'ready', error: null, refreshError: null }))
        .catch((err) => {
          const { status, detail } = asAPIError(err)
          if (get().status === 'ready' && get().user && (status === undefined || status >= 500)) {
            // Keep the mounted editor; every server request still enforces authentication.
            set({ refreshError: '暂时无法确认登录状态，当前页面已保留。请重试；需要身份验证的操作可能暂时无法完成。' })
            return
          }
          set({
            user: null,
            identityNamespace: undefined,
            applications: [],
            mustChangePassword: false,
            canConfigureAi: false,
            status: status === 401 ? 'anonymous' : 'error',
            error: status === undefined ? '暂时无法连接工作台登录服务，请检查网络后重试。' : detail,
            refreshError: null,
          })
        })
        .finally(() => { refreshing = undefined })
    }
    return refreshing
  },
  login: async (returnTo = '/') => {
    const url = new URL(await getPortalLoginUrl())
    url.searchParams.set('return_to', returnTo)
    window.location.assign(url.toString())
  },
  logout: () => {
    const form = document.createElement('form')
    form.method = 'POST'
    form.action = portalLogoutUrl
    document.body.appendChild(form)
    form.submit()
  },
}))
