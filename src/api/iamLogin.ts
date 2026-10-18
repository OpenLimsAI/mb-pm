// 嵌入式登录（见 backend/app/services/iam_login.py）：
// 1. 向本系统后端开始登录（生成 state / PKCE，写 state cookie），拿到 IAM 登录接口地址；
// 2. 浏览器把用户名和密码直接提交到 IAM（携带凭据，IAM 同时写入自己的登录会话，供进入其他应用时单点登录），
//    换回一次性授权码；密码不经过本系统后端；
// 3. 带授权码与 state 打开原有回调，由后端换取令牌、建立会话。
import axios from 'axios'
import { API_BASE, camelize } from './client'

export interface EmbeddedLogin {
  loginApi: string
  application: string
  organization: string
  callbackUrl: string
  state: string
}

/** IAM 拒绝登录（用户名或密码错误、账号停用、错误次数过多等），message 为 IAM 返回的说明。 */
export class LoginRejected extends Error {}
/** 浏览器连不上 IAM（网络或跨域被拒）：登录页回退为跳转 IAM 登录页。 */
export class IamUnreachable extends Error {}
/** 还需在 IAM 页面完成的步骤（如两步验证、授权确认）：登录页改为跳转 IAM 登录页。 */
export class NeedsIamPage extends Error {}

// IAM /api/login 成功但没有给出授权码时 data 里的控制值（Casdoor 3.100.0：两步验证、付费计划）
const IAM_STEPS = new Set(['NextMfa', 'RequiredMfa', 'SelectPlan', 'BuyPlanResult'])

const startClient = axios.create({ baseURL: API_BASE, withCredentials: true, timeout: 15000 })

/** kind：门户会话（portal）或项目管理会话（pm）。 */
export async function startLogin(kind: 'portal' | 'pm', returnTo: string): Promise<EmbeddedLogin> {
  const { data } = await startClient.post(kind === 'portal' ? '/portal/login/start' : '/auth/login/start', { return_to: returnTo })
  return camelize<EmbeddedLogin>(data)
}

/** 浏览器里是否已有 IAM 登录会话（有则可直接走单点登录，不必再输入密码）。查询失败按没有处理。 */
export async function hasIamSession(kind: 'portal' | 'pm'): Promise<boolean> {
  try {
    const { data } = await startClient.get(kind === 'portal' ? '/portal/config' : '/auth/config')
    const url = (data as { iam_session_url?: unknown }).iam_session_url
    if (typeof url !== 'string' || !url) return false
    const response = await fetch(url, { credentials: 'include', headers: { 'Accept-Language': 'zh-CN' } })
    const body = await response.json() as { status?: string; data?: { name?: unknown } | null }
    return body.status === 'ok' && typeof body.data?.name === 'string'
  } catch {
    return false
  }
}

/** 提交用户名 / 密码到 IAM，成功时返回要打开的回调地址。 */
export function signInWithPassword(start: EmbeddedLogin, username: string, password: string, autoSignin: boolean): Promise<string> {
  return requestCode(start, { username, password, autoSignin, signinMethod: 'Password' })
}

/** 已有 IAM 登录会话时直接换取授权码（IAM 的「快速登录」，不需要密码，也不经过 IAM 页面）。 */
export function signInWithSession(start: EmbeddedLogin): Promise<string> {
  return requestCode(start, { autoSignin: true })
}

async function requestCode(start: EmbeddedLogin, fields: Record<string, unknown>): Promise<string> {
  let body: { status?: string; msg?: string; data?: unknown }
  try {
    // text/plain 属于简单请求（无需预检）；IAM 按 JSON 解析请求体，按 Accept-Language 返回中文提示
    const response = await fetch(start.loginApi, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8', 'Accept-Language': 'zh-CN' },
      body: JSON.stringify({ application: start.application, organization: start.organization, type: 'code', ...fields }),
    })
    body = await response.json()
  } catch {
    throw new IamUnreachable('无法连接迈博统一身份服务')
  }
  if (body.status === 'ok') {
    if (typeof body.data !== 'string' || !body.data || IAM_STEPS.has(body.data)) throw new NeedsIamPage('需要在统一身份平台完成登录')
    const url = new URL(start.callbackUrl)
    url.searchParams.set('code', body.data)
    url.searchParams.set('state', start.state)
    return url.toString()
  }
  throw new LoginRejected(body.msg?.trim() || '登录未成功，请检查用户名和密码后重试。')
}
