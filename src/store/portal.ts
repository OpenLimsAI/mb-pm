import { create } from 'zustand'
import { asAPIError } from '../api/client'
import {
  fetchPortalIdentity, getPortalLoginUrl, portalLogoutUrl,
  type PortalApplication, type PortalUser,
} from '../api/portal'

type PortalStatus = 'loading' | 'ready' | 'anonymous' | 'error'

interface PortalState {
  user: PortalUser | null
  applications: PortalApplication[]
  mustChangePassword: boolean
  canConfigureAi: boolean
  status: PortalStatus
  error: string | null
  refresh: () => Promise<void>
  login: (returnTo?: string) => Promise<void>
  logout: () => void
}

let refreshing: Promise<void> | undefined

export const usePortal = create<PortalState>((set) => ({
  user: null,
  applications: [],
  mustChangePassword: false,
  canConfigureAi: false,
  status: 'loading',
  error: null,
  refresh: () => {
    if (!refreshing) {
      refreshing = fetchPortalIdentity()
        .then(({ user, applications, mustChangePassword, canConfigureAi }) => set({ user, applications, mustChangePassword: !!mustChangePassword, canConfigureAi: !!canConfigureAi, status: 'ready', error: null }))
        .catch((err) => {
          const { status, detail } = asAPIError(err)
          set({
            user: null,
            applications: [],
            mustChangePassword: false,
            canConfigureAi: false,
            status: status === 401 ? 'anonymous' : 'error',
            error: status === undefined ? '暂时无法连接工作台登录服务，请检查网络后重试。' : detail,
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
