import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  defaultWorkspaceLayout,
  isWorkspaceLayout,
  readWorkspaceLayout,
  WORKSPACE_LAYOUT_STORAGE_KEY,
} from './layout'
import type { WorkspaceArrangement, WorkspaceModule } from './layout'

describe('workspace layout preferences', () => {
  beforeEach(() => window.localStorage.clear())
  afterEach(() => vi.restoreAllMocks())

  it('opens the default layout when no preference is stored', () => {
    expect(readWorkspaceLayout()).toEqual({ arrangement: 'left-main', order: ['editor', 'knowledge', 'ai'] })
  })

  it.each<WorkspaceArrangement>(['columns', 'left-main', 'right-main', 'top-pair'])('restores the %s arrangement', arrangement => {
    const layout = { arrangement, order: ['ai', 'editor', 'knowledge'] }
    window.localStorage.setItem(WORKSPACE_LAYOUT_STORAGE_KEY, JSON.stringify(layout))
    expect(readWorkspaceLayout()).toEqual(layout)
  })

  it.each<[WorkspaceModule, WorkspaceModule, WorkspaceModule]>([
    ['editor', 'knowledge', 'ai'],
    ['editor', 'ai', 'knowledge'],
    ['knowledge', 'editor', 'ai'],
    ['knowledge', 'ai', 'editor'],
    ['ai', 'editor', 'knowledge'],
    ['ai', 'knowledge', 'editor'],
  ])('restores module order %s, %s, %s', (...order) => {
    const layout = { arrangement: 'top-pair', order }
    window.localStorage.setItem(WORKSPACE_LAYOUT_STORAGE_KEY, JSON.stringify(layout))
    expect(readWorkspaceLayout()).toEqual(layout)
  })

  it.each([
    ['malformed JSON', '{broken'],
    ['empty storage value', ''],
    ['JSON string', '"left-main"'],
    ['JSON number', '3'],
    ['JSON boolean', 'true'],
    ['JSON null', 'null'],
    ['JSON array', '[]'],
    ['missing fields', '{}'],
    ['missing arrangement', '{"order":["editor","knowledge","ai"]}'],
    ['unknown arrangement', '{"arrangement":"stacked","order":["editor","knowledge","ai"]}'],
    ['inherited object name as arrangement', '{"arrangement":"constructor","order":["editor","knowledge","ai"]}'],
    ['non-string arrangement', '{"arrangement":1,"order":["editor","knowledge","ai"]}'],
    ['missing order', '{"arrangement":"columns"}'],
    ['string order', '{"arrangement":"columns","order":"editor,knowledge,ai"}'],
    ['object order', '{"arrangement":"columns","order":{"0":"editor","1":"knowledge","2":"ai","length":3}}'],
    ['null order', '{"arrangement":"columns","order":null}'],
    ['empty order', '{"arrangement":"columns","order":[]}'],
    ['short order', '{"arrangement":"columns","order":["editor","knowledge"]}'],
    ['long order', '{"arrangement":"columns","order":["editor","knowledge","ai","editor"]}'],
    ['duplicate module', '{"arrangement":"columns","order":["editor","knowledge","editor"]}'],
    ['unknown module', '{"arrangement":"columns","order":["editor","knowledge","chat"]}'],
    ['non-string module', '{"arrangement":"columns","order":["editor","knowledge",3]}'],
    ['null module', '{"arrangement":"columns","order":["editor","knowledge",null]}'],
  ])('falls back for %s', (_name, stored) => {
    window.localStorage.setItem(WORKSPACE_LAYOUT_STORAGE_KEY, stored)
    expect(readWorkspaceLayout()).toEqual(defaultWorkspaceLayout)
  })

  it('rejects sparse module arrays', () => {
    const order = ['editor', 'knowledge']
    order.length = 3
    expect(isWorkspaceLayout({ arrangement: 'columns', order })).toBe(false)
  })

  it('falls back when reading storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage denied') })
    expect(readWorkspaceLayout()).toEqual(defaultWorkspaceLayout)
  })

  it('falls back when accessing storage throws', () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => { throw new Error('Storage unavailable') })
    expect(readWorkspaceLayout()).toEqual(defaultWorkspaceLayout)
  })

  it('returns independent fallback objects and arrays', () => {
    const first = readWorkspaceLayout()
    const second = readWorkspaceLayout()
    expect(first).not.toBe(defaultWorkspaceLayout)
    expect(first.order).not.toBe(defaultWorkspaceLayout.order)
    expect(first).not.toBe(second)
    expect(first.order).not.toBe(second.order)
    first.arrangement = 'columns'
    first.order.reverse()
    expect(defaultWorkspaceLayout).toEqual({ arrangement: 'left-main', order: ['editor', 'knowledge', 'ai'] })
    expect(readWorkspaceLayout()).toEqual(second)
  })

  it('returns independent stored preferences without writing storage', () => {
    const layout = { arrangement: 'right-main', order: ['knowledge', 'ai', 'editor'] }
    window.localStorage.setItem(WORKSPACE_LAYOUT_STORAGE_KEY, JSON.stringify(layout))
    const save = vi.spyOn(Storage.prototype, 'setItem')
    const first = readWorkspaceLayout()
    first.order.reverse()
    expect(readWorkspaceLayout()).toEqual(layout)
    expect(save).not.toHaveBeenCalled()
  })
})
