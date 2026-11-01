import { beforeEach, describe, expect, it, vi } from 'vitest'
import { discardWorkspaceRecovery, readWorkspaceRecovery, recoveredInlineCards, RECOVERY_MAX_CHARS, RECOVERY_TTL_MS, workspaceRecoveryScope, writeWorkspaceRecovery } from './workspaceRecovery'
import type { WorkspaceRecovery } from './workspaceRecovery'
import type { Answer, Solution } from './types'
import type { AnswerMode } from '../answerModes/types'

const scope = workspaceRecoveryScope('issuer-org-sub-hash', 'author', false)!
const snapshot = (): WorkspaceRecovery => ({ reportId: 'r1', sectionId: 's1', topicId: 'topic-1', question: '待发送的问题', context: '研究上下文', showContext: true, topicDrafts: { 'topic-2': { question: '另一个问题', context: '', showContext: false } }, selectedSourceIds: ['kb:sources/paper.md'], projectFilter: '', inlineCards: [{ id: 'inline-1', sectionId: 's1', offset: 2, question: '行内问题', includeContext: true, status: 'asking' }], interrupted: true, pendingTopicId: 'topic-1', listOpen: false })
const report = (): Solution => ({ id: 'r1', title: '研究报告', projectName: '', productName: '', ownerId: 'author', ownerName: '研究员', status: 'draft', revision: 1, version: 1, updatedAt: '', sections: [{ id: 's1', title: '章节', content: '正文内容' }], formula: [], references: [], reviewerId: null, reviewerName: '', reviewNotes: '', canEdit: true })
beforeEach(() => { vi.unstubAllGlobals(); sessionStorage.clear(); vi.restoreAllMocks() })

