// 认证 API —— 登录 / 登出都是整页跳转，由后端与 IAM 交互；前端只查询当前用户。
// 账号由系统管理员在门户「账号管理」开通；改用户名 / 密码在工作台「设置」。
import { api, API_BASE } from './client'
import type { UserDTO } from './types'

/** mustChangePassword：管理员设置了临时密码，须先改密（改密前其他接口返回 403）。 */
export async function fetchMe(): Promise<UserDTO & { mustChangePassword?: boolean }> {
  const { data } = await api.get<UserDTO & { mustChangePassword?: boolean }>('/auth/me')
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

/** 改密码（项目管理「请先修改临时密码」页）：后端校验当前密码；成功后本系统在其他设备上的登录会退出。
 *  日常改用户名 / 密码在工作台「我的设置」（门户会话，见 api/portal.ts）。 */
export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await api.post('/account/password', { currentPassword, newPassword })
}
