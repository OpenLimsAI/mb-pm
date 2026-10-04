// 无浏览器 / 网络依赖，核对共享构建的域名选择与固定应用目标。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../src/lib/site.ts', import.meta.url), 'utf8')
const code = ts.transpileModule(source.replaceAll('import.meta.env', 'testEnvironment'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText

function site(hostname, DEV = false, VITE_APP_MODE = undefined) {
  const context = {
    exports: {}, URL, testEnvironment: { DEV, VITE_APP_MODE },
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

// www 打开 PM 必须离开 www；本地组合模式仍在本地后端联调。
assert.equal(portal.projectApplicationUrl(), 'https://pm.openlims.ai/api/v1/auth/login?return_to=%2Fdashboard')
assert.equal(local.projectApplicationUrl(), 'http://127.0.0.1:5176/api/v1/auth/login?return_to=%2Fdashboard')
assert.equal(portal.knowledgePublicUrl, 'https://kb.openlims.ai')
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
