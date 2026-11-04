import { expect, test } from 'vitest'
import { taskLink } from './taskLink'

test('task links include the project, WBS tab and encoded task ID', () => {
  expect(taskLink({ id: 'task & 1', subProjectId: 's' }, [{ id: 's', projectId: 'project/1' }])).toBe('/projects/project%2F1?tab=wbs&task=task%20%26%201')
  expect(taskLink({ id: 't', subProjectId: 'hidden' }, [])).toBe('/tasks')
})
