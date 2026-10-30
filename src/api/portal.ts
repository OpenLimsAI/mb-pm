import axios from 'axios'
import { API_BASE, camelize } from './client'

export interface PortalUser {
  id: string
  username: string
  displayName: string
}

export interface PortalApplication {
  id: 'pm' | 'kb' | 'information' | 'solutions' | 'feedback' | 'notes' | 'accounts' | 'assistant' | 'mdm'
  enabled: boolean
  reason?: string
}

export interface PortalIdentity {
  user: PortalUser
  /** 由后端从已验证 issuer / organization / subject 推导的非秘密界面隔离键。 */
  identityNamespace?: string
  applications: PortalApplication[]
  /** 管理员设置了临时密码：须先在门户里改密（改密前账号管理等接口返回 403）。 */
  mustChangePassword: boolean
  /** 兼容字段：原门户 AI 配置准入；当前配置入口在项目管理，由 ai.config 判定。 */
  canConfigureAi: boolean
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

/** Protected configured URL; no caller-controlled return URL or credentials. */
export async function getMDMLaunchUrl(): Promise<string> {
  const { data } = await portalApi.get<{ url: string }>('/applications/mdm/launch')
  return data.url
}

export const portalLogoutUrl = `${API_BASE}/portal/logout`

/** 本人在门户改密码：后端校验当前密码，清除临时密码标记，其他设备上的登录退出。 */
export async function changePortalPassword(currentPassword: string, newPassword: string): Promise<void> {
  await portalApi.post('/password', { current_password: currentPassword, new_password: newPassword })
}

/** 本人在门户改用户名（IAM 登录名）：后端校验当前密码，项目管理成员的用户名一并更新。 */
export async function changePortalUsername(newUsername: string, currentPassword: string): Promise<PortalUser> {
  const { data } = await portalApi.post('/username', { new_username: newUsername, current_password: currentPassword })
  return camelize<PortalUser>(data)
}
