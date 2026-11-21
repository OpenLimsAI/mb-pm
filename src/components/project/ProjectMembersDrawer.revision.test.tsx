import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { ProjectMembersDrawer } from './ProjectMembersDrawer'
import { projects, users } from '../../mock'
import { useDataStore } from '../../store/data'
import { updateProjectMembers } from '../../data/bootstrap'
vi.mock('../../data/bootstrap', () => ({ updateProjectMembers: vi.fn().mockResolvedValue(undefined), refreshAllData: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../lib/projectTeam', () => ({ taskLoadOf: () => new Map() }))
beforeEach(() => { vi.clearAllMocks(); useDataStore.setState({ mode: 'api' }) })
test('后台刷新不把未保存成员草稿提升到新修订，确认后才能继续', async () => {
  const owner = users[0], member = users.find(u => u.id !== owner.id && u.isActive !== false)!
  const project = { ...projects[0], ownerId: owner.id, memberIds: [], revision: 1 }
  const view = render(<ProjectMembersDrawer project={project} onClose={vi.fn()} />)
  fireEvent.click(screen.getByRole('checkbox', { name: new RegExp(member.displayName) }))
  view.rerender(<ProjectMembersDrawer project={{ ...project, revision: 2, name: '已修改名称' }} onClose={vi.fn()} />)
  expect(screen.getByRole('alert')).toHaveTextContent('你的成员选择已保留')
  expect(screen.getByRole('button', { name: '保存成员' })).toBeDisabled()
  expect(updateProjectMembers).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '核对后保留我的选择' }))
  fireEvent.click(screen.getByRole('button', { name: '保存成员' }))
  expect(updateProjectMembers).toHaveBeenCalledWith(project.id, [member.id], 2)
})
