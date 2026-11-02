import { verifyProductionBuild } from './production-build.mjs'

try {
  const build = verifyProductionBuild(process.argv[2] || 'dist', process.env.SOURCE_REVISION)
  console.log(`Production artifact verified: ${build.sourceRevision}`)
} catch (error) {
  console.error(`Production artifact rejected: ${error.message}`)
  process.exitCode = 1
}
