import { spawnSync } from 'node:child_process'
import { requireRevision, verifyProductionBuild } from './production-build.mjs'

try {
  const revision = requireRevision(process.env.SOURCE_REVISION)
  const result = spawnSync('npm', ['run', 'build'], {
    stdio: 'inherit',
    env: { ...process.env, SOURCE_REVISION: revision, VITE_USE_API: 'true', VITE_API_URL: '/api/v1' },
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status || 1)
  const build = verifyProductionBuild('dist', revision)
  console.log(`Verified production build: ${build.sourceRevision}, API=${build.apiBase}, mode=${build.appMode}`)
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
