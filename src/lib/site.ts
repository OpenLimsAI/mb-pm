// 一个构建可服务门户和 PM；生产环境通过域名决定界面，不共享子域 Cookie。
export const portalPublicUrl = 'https://www.openlims.ai'
export const projectPublicUrl = 'https://pm.openlims.ai'
export const knowledgePublicUrl = 'https://kb.openlims.ai'
// 论文知识库（dikw-mbweb）自 2026-10-06 起独立部署在 knowledgePublicUrl 根地址，入口不再需要 #mb-web；
// 旧链接 /#mb-web 仍会打开论文知识库。管理工作台不经此域名访问。
export const knowledgeLaunchUrl = `${knowledgePublicUrl}/`
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
