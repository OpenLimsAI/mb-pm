import { UserManager, WebStorageStateStore, type User as OidcUser } from 'oidc-client-ts'

const authority = import.meta.env.VITE_OIDC_AUTHORITY as string
const client_id = import.meta.env.VITE_OIDC_CLIENT_ID as string
const redirect_uri = import.meta.env.VITE_OIDC_REDIRECT_URI as string

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
