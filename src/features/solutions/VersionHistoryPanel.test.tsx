import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import VersionHistoryPanel from './VersionHistoryPanel'
import { revisionDiff } from './revisionDiff'
import type { Solution, Version } from './types'

describe('revision comparison', () => {
  it('preserves repeated lines and identifies replacements', () => {
    expect(revisionDiff('A\nB\nA', 'A\nC\nA')).toEqual([{ kind: 'same', text: 'A' }, { kind: 'removed', text: 'B' }, { kind: 'added', text: 'C' }, { kind: 'same', text: 'A' }])
  })
  it('bounds large comparison work and keeps all text', () => {
    const diff = revisionDiff('A\n'.repeat(1000), 'B\n'.repeat(1000))
    expect(diff.filter(line => line.kind === 'removed')).toHaveLength(1001)
    expect(diff.filter(line => line.kind === 'added')).toHaveLength(1001)
  })
  it('requires confirmation before restoring only the selected chapter', async () => {
    const doc = { title: '报告', canEdit: true, status: 'draft', sections: [{ id: 'one', title: '章节一', content: '新内容' }] } as Solution
    const version = { id: 'old', note: '第一次', version: 1, createdAt: '2026-11-02', actorName: '作者', snapshot: { ...doc, sections: [{ id: 'one', title: '章节一', content: '原内容' }] } } as Version
    const restore = vi.fn().mockResolvedValue(undefined)
    render(<VersionHistoryPanel doc={doc} versions={[version]} busy={false} onSnapshot={vi.fn()} onRestoreSection={restore} onRestoreReport={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '恢复此章节' }))
    expect(restore).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '确认恢复' }))
    expect(restore).toHaveBeenCalledWith('old', 'one')
  })
})
