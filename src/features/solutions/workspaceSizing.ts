import type { CSSProperties } from 'react'
import type { WorkspaceArrangement, WorkspaceLayout, WorkspaceModule } from './layout'
import { workspaceGrid } from './workspacePanels'

export type WorkspaceAxis = 'columns' | 'rows'
export type WorkspaceTracks = { columns?: number[]; rows?: number[] }
export type WorkspaceSizes = {
  desktop: Record<string, WorkspaceTracks>
  mobile: Partial<Record<WorkspaceModule, number>>
}

export const WORKSPACE_SIZES_KEY = 'ks-workspace-sizes'
const modules: WorkspaceModule[] = ['editor', 'knowledge', 'ai']
const axes: WorkspaceAxis[] = ['columns', 'rows']
const emptySizes = (): WorkspaceSizes => ({ desktop: {}, mobile: {} })
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const clampHeight = (value: number) => Math.max(240, Math.min(4000, value))

function fractions(value: unknown, count?: number): number[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3 || (count !== undefined && value.length !== count)) return undefined
  if (!Array.from(value).every(item => typeof item === 'number' && Number.isFinite(item) && item > 0)) return undefined
  const total = value.reduce((sum, item) => sum + item, 0)
  // Scale overflowing sums so finite weights near Number.MAX_VALUE remain usable.
  const maximum = Math.max(...value), weights = Number.isFinite(total) ? value : value.map(item => item / maximum)
  const sum = Number.isFinite(total) ? total : weights.reduce((sum, item) => sum + item, 0)
  const normalized = weights.map(item => item / sum)
  return normalized.every(item => Number.isFinite(item) && item > 0) ? normalized : undefined
}

