// 一个构建可服务门户和 PM；生产环境通过域名决定界面，不共享子域 Cookie。
export const portalPublicUrl = 'https://www.openlims.ai'
export const projectPublicUrl = 'https://pm.openlims.ai'
export const knowledgePublicUrl = 'https://kb.openlims.ai'
// 知识库入口默认打开论文知识库（MB-Web）；管理工作台仍在 knowledgePublicUrl 根地址。
// 未登录时知识库登录会保留 #mb-web，登录后回到论文知识库。
export const knowledgeLaunchUrl = `${knowledgePublicUrl}/#mb-web`
export const iamLoginUrl = 'https://iam.openlims.ai/login'

type SiteMode = 'portal' | 'pm' | 'combined'
const configuredMode = import.meta.env.VITE_APP_MODE
export const siteMode: SiteMode = ['portal', 'pm', 'combined'].includes(configuredMode)
  ? configuredMode as SiteMode
  : window.location.hostname === 'pm.openlims.ai' ? 'pm'
    : import.meta.env.DEV && ['localhost', '127.0.0.1'].includes(window.location.hostname) ? 'combined'
      : 'portal'

export const workspaceUrl = siteMode === 'combined' ? '/' : portalPublicUrl

/** 登录返回地址只接受本站路径。 */
export function safeReturnPath(from: unknown, fallback = '/'): string {
  if (typeof from !== 'string' || !from.startsWith('/') || from.startsWith('//') || from.includes('\\') || Array.from(from).some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)) return fallback
  try {
    const base = 'https://workspace.invalid'
    const url = new URL(from, base)
    if (url.origin !== base || ['/login', '/register'].includes(url.pathname)) return fallback
    return url.pathname + url.search + url.hash
  } catch {
    return fallback
  }
}

export function projectApplicationUrl(returnTo = '/dashboard'): string {
  const base = siteMode === 'combined' ? window.location.origin : projectPublicUrl
  const url = new URL('/api/v1/auth/login', base)
  url.searchParams.set('return_to', safeReturnPath(returnTo, '/dashboard'))
  return url.toString()
}
