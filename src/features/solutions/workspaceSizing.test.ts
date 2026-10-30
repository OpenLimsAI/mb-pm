import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceArrangement, WorkspaceLayout, WorkspaceModule } from './layout'
import { workspaceGrid } from './workspacePanels'
import {
  getSizedGrid, getStackHeight, getTrackSizes, readWorkspaceSizes, resetTrackSizes,
  resizeStackPair, resizeTrackPair, setTrackSizes, sizeKey, WORKSPACE_SIZES_KEY,
} from './workspaceSizing'
import type { WorkspaceSizes } from './workspaceSizing'

const empty = (): WorkspaceSizes => ({ desktop: {}, mobile: {} })
const all = { editor: true, knowledge: true, ai: true }
const layout: WorkspaceLayout = { arrangement: 'left-main', order: ['editor', 'knowledge', 'ai'] }
const arrangements: WorkspaceArrangement[] = ['columns', 'left-main', 'right-main', 'top-pair']
const orders: WorkspaceLayout['order'][] = [
  ['editor', 'knowledge', 'ai'], ['editor', 'ai', 'knowledge'], ['knowledge', 'editor', 'ai'],
  ['knowledge', 'ai', 'editor'], ['ai', 'editor', 'knowledge'], ['ai', 'knowledge', 'editor'],
]
beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe('workspace sizes and geometry', () => {
  it.each(arrangements)('preserves exact default CSS and derives tracks for every order and visibility in %s', arrangement => {
    for (const order of orders) for (let mask = 0; mask < 8; mask += 1) {
      const value = { arrangement, order }, visible = { editor: !!(mask & 1), knowledge: !!(mask & 2), ai: !!(mask & 4) }
      const grid = workspaceGrid(value, visible), tracks = getTrackSizes(value, visible, empty())
      expect(getSizedGrid(value, visible, empty())).toEqual(grid)
      const rows = [...String(grid.gridTemplateAreas).matchAll(/"([^"]+)"/g)].map(match => match[1].split(' '))
      expect(tracks.columns).toHaveLength(rows[0].length)
      expect(tracks.rows).toHaveLength(rows.length)
      for (const values of Object.values(tracks)) {
        expect(values.every(weight => Number.isFinite(weight) && weight > 0)).toBe(true)
        expect(values.reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1)
      }
      const resized = setTrackSizes(empty(), value, visible, 'columns', tracks.columns.map((_weight, index) => index + 1))
      expect(getSizedGrid(value, visible, resized).gridTemplateAreas).toBe(grid.gridTemplateAreas)
      expect(getSizedGrid(value, visible, resized).gridTemplateRows).toBe(grid.gridTemplateRows)
    }
  })

  it.each([
    ['columns', [1 / 3, 1 / 3, 1 / 3], [1]],
    ['left-main', [0.6, 0.4], [0.5, 0.5]],
    ['right-main', [0.4, 0.6], [0.5, 0.5]],
    ['top-pair', [0.5, 0.5], [0.5, 0.5]],
  ] as const)('keeps default proportions for %s', (arrangement, columns, rows) => {
    expect(getTrackSizes({ ...layout, arrangement }, all, empty())).toEqual({ columns, rows })
  })

  it('keys proportions by visible slots rather than module identity', () => {
    const visible = { editor: true, knowledge: false, ai: true }
    const reordered: WorkspaceLayout = { ...layout, order: ['knowledge', 'editor', 'ai'] }
    expect(sizeKey(layout, visible)).toBe('left-main:101')
    expect(sizeKey(reordered, { editor: false, knowledge: true, ai: true })).toBe('left-main:101')
    expect(sizeKey(reordered, visible)).toBe('left-main:011')
    const sizes = setTrackSizes(empty(), layout, visible, 'columns', [7, 3])
    expect(getTrackSizes(reordered, { editor: false, knowledge: true, ai: true }, sizes).columns).toEqual([0.7, 0.3])
    expect(getTrackSizes(reordered, visible, sizes)).toEqual({ columns: [1], rows: [0.5, 0.5] })
  })

  it('updates immutably, persists normalized proportions and resets axes independently', () => {
    const original = empty(), input = [8, 2]
    const first = setTrackSizes(original, layout, all, 'columns', input)
    const both = setTrackSizes(first, layout, all, 'rows', [1, 3])
    const otherLayout: WorkspaceLayout = { ...layout, arrangement: 'top-pair' }
    const other = setTrackSizes(both, otherLayout, all, 'columns', [2, 3])
    expect(original).toEqual(empty())
    input[0] = 1
    expect(first.desktop['left-main:111'].columns).toEqual([0.8, 0.2])
    localStorage.setItem(WORKSPACE_SIZES_KEY, JSON.stringify(other))
    const restored = readWorkspaceSizes()
    expect(restored).toEqual(other)
    const columnReset = resetTrackSizes(restored, layout, all, 'columns')
    expect(getTrackSizes(layout, all, columnReset)).toEqual({ columns: [0.6, 0.4], rows: [0.25, 0.75] })
    expect(columnReset.desktop['top-pair:111']).toEqual(other.desktop['top-pair:111'])
    expect(restored.desktop['left-main:111'].columns).toEqual([0.8, 0.2])
    const reset = resetTrackSizes(columnReset, layout, all, 'rows')
    expect(reset.desktop['left-main:111']).toBeUndefined()
    expect(getSizedGrid(layout, all, reset)).toEqual(workspaceGrid(layout, all))
    expect(resetTrackSizes(other, otherLayout, all).desktop['top-pair:111']).toBeUndefined()
    expect(resetTrackSizes(empty(), layout, all)).toEqual(empty())
  })

  it('ignores invalid or geometrically mismatched custom axes without altering default CSS', () => {
    for (const columns of [[], [1], [1, 2, 3], [0, 1], [-1, 2], [NaN, 1], [Infinity, 1]]) {
      const original = empty()
      expect(setTrackSizes(original, layout, all, 'columns', columns)).toBe(original)
      expect(getSizedGrid(layout, all, { desktop: { 'left-main:111': { columns } }, mobile: {} })).toEqual(workspaceGrid(layout, all))
    }
  })
})

