import axios from 'axios'
import { API_BASE, camelize } from './client'

export interface PortalUser {
  id: string
  username: string
  displayName: string
}

export interface PortalApplication {
  id: 'pm' | 'kb'
  enabled: boolean
  reason?: string
}

export interface PortalIdentity {
  user: PortalUser
  applications: PortalApplication[]
}

// 门户会话与 PM 会话独立。门户的 401 不应触发 PM 全局退出事件。
const portalApi = axios.create({
  baseURL: `${API_BASE}/portal`,
  withCredentials: true,
  timeout: 15000,
})

export async function fetchPortalIdentity(): Promise<PortalIdentity> {
  const { data } = await portalApi.get('/me')
  return camelize<PortalIdentity>(data)
}

export async function getPortalLoginUrl(): Promise<string> {
  const { data } = await portalApi.get('/config')
  return camelize<{ loginUrl: string }>(data).loginUrl
}

export const portalLogoutUrl = `${API_BASE}/portal/logout`
