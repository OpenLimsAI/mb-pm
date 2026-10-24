import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceArrangement, WorkspaceModule } from './layout'
import { clampOutlineWidth, panelStorageKey, readPanelPreferences, workspaceGrid } from './workspacePanels'

const defaults = { visible: { editor: true, knowledge: true, ai: true }, outlineVisible: true, outlineWidth: 190 }
const order: [WorkspaceModule, WorkspaceModule, WorkspaceModule] = ['editor', 'knowledge', 'ai']
const arrangements: WorkspaceArrangement[] = ['columns', 'left-main', 'right-main', 'top-pair']
beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe('workspace visibility and outline preferences', () => {
  it('uses independent fresh defaults when no preference exists', () => {
    const first = readPanelPreferences()
    expect(first).toEqual(defaults)
    first.visible.editor = false
    expect(readPanelPreferences()).toEqual(defaults)
  })

  it.each(['broken JSON', 'null', 'true', '5', '"editor"', '[]'])('falls back safely for invalid stored value %s', raw => {
    localStorage.setItem(panelStorageKey, raw)
    expect(readPanelPreferences()).toEqual(defaults)
  })

  it('does not coerce string or numeric flags into visibility preferences', () => {
    localStorage.setItem(panelStorageKey, JSON.stringify({ visible: { editor: 'false', knowledge: 0, ai: null }, outlineVisible: 'false', outlineWidth: '240' }))
    expect(readPanelPreferences()).toEqual(defaults)
  })

  it('preserves deliberate false preferences, including three hidden modules', () => {
    const value = { visible: { editor: false, knowledge: false, ai: false }, outlineVisible: false, outlineWidth: 236 }
    localStorage.setItem(panelStorageKey, JSON.stringify(value))
    expect(readPanelPreferences()).toEqual(value)
  })

  it('prefers the current settings over a legacy combined-panel setting', () => {
    localStorage.setItem('ks-layout', JSON.stringify({ left: false, right: false }))
    localStorage.setItem(panelStorageKey, JSON.stringify({ visible: { editor: true, knowledge: false, ai: true }, outlineVisible: false, outlineWidth: 224 }))
    expect(readPanelPreferences()).toEqual({ visible: { editor: true, knowledge: false, ai: true }, outlineVisible: false, outlineWidth: 224 })
  })

  it.each([
    [{ left: false }, { editor: false, knowledge: true, ai: true }],
    [{ right: false, knowledge: true, ai: true }, { editor: true, knowledge: false, ai: false }],
    [{ right: true, knowledge: false, ai: true }, { editor: true, knowledge: false, ai: true }],
    [{ left: false, right: true, knowledge: true, ai: false }, { editor: false, knowledge: true, ai: false }],
    [{ left: 'false', right: 0, knowledge: null, ai: 'true' }, { editor: true, knowledge: true, ai: true }],
  ])('migrates legacy panel preferences %j without trusting non-boolean flags', (legacy, visible) => {
    localStorage.setItem('ks-layout', JSON.stringify({ ratio: 60, ...legacy }))
    expect(readPanelPreferences()).toEqual({ ...defaults, visible })
  })

  it.each([[-1, 160], [159, 160], [160, 160], [190.4, 190], [235.8, 236], [360, 360], [999, 360]])('bounds outline width %s to %s', (width, expected) => {
    localStorage.setItem(panelStorageKey, JSON.stringify({ outlineWidth: width }))
    expect(readPanelPreferences().outlineWidth).toBe(expected)
    expect(clampOutlineWidth(width)).toBe(expected)
  })

  it('uses the default width for non-finite data and works when storage access fails', () => {
    localStorage.setItem(panelStorageKey, '{"outlineWidth":1e400}')
    expect(readPanelPreferences().outlineWidth).toBe(190)
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage unavailable') })
    expect(readPanelPreferences()).toEqual(defaults)
  })
})

describe('workspace geometry when modules are hidden', () => {
  it.each([
    ['columns', '"s1 s2 s3"'],
    ['left-main', '"s1 s2" "s1 s3"'],
    ['right-main', '"s1 s3" "s2 s3"'],
    ['top-pair', '"s1 s2" "s3 s3"'],
  ] as const)('keeps the numbered arrangement %s when all modules are visible', (arrangement, areas) => {
    expect(workspaceGrid({ arrangement, order }, defaults.visible).gridTemplateAreas).toBe(areas)
  })

  it.each([
    ['columns', { editor: false, knowledge: true, ai: true }, '"s2 s3"'],
    ['left-main', { editor: false, knowledge: true, ai: true }, '"s2" "s3"'],
    ['left-main', { editor: true, knowledge: false, ai: true }, '"s1 s3"'],
    ['right-main', { editor: true, knowledge: true, ai: false }, '"s1" "s2"'],
    ['right-main', { editor: false, knowledge: true, ai: true }, '"s2 s3"'],
    ['top-pair', { editor: true, knowledge: true, ai: false }, '"s1 s2"'],
    ['top-pair', { editor: true, knowledge: false, ai: true }, '"s1" "s3"'],
  ] as const)('removes hidden tracks from %s without retaining an empty half', (arrangement, visible, areas) => {
    expect(workspaceGrid({ arrangement, order }, visible).gridTemplateAreas).toBe(areas)
  })

  it.each(arrangements)('keeps every visibility combination rectangular and free of hidden slots in %s', arrangement => {
    const permutations: [WorkspaceModule, WorkspaceModule, WorkspaceModule][] = [order, ['ai', 'editor', 'knowledge']]
    for (const permutation of permutations) for (let mask = 0; mask < 8; mask += 1) {
      const visible = { editor: !!(mask & 1), knowledge: !!(mask & 2), ai: !!(mask & 4) }
      const grid = workspaceGrid({ arrangement, order: permutation }, visible)
      const rows = [...String(grid.gridTemplateAreas).matchAll(/"([^"]+)"/g)].map(match => match[1].split(' '))
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.every(row => row.length === rows[0].length)).toBe(true)
      const rendered = [...new Set(rows.flat())].sort()
      const expected = permutation.flatMap((module, index) => visible[module] ? [`s${index + 1}`] : []).sort()
      expect(rendered).toEqual(expected.length ? expected : ['empty'])
      for (const slot of expected) {
        const cells = rows.flatMap((row, y) => row.flatMap((value, x) => value === slot ? [{ x, y }] : []))
        const xs = cells.map(cell => cell.x), ys = cells.map(cell => cell.y)
        expect(cells.length).toBe((Math.max(...xs) - Math.min(...xs) + 1) * (Math.max(...ys) - Math.min(...ys) + 1))
      }
    }
  })
})
