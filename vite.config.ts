import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { defineConfig, loadEnv, type Plugin, type ResolvedConfig } from 'vite'
import react from '@vitejs/plugin-react'

function buildInfo(): Plugin {
  let config: ResolvedConfig
  return {
    name: 'production-build-info',
    apply: 'build',
    configResolved(resolved) { config = resolved },
    closeBundle() {
      const directory = resolve(config.root, config.build.outDir)
      const files: Record<string, string> = {}
      function visit(path: string) {
        for (const entry of readdirSync(path, { withFileTypes: true })) {
          const child = join(path, entry.name)
          if (entry.isDirectory()) visit(child)
          else if (entry.isFile()) {
            const name = relative(directory, child).split('\\').join('/')
            if (name !== 'build-info.json') files[name] = createHash('sha256').update(readFileSync(child)).digest('hex')
          } else throw new Error('Build output must contain regular files only')
        }
      }
      visit(directory)
      writeFileSync(join(directory, 'build-info.json'), JSON.stringify({
        schema: 1,
        useApi: config.env.VITE_USE_API === 'true',
        apiBase: config.env.VITE_API_URL || '/api/v1',
        appMode: config.env.VITE_APP_MODE || 'domain',
        sourceRevision: process.env.SOURCE_REVISION || null,
        files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))),
      }, null, 2) + '\n')
    },
  }
}

// CTO Lite 版固定 5175，避免与 Demo-Lite（5174）/ 基线版（5173）端口冲突。
// 开发期把 /api 代理到 FastAPI，使前端与 API 同源：IAM 的 HttpOnly 会话 cookie 与登录回调
// 都依赖同源（后端 PMS_PUBLIC_URL 设为 http://localhost:5175）。
// 后端不在 8000 时，在 .env.local 设置 API_PROXY_TARGET（不带 VITE_ 前缀，不会打进前端产物）。
// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react(), buildInfo()],
    // 构建标识：应用内嵌的版本说明等文件名不带哈希的页面带上它，发版后不会沿用浏览器里的旧缓存
    define: { __APP_BUILD__: JSON.stringify(new Date().toISOString().replace(/\D/g, '').slice(0, 14)) },
    server: {
      port: 5175,
      strictPort: true,  // 端口被占用时报错，不要自动跳到下一个
      proxy: {
        '/api': {
          target: env.API_PROXY_TARGET || 'http://127.0.0.1:8000',
          changeOrigin: true,
        },
      },
    },
  }
})
