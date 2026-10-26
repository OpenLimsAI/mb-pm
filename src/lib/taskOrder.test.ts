import { expect, test } from 'vitest'
import { byWbsOrder, sortTasksByProjectWbsOrder } from './taskOrder'

const projects = [{ id: 'project-z' }, { id: 'project-a' }]
const subs = [
  { id: 'supplier', projectId: 'project-z', sortOrder: 2 },
  { id: 'other-project', projectId: 'project-a', sortOrder: 1 },
  { id: 'kickoff', projectId: 'project-z', sortOrder: 1 },
]
const task = (code: string, subProjectId: string, sortOrder: number | null, plannedStart = '2026-09-01') => ({ code, subProjectId, sortOrder, plannedStart })

test('项目沿用列表顺序，子项目和任务沿用 WBS 顺序，不按日期打散', () => {
  const tasks = [task('B-1', 'other-project', 1), task('A-2', 'supplier', 2, '2026-01-01'), task('A-1', 'supplier', 1), task('MEETING', 'kickoff', 1)]
  expect(sortTasksByProjectWbsOrder(tasks, projects, subs).map((t) => t.code)).toEqual(['MEETING', 'A-1', 'A-2', 'B-1'])
  expect(tasks.map((t) => t.code)).toEqual(['B-1', 'A-2', 'A-1', 'MEETING'])
  expect(subs.map((s) => s.id)).toEqual(['supplier', 'other-project', 'kickoff'])
})

test('没有手动任务序号的旧数据与项目 WBS 使用同一个日期和编号兜底', () => {
  const tasks = [task('LEGACY-B', 'kickoff', null), task('LEGACY-A', 'kickoff', null), task('MANUAL', 'kickoff', 1, '2027-01-01')]
  expect(sortTasksByProjectWbsOrder(tasks, projects, subs)).toEqual([...tasks].sort(byWbsOrder))
})

test('子项目序号相同时保持原子项目列表顺序，与 WBS 的稳定排序一致', () => {
  const equalSubs = subs.map((s) => ({ ...s, sortOrder: 1 }))
  const tasks = [task('MEETING', 'kickoff', 1), task('SUPPLIER', 'supplier', 1)]
  expect(sortTasksByProjectWbsOrder(tasks, projects, equalSubs).map((t) => t.code)).toEqual(['SUPPLIER', 'MEETING'])
})

test('数据暂缺父级时放在完整层级后，不丢失任务', () => {
  const tasks = [task('ORPHAN', 'missing-sub', 1), task('MEETING', 'kickoff', 1)]
  expect(sortTasksByProjectWbsOrder(tasks, projects, subs).map((t) => t.code)).toEqual(['MEETING', 'ORPHAN'])
})
