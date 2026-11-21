import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, expect, it, vi } from 'vitest'
import KnowledgeSourceApp from './KnowledgeSourceApp'
import type { LibraryPaper } from './v3-api'

const api = vi.hoisted(() => ({ snapshot: vi.fn(), mutate: vi.fn(), get: vi.fn(), post: vi.fn() }))
vi.mock('../../components/portal/context', () => ({ usePortalContext: () => ({
  preview: false, identityNamespace: 'files', user: { id: 'reader', username: 'reader' },
  applications: [{ id: 'knowledge-sources', enabled: true }],
}) }))
vi.mock('./api', async original => ({ ...await original<typeof import('./api')>(),
  getKnowledgeSources: api.snapshot, mutateKnowledgeSources: api.mutate,
}))
vi.mock('./v3-api', async original => ({ ...await original<typeof import('./v3-api')>(),
  knowledgeV3Get: api.get, knowledgeV3Post: api.post,
}))

const papers: LibraryPaper[] = [
  { id: 'sources/one.md', title: '资料一', folderIds: ['topic'], indexStatus: 'ready', saved: true },
  { id: 'sources/two.md', title: '资料二', folderIds: ['topic'], indexStatus: 'ready', saved: true },
]
let available: LibraryPaper[]

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  vi.clearAllMocks()
  window.history.replaceState({}, '', '/knowledge-sources?folder=topic')
  available = [...papers]
  api.snapshot.mockResolvedValue({
    papers: [], sources: [], jobs: [], documents: [], starred: [],
    folders: [{ id: 'topic', name: '实验资料', writable: true }, { id: 'inbox', name: '待整理', systemRole: 'inbox' }],
    libraryV3: true, catalogRevision: 7, canManage: true, canOrganize: true,
    integration: { status: 'ready', message: '' },
  })
  api.mutate.mockResolvedValue({})
  api.get.mockResolvedValue({ reading: {}, location: {}, rules: [], collections: [] })
  api.post.mockImplementation(async (path: string, input: { paperId: string; planId?: string }) => {
    if (path === '/library/query') return { papers: available, total: available.length, offset: 0, limit: 50, revision: 7 }
    if (path === '/library/delete-preview') {
      return { planId: 'plan-' + input.paperId, path: input.paperId, expiresAt: '2030-01-01T00:00:00Z',
        pages: [], sharedCount: 0, unverifiedCount: 0 }
    }
    if (path === '/library/delete') {
      available = available.filter(paper => paper.id !== input.paperId)
      return { operationId: input.planId, path: input.paperId, status: 'succeeded', completed: 1, total: 1 }
    }
    return {}
  })
})

async function selectFiles() {
  render(<MemoryRouter><KnowledgeSourceApp /></MemoryRouter>)
  fireEvent.click(await screen.findByRole('button', { name: '调整文件 资料一' }))
  fireEvent.click(screen.getByRole('checkbox', { name: '选择 资料二' }))
}

async function confirmFile(title: string) {
  const dialog = screen.getByRole('dialog')
  expect(within(dialog).getByText(title)).toBeInTheDocument()
  const confirm = within(dialog).getByRole('button', { name: '确认删除文件' })
  await waitFor(() => expect(confirm).toBeEnabled())
  fireEvent.click(confirm)
}

const deletedIds = () => api.post.mock.calls.filter(([path]) => path === '/library/delete').map(([, input]) => input.paperId)

it('asks again for every selected file and clears the selection after the final success', async () => {
  await selectFiles()
  fireEvent.click(screen.getByRole('button', { name: '删除' }))
  expect(await screen.findByText(/第 1 \/ 2 份/)).toBeInTheDocument()
  expect(deletedIds()).toEqual([])
  await confirmFile('资料一')
  expect(await screen.findByText(/第 2 \/ 2 份/)).toBeInTheDocument()
  expect(deletedIds()).toEqual([papers[0].id])
  await confirmFile('资料二')
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(deletedIds()).toEqual(papers.map(paper => paper.id))
  expect(screen.getByRole('button', { name: '删除' })).toBeDisabled()
})

it('keeps unconfirmed files selected when the user exits after the first success', async () => {
  await selectFiles()
  fireEvent.click(screen.getByRole('button', { name: '删除' }))
  await confirmFile('资料一')
  await screen.findByText(/第 2 \/ 2 份/)
  fireEvent.click(screen.getByRole('button', { name: '退出逐份确认' }))
  expect(deletedIds()).toEqual([papers[0].id])
  expect(screen.getByRole('checkbox', { name: '选择 资料二' })).toBeChecked()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

it('removes all selected files from the active folder with one revisioned mutation', async () => {
  await selectFiles()
  fireEvent.click(screen.getByRole('button', { name: '移出此文件夹' }))
  await waitFor(() => expect(api.mutate).toHaveBeenCalledExactlyOnceWith('post', '/papers/folders', {
    paperIds: papers.map(paper => paper.id), folderIds: [], mode: 'remove', fromFolderId: 'topic', revision: 7,
  }))
  expect(deletedIds()).toEqual([])
})
