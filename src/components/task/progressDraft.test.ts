import { beforeEach, expect, test } from 'vitest'
import { tasks } from '../../mock'
import { clearProgressDraft, draftFromTask, loadProgressDraft, progressPatch, storeProgressDraft } from './progressDraft'

beforeEach(() => sessionStorage.clear())

test('执行层部分更新不带计划日期，空值和实际零花费区分', () => {
  const task = { ...tasks[0], revision: 2, actualCost: undefined }
  const draft = { ...draftFromTask(task), plannedEnd: '2030-01-01', actualCost: '0' }
  expect(progressPatch(task, draft, false)).toEqual({ actualCost: 0 })
  expect(progressPatch(task, draft, true)).toEqual({ actualCost: 0, plannedEnd: '2030-01-01' })
})

test('临时草稿按账号和任务隔离，保留原始版本供冲突比较，明确清除后不恢复', () => {
  const task = { ...tasks[0], revision: 2 }
  const draft = { ...draftFromTask(task), note: '跨页面仍保留的说明', actualCost: '0' }
  storeProgressDraft('person-a', task, draft)
  const recovered = loadProgressDraft('person-a', { ...task, revision: 3, progress: 80 }, false)
  expect(recovered.restored).toBe(true)
  expect(recovered.base.revision).toBe(2)
  expect(recovered.draft.note).toBe(draft.note)
  expect(recovered.draft.actualCost).toBe('0')
  expect(loadProgressDraft('person-b', task, false).restored).toBe(false)
  expect(loadProgressDraft('person-a', { ...task, id: 'another-task' }, false).restored).toBe(false)
  clearProgressDraft('person-a', task.id)
  expect(loadProgressDraft('person-a', task, false).restored).toBe(false)
})
