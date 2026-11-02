import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { outputHashes, requireRevision, verifyProductionBuild } from './production-build.mjs'

const revision = '1234567890abcdef1234567890abcdef12345678'
function fixture(run) {
  const directory = mkdtempSync(join(tmpdir(), 'mb-production-artifact-'))
  mkdirSync(join(directory, 'assets'))
  writeFileSync(join(directory, 'index.html'), '<script type="module" src="/assets/app.js"></script>')
  writeFileSync(join(directory, 'assets/app.js'), 'document.body.dataset.ready = "true"')
  const metadata = { schema: 1, useApi: true, apiBase: '/api/v1', appMode: 'domain', sourceRevision: revision, files: outputHashes(directory) }
  const save = () => writeFileSync(join(directory, 'build-info.json'), JSON.stringify(metadata))
  save()
  try { run({ directory, metadata, save }) } finally { rmSync(directory, { recursive: true, force: true }) }
}
test('accepts only a complete artifact bound to its fixed release source', () => fixture(({ directory }) => {
  assert.equal(verifyProductionBuild(directory, revision).sourceRevision, revision)
  assert.throws(() => verifyProductionBuild(directory, 'f'.repeat(40)), /revision/)
  assert.throws(() => requireRevision('main'), /fixed/)
}))
test('rejects preview, custom API and combined-mode artifacts despite valid file hashes', () => {
  for (const change of [{ useApi: false }, { apiBase: 'https://relay.example/api' }, { appMode: 'combined' }]) {
    fixture(({ directory, metadata, save }) => {
      Object.assign(metadata, change); save()
      assert.throws(() => verifyProductionBuild(directory, revision), /Refusing/)
    })
  }
})
test('rejects legacy builds without a manifest', () => fixture(({ directory }) => {
  rmSync(join(directory, 'build-info.json'))
  assert.throws(() => verifyProductionBuild(directory, revision), /ENOENT/)
}))
test('detects replacement of actual HTML or chunks and rejects extra stale assets', () => {
  for (const name of ['index.html', 'assets/app.js', 'assets/stale.js']) {
    fixture(({ directory }) => {
      writeFileSync(join(directory, name), 'changed output')
      assert.throws(() => verifyProductionBuild(directory, revision), /missing, changed/)
    })
  }
})
test('does not treat manifest path strings as paths to read', () => fixture(({ directory, metadata, save }) => {
  metadata.files['../secret'] = 'f'.repeat(64); save()
  assert.throws(() => verifyProductionBuild(directory, revision), /missing, changed/)
  assert.match(readFileSync(join(directory, 'index.html'), 'utf8'), /app.js/)
}))
