import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve, relative, join } from 'node:path'

export function requireRevision(value) {
  if (!/^[0-9a-f]{40}$/.test(value || '')) throw new Error('SOURCE_REVISION must be a fixed, full Git commit SHA (40 lowercase hex characters)')
  return value
}

export function outputHashes(directory) {
  const files = {}
  function visit(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) visit(child)
      else {
        if (!entry.isFile()) throw new Error('Build output must contain regular files only')
        const name = relative(directory, child).split('\\').join('/')
        if (name !== 'build-info.json') files[name] = createHash('sha256').update(readFileSync(child)).digest('hex')
      }
    }
  }
  visit(resolve(directory))
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))
}

export function verifyProductionBuild(directory, revision) {
  requireRevision(revision)
  const metadata = JSON.parse(readFileSync(join(directory, 'build-info.json'), 'utf8'))
  if (metadata.schema !== 1 || metadata.useApi !== true || metadata.apiBase !== '/api/v1') throw new Error('Refusing non-production API build')
  if (!['domain', 'portal', 'pm'].includes(metadata.appMode)) throw new Error('Refusing preview-only application mode')
  if (metadata.sourceRevision !== revision) throw new Error('Build source revision does not match release revision')
  const actual = outputHashes(directory)
  if (!actual['index.html'] || !Object.keys(actual).some(path => path.startsWith('assets/') && path.endsWith('.js'))) throw new Error('Missing built HTML or JavaScript entry')
  if (!metadata.files || typeof metadata.files !== 'object' || JSON.stringify(actual) !== JSON.stringify(Object.fromEntries(Object.entries(metadata.files).sort(([a], [b]) => a.localeCompare(b))))) throw new Error('Build output is missing, changed, or contains unrecorded files')
  return metadata
}
