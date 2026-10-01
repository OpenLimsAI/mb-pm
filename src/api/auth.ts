// 认证 API —— 登录 / 登出都是整页跳转，由后端与 IAM 交互；前端只查询当前用户。
// 改用户名 / 密码经后端调用 IAM 完成，浏览器不直接访问 IAM 管理接口；账号由 IAM 平台开通。
import { api, API_BASE } from './client'
import type { UserDTO } from './types'

export async function fetchMe(): Promise<UserDTO> {
  const { data } = await api.get<UserDTO>('/auth/me')
  return data
}

export interface AuthConfig {
  /** 规范 origin 下的登录入口（从其他主机名 / 端口进入时也回到同一 origin，保证 cookie 与回调一致）。 */
  loginUrl: string
}

export async function getAuthConfig(): Promise<AuthConfig> {
  const { data } = await api.get<AuthConfig>('/auth/config')
  return data
}

export async function getLoginUrl(): Promise<string> {
  return (await getAuthConfig()).loginUrl
}

/** 以顶层表单 POST 提交：后端销毁业务会话 → Casdoor 清 SSO → 回到 /login。 */
export const logoutUrl = `${API_BASE}/auth/logout`

/** 改密码：后端校验当前密码；成功后本系统在其他设备上的登录会退出。 */
export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await api.post('/account/password', { currentPassword, newPassword })
}

/** 改用户名（即 IAM 登录名）：后端校验当前密码后改 IAM 用户名，并同步业务账号。 */
export async function changeUsername(newUsername: string, currentPassword: string): Promise<UserDTO> {
  const { data } = await api.post<UserDTO>('/account/username', { newUsername, currentPassword })
  return data
}