describe('bounded identity-scoped research recovery', () => {
  it('preserves valid answer restrictions, accepts legacy records, and rejects unknown modes', () => {
    for (const answerMode of ['auto', 'general', 'knowledge', 'web'] as AnswerMode[]) {
      expect(writeWorkspaceRecovery(scope, { ...snapshot(), answerMode })).toBe(true)
      expect(readWorkspaceRecovery(scope)?.answerMode).toBe(answerMode)
    }
    expect(writeWorkspaceRecovery(scope, snapshot())).toBe(true)
    expect(readWorkspaceRecovery(scope)?.answerMode).toBeUndefined()
    expect(writeWorkspaceRecovery(scope, { ...snapshot(), answerMode: 'unrestricted' } as unknown as WorkspaceRecovery)).toBe(false)
    const tampered = JSON.parse(sessionStorage.getItem(scope + 'active')!)
    tampered.state.answerMode = 'unrestricted'
    sessionStorage.setItem(scope + 'active', JSON.stringify(tampered))
    expect(readWorkspaceRecovery(scope)).toBeNull()
  })

  it('recovers only the same portal identity, subject, report and live/preview mode', () => {
    expect(writeWorkspaceRecovery(scope, snapshot())).toBe(true)
    expect(readWorkspaceRecovery(scope, 'r1')).toEqual(snapshot())
    expect(readWorkspaceRecovery(scope)?.reportId).toBe('r1')
    expect(readWorkspaceRecovery(workspaceRecoveryScope('other-issuer', 'author', false))).toBeNull()
    expect(readWorkspaceRecovery(workspaceRecoveryScope('issuer-org-sub-hash', 'other-subject', false))).toBeNull()
    expect(readWorkspaceRecovery(workspaceRecoveryScope('issuer-org-sub-hash', 'author', true))).toBeNull()
    expect(readWorkspaceRecovery(scope, 'r2')).toBeNull()
    expect(workspaceRecoveryScope(undefined, 'author', false)).toBeNull()
  })

  it('expires drafts after two hours and rejects future or malformed cache records', () => {
    const now = Date.now()
    writeWorkspaceRecovery(scope, snapshot(), now)
    expect(readWorkspaceRecovery(scope, undefined, now + RECOVERY_TTL_MS - 1)).not.toBeNull()
    expect(readWorkspaceRecovery(scope, undefined, now + RECOVERY_TTL_MS)).toBeNull()
    writeWorkspaceRecovery(scope, snapshot(), now + 31_000)
    expect(readWorkspaceRecovery(scope, undefined, now)).toBeNull()
    sessionStorage.setItem(scope + 'active', '{broken json')
    expect(readWorkspaceRecovery(scope)).toBeNull()
    sessionStorage.setItem(scope + 'active', JSON.stringify({ savedAt: now, state: { ...snapshot(), topicDrafts: JSON.parse('{"__proto__":{"question":"bad"}}') } }))
    expect(readWorkspaceRecovery(scope)).toBeNull()
  })

  it('limits record size and number, and handles unavailable browser storage', () => {
    for (let index = 0; index < 8; index++) writeWorkspaceRecovery(scope, { ...snapshot(), reportId: `r${index}` })
    expect(Object.keys(sessionStorage).filter(key => key.startsWith(scope + 'report:'))).toHaveLength(5)
    expect(writeWorkspaceRecovery(scope, { ...snapshot(), question: 'x'.repeat(4001) })).toBe(false)
    sessionStorage.setItem(scope + 'active', 'x'.repeat(RECOVERY_MAX_CHARS + 1))
    expect(readWorkspaceRecovery(scope)).toBeNull()
    vi.stubGlobal('sessionStorage', { get length() { throw new DOMException('Quota exceeded', 'QuotaExceededError') } })
    expect(writeWorkspaceRecovery(scope, snapshot())).toBe(false)
  })

  it('never persists inline answer bodies or citations and restores only server-authorized history', () => {
    const answer: Answer = { id: 'a1', conversationId: 'inline-1', question: '行内问题', content: '只能从服务器读取', context: '', scope: '', mode: 'ai', createdAt: '', references: [] }
    const saved = { ...snapshot(), inlineCards: [{ ...snapshot().inlineCards[0], answer, requestId: 'not-a-replay-ticket' }] }
    writeWorkspaceRecovery(scope, saved)
    expect(sessionStorage.getItem(scope + 'active')).not.toContain('只能从服务器读取')
    expect(sessionStorage.getItem(scope + 'active')).not.toContain('requestId')
    expect(recoveredInlineCards(snapshot(), report(), 'author')[0]).toMatchObject({ status: 'error', answer: undefined })
    expect(recoveredInlineCards(snapshot(), report(), 'author', [answer])[0]).toMatchObject({ status: 'answered', answer })
    expect(recoveredInlineCards(snapshot(), { ...report(), canEdit: false }, 'author', [answer])).toEqual([])
    expect(recoveredInlineCards(snapshot(), report(), 'other-account', [answer])).toEqual([])
    expect(recoveredInlineCards(snapshot(), { ...report(), status: 'final' }, 'author', [answer])).toEqual([])
  })

  it('drops deleted sections and invalid inline positions, and discards withdrawn report recovery', () => {
    const saved = snapshot()
    expect(recoveredInlineCards(saved, { ...report(), sections: [] }, 'author')).toEqual([])
    expect(recoveredInlineCards({ ...saved, inlineCards: [{ ...saved.inlineCards[0], offset: 20 }] }, report(), 'author')).toEqual([])
    expect(recoveredInlineCards({ ...saved, inlineCards: [{ ...saved.inlineCards[0], offset: 1 }] }, { ...report(), sections: [{ id: 's1', title: '', content: '🧪研究' }] }, 'author')).toEqual([])
    writeWorkspaceRecovery(scope, saved)
    discardWorkspaceRecovery(scope, 'r1')
    expect(readWorkspaceRecovery(scope)).toBeNull()
    expect(readWorkspaceRecovery(scope, 'r1')).toBeNull()
  })
})