describe('workspace size storage', () => {
  it.each(['{bad', '', 'null', 'true', '42', '"value"', '[]', '{}'])('falls back for invalid or absent preference %s', raw => {
    localStorage.setItem(WORKSPACE_SIZES_KEY, raw)
    expect(readWorkspaceSizes()).toEqual(empty())
  })

  it('retains valid fields while rejecting unknown keys, axes, tracks and mobile values', () => {
    localStorage.setItem(WORKSPACE_SIZES_KEY, JSON.stringify({
      desktop: {
        'left-main:111': { columns: [2, 3], rows: [0, 1], extra: [1] },
        'right-main:110': { columns: [1, 1], rows: [1, 3] },
        'columns:111': { columns: [1, 2, 3], rows: '1' },
        'top-pair:100': { columns: [Number.MAX_VALUE], rows: [1] },
        'left-main:editor,knowledge,ai': { columns: [1, 2] },
        'left-main:1111': { columns: [1, 2] },
        'diagonal:111': { columns: [1, 2] },
        'columns:110': { columns: [1, null] },
        'columns:101': [],
      },
      mobile: { editor: 20, knowledge: 9000, ai: '520', unknown: 600 },
    }))
    expect(readWorkspaceSizes()).toEqual({
      desktop: {
        'left-main:111': { columns: [0.4, 0.6] },
        'right-main:110': { rows: [0.25, 0.75] },
        'columns:111': { columns: [1 / 6, 1 / 3, 0.5] },
        'top-pair:100': { columns: [1], rows: [1] },
      }, mobile: { editor: 240, knowledge: 4000 },
    })
  })

  it('accepts every legal slot key and rejects non-finite and overflowing ratios safely', () => {
    const sizes = empty()
    for (const arrangement of arrangements) for (let mask = 0; mask < 8; mask += 1) {
      const current = { ...layout, arrangement }, visible = { editor: !!(mask & 1), knowledge: !!(mask & 2), ai: !!(mask & 4) }
      sizes.desktop[sizeKey(current, visible)] = getTrackSizes(current, visible, empty())
    }
    localStorage.setItem(WORKSPACE_SIZES_KEY, JSON.stringify(sizes))
    expect(Object.keys(readWorkspaceSizes().desktop)).toHaveLength(32)
    localStorage.setItem(WORKSPACE_SIZES_KEY, '{"desktop":{"left-main:111":{"columns":[1e400,1],"rows":[1,1]}},"mobile":{"editor":1e400,"ai":null}}')
    expect(readWorkspaceSizes()).toEqual({ desktop: { 'left-main:111': { rows: [0.5, 0.5] } }, mobile: {} })
    expect(getTrackSizes(layout, all, setTrackSizes(empty(), layout, all, 'columns', [Number.MAX_VALUE, Number.MAX_VALUE])).columns).toEqual([0.5, 0.5])
  })

  it('returns fresh preferences and performs no storage writes', () => {
    const first = readWorkspaceSizes(), second = readWorkspaceSizes()
    first.mobile.editor = 700
    expect(second).toEqual(empty())
    localStorage.setItem(WORKSPACE_SIZES_KEY, JSON.stringify({ desktop: { 'left-main:111': { columns: [3, 7] } }, mobile: { ai: 600 } }))
    const write = vi.spyOn(Storage.prototype, 'setItem'), stored = readWorkspaceSizes()
    stored.desktop['left-main:111'].columns![0] = 9
    expect(readWorkspaceSizes().desktop['left-main:111'].columns).toEqual([0.3, 0.7])
    expect(write).not.toHaveBeenCalled()
  })

  it('falls back when storage reads or access throw', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    expect(readWorkspaceSizes()).toEqual(empty())
    vi.restoreAllMocks()
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => { throw new Error('unavailable') })
    expect(readWorkspaceSizes()).toEqual(empty())
  })
})

