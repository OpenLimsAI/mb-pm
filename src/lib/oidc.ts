import { UserManager, WebStorageStateStore, type User as OidcUser } from 'oidc-client-ts'
import { setToken } from '../api/client'

const authority = import.meta.env.VITE_OIDC_AUTHORITY as string
const client_id = import.meta.env.VITE_OIDC_CLIENT_ID as string
const redirect_uri = import.meta.env.VITE_OIDC_REDIRECT_URI as string
// 登出后回跳地址（缺省回到应用根，本地无需配置）。Casdoor 对 http://localhost 源免注册放行。
const post_logout_redirect_uri =
  (import.meta.env.VITE_OIDC_POST_LOGOUT_REDIRECT_URI as string) || window.location.origin + '/'

export const userManager = new UserManager({
  authority,
  client_id,
  redirect_uri,
  response_type: 'code',
  scope: 'openid profile email',
  // Casdoor 端点（discovery 也可，但显式声明更稳）
  metadata: {
    issuer: authority,
    authorization_endpoint: `${authority}/login/oauth/authorize`,
    token_endpoint: `${authority}/api/login/oauth/access_token`,
    jwks_uri: `${authority}/.well-known/jwks`,
    userinfo_endpoint: `${authority}/api/userinfo`,
  },
  userStore: new WebStorageStateStore({ store: window.localStorage }),
})

export function login(): Promise<void> {
  return userManager.signinRedirect()
}

export async function getAccessToken(): Promise<string | null> {
  const u = await userManager.getUser()
  return u && !u.expired ? u.access_token : null
}

export async function completeLogin(): Promise<OidcUser> {
  return userManager.signinRedirectCallback()
}

// RP-initiated logout（OIDC 单点登出）：
//  1) 清本地两处会话 —— oidc-client-ts 存的 user（getAccessToken 读它）+ axios 用的 JWT；
//  2) 跳 Casdoor end-session 端点 /api/logout，清掉其 SSO 会话 cookie（否则换账号会被静默登回）。
// 携 id_token_hint（若有）+ post_logout_redirect_uri；手动构造跳转，不走 signoutRedirect 状态机，回跳地址干净。
export async function logout(): Promise<void> {
  const u = await userManager.getUser()
  const idToken = u?.id_token
  await userManager.removeUser()
  setToken(null)
  const params = new URLSearchParams({ post_logout_redirect_uri })
  if (idToken) params.set('id_token_hint', idToken)
  window.location.href = `${authority}/api/logout?${params.toString()}`
}
