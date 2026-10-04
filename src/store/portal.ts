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
  status: 'loading',
  error: null,
  refresh: () => {
    if (!refreshing) {
      refreshing = fetchPortalIdentity()
        .then(({ user, applications }) => set({ user, applications, status: 'ready', error: null }))
        .catch((err) => {
          const { status, detail } = asAPIError(err)
          set({
            user: null,
            applications: [],
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
