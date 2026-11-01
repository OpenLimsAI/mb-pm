import { beforeEach, describe, expect, it } from 'vitest'
import { normalizeDataSources, readDataSources, writeDataSources } from './dataSources'

beforeEach(() => localStorage.clear())
describe('explicit application scope storage', () => {
  it('migrates knowledge but requires a fresh project opt-in from legacy storage', () => {
    localStorage.setItem('scope', JSON.stringify(['projects', 'knowledge', 'knowledge']))
    expect(readDataSources(localStorage, 'scope')).toEqual(['knowledge'])
    writeDataSources(localStorage, 'scope', ['projects', 'knowledge'])
    expect(readDataSources(localStorage, 'scope')).toEqual(['projects', 'knowledge'])
    expect(JSON.parse(localStorage.getItem('scope')!)).toEqual({ version: 2, sources: ['projects', 'knowledge'] })
  })
  it('defaults to no application access for absent, malformed, or unsupported storage', () => {
    expect(readDataSources(localStorage, 'scope')).toEqual([])
    for (const value of ['{broken', 'null', '"projects"', '{"version":3,"sources":["projects"]}']) {
      localStorage.setItem('scope', value)
      expect(readDataSources(localStorage, 'scope')).toEqual([])
    }
    expect(normalizeDataSources(['knowledge', 'unknown', 'projects', 'projects'])).toEqual(['projects', 'knowledge'])
  })
})
