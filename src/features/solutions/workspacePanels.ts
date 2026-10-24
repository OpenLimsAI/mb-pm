import type { CSSProperties } from 'react'
import type { WorkspaceLayout, WorkspaceModule } from './layout'

export const panelStorageKey = 'ks-workspace-panels'
export type PanelPreferences = { visible: Record<WorkspaceModule, boolean>; outlineVisible: boolean; outlineWidth: number }
const fallback = (): PanelPreferences => ({ visible: { editor: true, knowledge: true, ai: true }, outlineVisible: true, outlineWidth: 190 })
export const clampOutlineWidth = (width: number) => Math.max(160, Math.min(360, Math.round(width)))
const bool = (value: unknown, otherwise = true): boolean => typeof value === 'boolean' ? value : otherwise
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
export function readPanelPreferences(): PanelPreferences {
  try {
    const raw = localStorage.getItem(panelStorageKey)
    if (raw) {
      const parsed = object(JSON.parse(raw)), visible = object(parsed.visible)
      return { visible: { editor: bool(visible.editor), knowledge: bool(visible.knowledge), ai: bool(visible.ai) }, outlineVisible: bool(parsed.outlineVisible), outlineWidth: typeof parsed.outlineWidth === 'number' && Number.isFinite(parsed.outlineWidth) ? clampOutlineWidth(parsed.outlineWidth) : 190 }
    }
    const previous = object(JSON.parse(localStorage.getItem('ks-layout') || '{}'))
    return { ...fallback(), visible: { editor: bool(previous.left), knowledge: bool(previous.right) && bool(previous.knowledge), ai: bool(previous.right) && bool(previous.ai) } }
  } catch { return fallback() }
}

// Remove hidden tracks while keeping the remaining modules in their selected positions.
export function workspaceGrid(layout: WorkspaceLayout, visible: Record<WorkspaceModule, boolean>): CSSProperties {
  const slots = layout.order.flatMap((module, index) => visible[module] ? [`s${index + 1}`] : [])
  if (slots.length < 2) return { gridTemplateAreas: `"${slots[0] || 'empty'}"`, gridTemplateColumns: 'minmax(0, 1fr)', gridTemplateRows: 'minmax(0, 1fr)' }
  if (slots.length === 2) {
    const stacked = (layout.arrangement === 'left-main' && !slots.includes('s1')) || (layout.arrangement === 'right-main' && !slots.includes('s3')) || (layout.arrangement === 'top-pair' && slots.includes('s3'))
    return { gridTemplateAreas: stacked ? `"${slots[0]}" "${slots[1]}"` : `"${slots.join(' ')}"`, gridTemplateColumns: stacked ? 'minmax(0, 1fr)' : 'repeat(2, minmax(0, 1fr))', gridTemplateRows: stacked ? 'repeat(2, minmax(0, 1fr))' : 'minmax(0, 1fr)' }
  }
  const areas = { columns: '"s1 s2 s3"', 'left-main': '"s1 s2" "s1 s3"', 'right-main': '"s1 s3" "s2 s3"', 'top-pair': '"s1 s2" "s3 s3"' }
  const columns = { columns: 'repeat(3, minmax(0, 1fr))', 'left-main': 'minmax(0, 3fr) minmax(0, 2fr)', 'right-main': 'minmax(0, 2fr) minmax(0, 3fr)', 'top-pair': 'repeat(2, minmax(0, 1fr))' }
  return { gridTemplateAreas: areas[layout.arrangement], gridTemplateColumns: columns[layout.arrangement], gridTemplateRows: layout.arrangement === 'columns' ? 'minmax(0, 1fr)' : 'repeat(2, minmax(0, 1fr))' }
}
