import { fireEvent, render, screen } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Notes from '../../pages/Notes'
import Solutions from '../../pages/Solutions'
import InformationApp from '../information/InformationApp'
import PaperActions from '../knowledge-sources/PaperActions'
import NotesWorkspace from './NotesWorkspace'
import type { NotesClient } from './client'
import { server } from '../../test/setup'

// Keep the report's notes-client wiring real without loading its unrelated AI/editor APIs.
vi.mock('../solutions/SolutionsApp', () => ({
  default: ({ notesClient }: { notesClient: NotesClient }) => <NotesWorkspace client={notesClient} />,
}))

// Keep persistence and account-boundary flows explicit while the editor defaults to rich text.
function markdownBody() {
  const body = screen.getByRole('textbox', { name: '笔记正文' })
  if (body.tagName !== 'TEXTAREA') fireEvent.click(screen.getByRole('button', { name: 'Markdown' }))
  return screen.getByRole('textbox', { name: '笔记正文' })
}

beforeEach(() => {
  Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 100, height: 20, top: 0, right: 100, bottom: 20, left: 0, toJSON: () => ({}) })
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList
})

describe('portal note entry points', () => {
  it.each(['standalone', 'report', 'information', 'source'] as const)(
    '%s refuses an A draft after the session cookie changes to B', async entry => {
      let sessionIdentity = 'portal-a'
      const written: unknown[] = [], sentIdentities: (string | null)[] = []
      server.use(
        http.get('*/api/v1/notes', () => HttpResponse.json({ items: [], total: 0 })),
        http.post('*/api/v1/notes', async ({ request }) => {
          const identity = request.headers.get('X-Notes-Portal-Identity')
          sentIdentities.push(identity)
          // Reproduce the server contract: cookies authenticate the current session;
          // a pinned page identity prevents a stale draft from crossing accounts.
          if (identity && identity !== sessionIdentity) return HttpResponse.json({ detail: 'account changed' }, { status: 403 })
          const body = await request.json()
          written.push(body)
          return HttpResponse.json({ ...body as object, revision: 1, deleted_at: null }, { status: 201 })
        }),
      )
      const component = entry === 'standalone' ? <Notes /> : entry === 'report' ? <Solutions /> : entry === 'information' ? <InformationApp /> : <PaperActions paper={{ id: 'paper', title: '原始资料', folderIds: [], saved: true, indexStatus: 'ready' }} />
      render(<MemoryRouter initialEntries={['/information/notes']}><Routes>
        <Route element={<Outlet context={{ user: { id: 'a', username: 'a', displayName: '账号 A' }, identityNamespace: 'portal-a', preview: false, applications: [{ id: 'solutions', enabled: true }], refresh: vi.fn(), logout: vi.fn() }} />}>
          <Route path="*" element={component} />
        </Route>
      </Routes></MemoryRouter>)
      if (entry === 'source') fireEvent.click(screen.getByRole('button', { name: '基于此资料写笔记' }))
      else {
        await screen.findByText('还没有笔记')
        fireEvent.click(screen.getByRole('button', { name: '新建笔记' }))
      }
      fireEvent.change(screen.getByLabelText('笔记标题'), { target: { value: '账号 A 的草稿' } })
      fireEvent.change(markdownBody(), { target: { value: 'A 的私人正文' } })
      sessionIdentity = 'portal-b'
      fireEvent.click(screen.getByRole('button', { name: '保存笔记' }))
      expect(await screen.findByRole('alert')).toHaveTextContent('登录账号已变化')
      expect(markdownBody()).toHaveValue('A 的私人正文')
      expect(sentIdentities).toEqual(['portal-a'])
      expect(written).toEqual([])
    },
  )
})
