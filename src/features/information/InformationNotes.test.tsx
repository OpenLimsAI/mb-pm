import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'
import { beforeEach, expect, it, vi } from 'vitest'
import InformationApp from './InformationApp'
import { createPreviewNotesClient } from '../notes/client'
import { newNote } from '../notes/draft'
import { HttpResponse, http } from 'msw'
import { server } from '../../test/setup'
import { getInformation } from './api'
vi.mock('./api', async original => ({ ...await original<typeof import('./api')>(), getInformation: vi.fn() }))
const user = { id: 'person', username: 'person', displayName: '研究员' }
function mount(path: string, preview = true) {
  return render(<MemoryRouter initialEntries={[path]}><Routes><Route element={<Outlet context={{ user, identityNamespace: 'issuer', preview, applications: [], refresh: vi.fn(), logout: vi.fn() }} />}><Route path="/information/*" element={<InformationApp />} /></Route></Routes></MemoryRouter>)
}
beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks()
  Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 100, height: 20, top: 0, right: 100, bottom: 20, left: 0, toJSON: () => ({}) })
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList
})
it('shares independent notes with the standalone app and can edit them from industry information', async () => {
  const client = createPreviewNotesClient('issuer:person'), draft = newNote({ title: '我的跨应用观察', content: '报告内的个人思考', sourceApp: 'solutions' })
  await client.create(draft.id, draft)
  mount('/information/notes?preview=1')
  expect(await screen.findByRole('heading', { name: '我的跨应用观察' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '编辑笔记' }))
  expect(screen.getByRole('textbox', { name: '笔记正文' })).toHaveAttribute('contenteditable', 'true')
  fireEvent.click(screen.getByRole('button', { name: 'Markdown' }))
  fireEvent.change(screen.getByRole('textbox', { name: '笔记正文' }), { target: { value: '行业信息中补充的想法' } })
  fireEvent.click(screen.getByRole('button', { name: '保存笔记' }))
  await screen.findByText('行业信息中补充的想法')
  expect((await client.list()).items[0].content).toBe('行业信息中补充的想法')
  expect(getInformation).not.toHaveBeenCalled()
})
it('lets a reader select industry text and save its excerpt with source attribution', async () => {
  const { container } = mount('/information/library?preview=1')
  const article = container.querySelector('.if-document-detail')!
  expect(article).toBeTruthy()
  const paragraph = article.querySelector('h2')!, selected = paragraph.textContent!
  const range = document.createRange(); range.selectNodeContents(paragraph)
  range.getBoundingClientRect = () => ({ left: 400, top: 230, bottom: 250 }) as DOMRect
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
  fireEvent.mouseUp(paragraph)
  fireEvent.click(screen.getByRole('button', { name: '存入我的笔记' }))
  const dialog = screen.getByRole('dialog', { name: '存入我的笔记' })
  expect(within(dialog).getByRole('textbox', { name: '笔记正文' })).toHaveTextContent(selected)
  expect(within(dialog).getByRole('button', { name: '可视编辑' })).toHaveAttribute('aria-pressed', 'true')
  expect(within(dialog).getByRole('link', { name: '查看来源' })).toHaveAttribute('href', expect.stringMatching(/^https:\/\//))
  fireEvent.click(within(dialog).getByRole('button', { name: '保存笔记' }))
  await screen.findByText('已存入我的笔记。')
  const saved = (await createPreviewNotesClient('issuer:person').list()).items[0]
  expect(saved).toMatchObject({ content: selected, sourceApp: 'information', sourceTitle: selected })
  selection.removeAllRanges()
})
it('does not depend on the industry snapshot service to show the personal notes area', async () => {
  server.use(http.get('*/api/v1/notes', () => HttpResponse.json({ items: [], total: 0 })))
  mount('/information/notes', false)
  await screen.findByText('还没有笔记')
  expect(getInformation).not.toHaveBeenCalled()
})