function gridTracks(grid: CSSProperties): { columns: number[]; rows: number[] } {
  const parse = (value: CSSProperties['gridTemplateColumns']): number[] => {
    const text = String(value), repeat = /^repeat\((\d+),/.exec(text)
    const weights = [...text.matchAll(/([\d.]+)fr/g)].map(match => Number(match[1]))
    return fractions(repeat ? Array(Number(repeat[1])).fill(weights[0]) : weights) || [1]
  }
  return { columns: parse(grid.gridTemplateColumns), rows: parse(grid.gridTemplateRows) }
}

export function sizeKey(layout: WorkspaceLayout, visible: Record<WorkspaceModule, boolean>): string {
  return `${layout.arrangement}:${layout.order.map(module => visible[module] ? '1' : '0').join('')}`
}

function keyGeometry(key: string): CSSProperties | null {
  const match = /^(columns|left-main|right-main|top-pair):([01]{3})$/.exec(key)
  if (!match) return null
  return workspaceGrid({ arrangement: match[1] as WorkspaceArrangement, order: ['editor', 'knowledge', 'ai'] }, {
    editor: match[2][0] === '1', knowledge: match[2][1] === '1', ai: match[2][2] === '1',
  })
}

export function readWorkspaceSizes(): WorkspaceSizes {
  const result = emptySizes()
  try {
    const parsed = object(JSON.parse(window.localStorage.getItem(WORKSPACE_SIZES_KEY) || 'null'))
    for (const [key, value] of Object.entries(object(parsed.desktop))) {
      const grid = keyGeometry(key)
      if (!grid) continue
      const defaults = gridTracks(grid), stored = object(value), tracks: WorkspaceTracks = {}
      for (const axis of axes) {
        const values = fractions(stored[axis], defaults[axis].length)
        if (values) tracks[axis] = values
      }
      if (Object.keys(tracks).length) result.desktop[key] = tracks
    }
    const mobile = object(parsed.mobile)
    for (const module of modules) {
      const height = mobile[module]
      if (typeof height === 'number' && Number.isFinite(height)) result.mobile[module] = clampHeight(height)
    }
  } catch { return emptySizes() }
  return result
}

function customTracks(layout: WorkspaceLayout, visible: Record<WorkspaceModule, boolean>, sizes: WorkspaceSizes, defaults: { columns: number[]; rows: number[] }): WorkspaceTracks {
  const stored = sizes.desktop[sizeKey(layout, visible)]
  return {
    columns: fractions(stored?.columns, defaults.columns.length),
    rows: fractions(stored?.rows, defaults.rows.length),
  }
}

export function getTrackSizes(layout: WorkspaceLayout, visible: Record<WorkspaceModule, boolean>, sizes: WorkspaceSizes): { columns: number[]; rows: number[] } {
  const defaults = gridTracks(workspaceGrid(layout, visible)), custom = customTracks(layout, visible, sizes, defaults)
  return { columns: custom.columns || defaults.columns, rows: custom.rows || defaults.rows }
}

export function getSizedGrid(layout: WorkspaceLayout, visible: Record<WorkspaceModule, boolean>, sizes: WorkspaceSizes): CSSProperties {
  const grid = workspaceGrid(layout, visible), custom = customTracks(layout, visible, sizes, gridTracks(grid))
  if (!custom.columns && !custom.rows) return grid
  const tracks = (values: number[]) => values.map(value => `minmax(0, ${value}fr)`).join(' ')
  return {
    ...grid,
    ...(custom.columns ? { gridTemplateColumns: tracks(custom.columns) } : {}),
    ...(custom.rows ? { gridTemplateRows: tracks(custom.rows) } : {}),
  }
}

export function setTrackSizes(sizes: WorkspaceSizes, layout: WorkspaceLayout, visible: Record<WorkspaceModule, boolean>, axis: WorkspaceAxis, values: number[]): WorkspaceSizes {
  const normalized = fractions(values, gridTracks(workspaceGrid(layout, visible))[axis].length)
  if (!normalized) return sizes
  const key = sizeKey(layout, visible)
  return { ...sizes, desktop: { ...sizes.desktop, [key]: { ...sizes.desktop[key], [axis]: normalized } } }
}

export function resetTrackSizes(sizes: WorkspaceSizes, layout: WorkspaceLayout, visible: Record<WorkspaceModule, boolean>, axis?: WorkspaceAxis): WorkspaceSizes {
  const key = sizeKey(layout, visible), current = sizes.desktop[key]
  if (!current || (axis && !current[axis])) return sizes
  const desktop = { ...sizes.desktop }, tracks = { ...current }
  if (axis) delete tracks[axis]
  if (!axis || !Object.keys(tracks).length) delete desktop[key]
  else desktop[key] = tracks
  return { ...sizes, desktop }
}

export function resizeTrackPair(values: number[], index: number, deltaPx: number, availablePx: number, minPx: number): number[] {
  const result = [...values]
  if (!fractions(values) || !Number.isInteger(index) || index < 0 || index >= values.length - 1
    || !Number.isFinite(deltaPx) || !Number.isFinite(availablePx) || availablePx <= 0 || !Number.isFinite(minPx) || minPx < 0) return result
  const sum = values[index] + values[index + 1]
  if (!Number.isFinite(sum)) return result
  // If both minimums cannot fit, divide the available pair equally.
  const minimum = Math.min(Math.max(minPx / availablePx, sum * Number.EPSILON), sum / 2)
  result[index] = Math.max(minimum, Math.min(sum - minimum, values[index] + deltaPx / availablePx))
  result[index + 1] = sum - result[index]
  return result
}

export function getStackHeight(module: WorkspaceModule, sizes: WorkspaceSizes): number {
  const stored = sizes.mobile[module]
  return typeof stored === 'number' && Number.isFinite(stored) ? clampHeight(stored) : module === 'editor' ? 650 : 520
}

export function resizeStackPair(sizes: WorkspaceSizes, before: WorkspaceModule, after: WorkspaceModule, delta: number): WorkspaceSizes {
  if (before === after || !Number.isFinite(delta)) return sizes
  const first = getStackHeight(before, sizes), sum = first + getStackHeight(after, sizes)
  const resized = Math.max(Math.max(240, sum - 4000), Math.min(Math.min(4000, sum - 240), first + delta))
  return { ...sizes, mobile: { ...sizes.mobile, [before]: resized, [after]: sum - resized } }
}