describe('pair resizing bounds', () => {
  it('resizes only adjacent tracks while retaining their sum and the other track', () => {
    const values = [0.2, 0.3, 0.5], resized = resizeTrackPair(values, 1, 100, 1000, 100)
    expect(resized[0]).toBe(values[0])
    expect(resized[1]).toBeCloseTo(0.4)
    expect(resized[2]).toBeCloseTo(0.4)
    expect(resized[1] + resized[2]).toBe(values[1] + values[2])
    expect(values).toEqual([0.2, 0.3, 0.5])
    const low = resizeTrackPair(values, 0, -9999, 1000, 100), high = resizeTrackPair(values, 0, 9999, 1000, 100)
    expect(low[0]).toBeCloseTo(0.1)
    expect(high[1]).toBeCloseTo(0.1)
    expect(low[0] + low[1]).toBe(0.5)
    expect(high[0] + high[1]).toBe(0.5)
  })

  it('balances an undersized pair when requested minimums cannot fit and keeps zero-minimum tracks positive', () => {
    expect(resizeTrackPair([0.1, 0.3, 0.6], 0, 100, 500, 240)).toEqual([0.2, 0.2, 0.6])
    const resized = resizeTrackPair([0.5, 0.5], 0, 9999, 1000, 0)
    expect(resized.every(value => value > 0)).toBe(true)
    expect(resized[0] + resized[1]).toBe(1)
  })

  it.each([
    [-1, 10, 1000, 100], [1, 10, 1000, 100], [0.5, 10, 1000, 100],
    [0, NaN, 1000, 100], [0, Infinity, 1000, 100], [0, 10, 0, 100],
    [0, 10, -1, 100], [0, 10, Infinity, 100], [0, 10, 1000, NaN], [0, 10, 1000, -1],
  ])('ignores invalid pair arguments %s, %s, %s, %s', (index, delta, available, minimum) => {
    expect(resizeTrackPair([0.4, 0.6], index, delta, available, minimum)).toEqual([0.4, 0.6])
  })

  it('does not propagate malformed track values or mutate the input', () => {
    for (const values of [[NaN, 1], [Infinity, 1], [0, 1], [-1, 2], [1], [], [1, 1, 1, 1]]) {
      expect(resizeTrackPair(values, 0, 10, 1000, 100)).toEqual(values)
      expect(resizeTrackPair(values, 0, 10, 1000, 100)).not.toBe(values)
    }
  })

  it('uses bounded module heights and preserves stacked pair totals and unrelated state', () => {
    const original: WorkspaceSizes = { desktop: { 'left-main:111': { columns: [0.6, 0.4] } }, mobile: { ai: 700 } }
    expect(getStackHeight('editor', empty())).toBe(650)
    expect(getStackHeight('knowledge', empty())).toBe(520)
    expect(getStackHeight('ai', empty())).toBe(520)
    const resized = resizeStackPair(original, 'editor', 'knowledge', 100)
    expect(resized.mobile).toEqual({ editor: 750, knowledge: 420, ai: 700 })
    expect(resized.desktop).toBe(original.desktop)
    expect(original.mobile).toEqual({ ai: 700 })
    for (const delta of [-10000, 10000]) {
      const bounded = resizeStackPair(original, 'editor', 'knowledge', delta)
      expect(getStackHeight('editor', bounded) + getStackHeight('knowledge', bounded)).toBe(1170)
      expect(getStackHeight('editor', bounded)).toBeGreaterThanOrEqual(240)
      expect(getStackHeight('knowledge', bounded)).toBeGreaterThanOrEqual(240)
    }
    const large = resizeStackPair({ desktop: {}, mobile: { editor: 3900, knowledge: 3900 } }, 'editor', 'knowledge', 1000)
    expect(large.mobile).toEqual({ editor: 4000, knowledge: 3800 })
    for (const module of ['editor', 'knowledge', 'ai'] as WorkspaceModule[]) {
      expect(getStackHeight(module, { desktop: {}, mobile: { [module]: -10 } })).toBe(240)
      expect(getStackHeight(module, { desktop: {}, mobile: { [module]: 9000 } })).toBe(4000)
      expect(getStackHeight(module, { desktop: {}, mobile: { [module]: NaN } })).toBe(getStackHeight(module, empty()))
    }
    expect(resizeStackPair(original, 'editor', 'knowledge', NaN)).toBe(original)
    expect(resizeStackPair(original, 'editor', 'editor', 10)).toBe(original)
  })
})
