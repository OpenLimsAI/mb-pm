// 无浏览器 / 网络依赖，核对共享构建的域名选择与固定应用目标。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../src/lib/site.ts', import.meta.url), 'utf8')
const code = ts.transpileModule(source.replaceAll('import.meta.env', 'testEnvironment'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText

function site(hostname, DEV = false, VITE_APP_MODE = undefined, VITE_KNOWLEDGE_PORT = undefined) {
  const context = {
    exports: {}, URL, URLSearchParams, testEnvironment: { DEV, VITE_APP_MODE, VITE_KNOWLEDGE_PORT },
    window: { location: { hostname, origin: DEV ? `http://${hostname}:5176` : `https://${hostname}` } },
  }
  vm.runInNewContext(code, context)
  return context.exports
}

const portal = site('www.openlims.ai')
const pm = site('pm.openlims.ai')
const local = site('127.0.0.1', true)
assert.equal(portal.siteMode, 'portal')
assert.equal(pm.siteMode, 'pm')
assert.equal(local.siteMode, 'combined')
assert.equal(site('unknown.example').siteMode, 'portal')
assert.equal(site('127.0.0.1', true, 'pm').siteMode, 'pm')
assert.equal(site('localhost', true, 'portal').siteMode, 'portal')
assert.equal(pm.workspaceUrl, 'https://www.openlims.ai')
// 组织（账号管理）与设置在门户：PM 的旧入口跳到 www，本地组合模式留在本地
for (const mode of [portal, pm]) {
  assert.equal(mode.accountsUrl, 'https://www.openlims.ai/accounts')
  assert.equal(mode.settingsUrl, 'https://www.openlims.ai/settings')
}
assert.equal(local.accountsUrl, '/accounts')
assert.equal(local.settingsUrl, '/settings')
// 版本更新归属门户；项目管理旧入口离开 PM，本地组合模式仍留在本地。
assert.equal(portal.releaseNotesUrl, '/release-notes')
assert.equal(pm.releaseNotesUrl, 'https://www.openlims.ai/release-notes')
assert.equal(local.releaseNotesUrl, '/release-notes')
// 个人设置留在门户，AI 配置回 PM；旧书签在三种域名模式下均不能形成循环。
assert.equal(portal.aiSettingsUrl, 'https://pm.openlims.ai/ai-settings')
assert.equal(pm.aiSettingsUrl, '/ai-settings')
assert.equal(local.aiSettingsUrl, '/ai-settings')
assert.equal(portal.settingsRedirect(''), null)
assert.equal(local.settingsRedirect(''), null)
assert.equal(pm.settingsRedirect(''), 'https://www.openlims.ai/settings')
assert.equal(portal.settingsRedirect('?tab=ai'), 'https://pm.openlims.ai/ai-settings')
assert.equal(pm.settingsRedirect('?tab=ai'), '/ai-settings')
assert.equal(local.settingsRedirect('?tab=ai'), '/ai-settings')
assert.equal(local.settingsRedirect('?tab=ai&preview=1'), '/ai-settings?preview=1')
assert.equal(portal.settingsRedirect('?tab=ai&preview=1'), 'https://pm.openlims.ai/ai-settings')
assert.equal(pm.settingsRedirect('?tab=account'), 'https://www.openlims.ai/settings?tab=account')

// www 打开 PM 必须离开 www；本地组合模式仍在本地后端联调。
assert.equal(portal.projectApplicationUrl(), 'https://pm.openlims.ai/api/v1/auth/login?return_to=%2Fdashboard')
assert.equal(local.projectApplicationUrl(), 'http://127.0.0.1:5176/api/v1/auth/login?return_to=%2Fdashboard')
assert.equal(portal.knowledgePublicUrl, 'https://kb.openlims.ai')
// 论文知识库独立部署在根地址，入口不再带 #mb-web。
assert.equal(portal.knowledgeLaunchUrl, 'https://kb.openlims.ai/')
// 只有本机开发跳到本地知识库，生产构建不会带入本地端口。
assert.equal(local.knowledgeLaunchUrl, 'http://127.0.0.1:4322/')
assert.equal(site('localhost', true).knowledgeLaunchUrl, 'http://localhost:4322/')
assert.equal(site('[::1]', true).knowledgeLaunchUrl, 'http://[::1]:4322/')
assert.equal(site('localhost', true, 'portal', '4321').knowledgeLaunchUrl, 'http://localhost:4321/')
for (const port of ['invalid', '0', '-1', '65536', '4321.5']) {
  assert.equal(site('localhost', true, undefined, port).knowledgeLaunchUrl, 'http://localhost:4322/')
}
for (const host of ['localhost', '127.0.0.1', 'www.openlims.ai', 'pm.openlims.ai']) {
  assert.equal(site(host, false, undefined, '4321').knowledgeLaunchUrl, 'https://kb.openlims.ai/')
}
assert.equal(site('www.openlims.ai', true, undefined, '4321').knowledgeLaunchUrl, 'https://kb.openlims.ai/')
const deep = '/projects/project-123?tab=tasks#task-1'
assert.equal(new URL(portal.projectApplicationUrl(deep)).searchParams.get('return_to'), deep)
assert.equal(portal.safeReturnPath('/launch/kb'), '/launch/kb')

for (const invalid of [undefined, null, {}, 'https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)', '/login', '/register', '/path\n', '/path\x7f']) {
  assert.equal(portal.safeReturnPath(invalid), '/')
  const target = new URL(portal.projectApplicationUrl(invalid))
  assert.equal(target.origin, 'https://pm.openlims.ai')
  assert.equal(target.pathname, '/api/v1/auth/login')
  assert.equal(target.searchParams.get('return_to'), '/dashboard')
  assert.equal(target.searchParams.has('access_token'), false)
}
console.log('Portal routing checks passed: domain modes, fixed app targets, deep links, unsafe return paths.')

// 门户匿名、PM 会话仍有效时，版本更新不可选用 PM 会话，否则会与 PortalGate 循环跳转。
for (const route of ['/release-notes', '/release-notes/?x=1#latest', '/accounts', '/settings', '/help', '/launch/kb', '/information', '/information/sources', '/information/inbox?unread=1', '/launch/information']) {
  assert.equal(local.loginUsesProjectSession(route), false)
  assert.equal(portal.loginUsesProjectSession(route), false)
  assert.equal(pm.loginUsesProjectSession(route), true)
}
assert.equal(local.loginUsesProjectSession('/projects/p1'), true)
assert.equal(local.loginUsesProjectSession('/ai-settings'), true)
