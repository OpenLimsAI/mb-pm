import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import NotesWorkspace from './NotesWorkspace'
import { createPreviewNotesClient } from './client'
import { knowledgeLaunchUrl } from '../../lib/site'
import Notes from '../../pages/Notes'
import * as notesClient from './client'

vi.mock('../../components/portal/context', () => ({ usePortalContext: () => ({ user: { id: 'embed-person', username: '研究员' }, identityNamespace: 'embed-issuer', preview: true }) }))

const identity = 'a'.repeat(64)
const origin = new URL(knowledgeLaunchUrl).origin
afterEach(() => { vi.restoreAllMocks(); window.history.replaceState({}, '', '/'); localStorage.clear() })

function embeddedPage() {
  const postMessage = vi.fn()
  const parent = { postMessage } as unknown as Window
  vi.spyOn(window, 'parent', 'get').mockReturnValue(parent)
  window.history.replaceState({}, '', `/notes?embed=knowledge#${identity}`)
  return { parent, postMessage }
}

it('announces readiness only after identity-bound notes have loaded and replies only to its trusted parent', async () => {
  const { parent, postMessage } = embeddedPage()
  const client = createPreviewNotesClient('embed-user')
  let finish!: (value: Awaited<ReturnType<typeof client.list>>) => void
  vi.spyOn(client, 'list').mockImplementation(() => new Promise(resolve => { finish = resolve }))
  render(<NotesWorkspace client={client} acceptParentRefresh />)
  await waitFor(() => expect(client.list).toHaveBeenCalledOnce())
  expect(postMessage).not.toHaveBeenCalled()
  await act(async () => finish({ items: [], total: 0 }))
  expect(postMessage).toHaveBeenCalledWith({ type: 'mberp:notes:ready', version: 1, identity }, origin)
  postMessage.mockClear()
  const request = (source: Window, eventOrigin = origin, version = 1) => act(() => {
    window.dispatchEvent(new MessageEvent('message', { source, origin: eventOrigin, data: { type: 'mberp:notes:status', version } }))
  })
  request(window)
  request(parent, 'https://untrusted.example')
  request(parent, origin, 2)
  expect(postMessage).not.toHaveBeenCalled()
  request(parent)
  expect(postMessage).toHaveBeenCalledOnce()
})

it('sends no notes or error text to the parent after a failed identity check', async () => {
  const { postMessage } = embeddedPage()
  const client = createPreviewNotesClient('denied-user')
  vi.spyOn(client, 'list').mockRejectedValue(new Error('工作台和知识库登录的账号不一致，请重新登录。'))
  render(<NotesWorkspace client={client} acceptParentRefresh />)
  expect(await screen.findByRole('alert')).toHaveTextContent('账号不一致')
  expect(postMessage).toHaveBeenCalledWith({ type: 'mberp:notes:unavailable', version: 1, identity }, origin)
  expect(postMessage.mock.calls).toHaveLength(1)
})

it('keeps existing refresh messages working without accepting another window', async () => {
  const { parent } = embeddedPage()
  const client = createPreviewNotesClient('refresh-user')
  const list = vi.spyOn(client, 'list')
  render(<NotesWorkspace client={client} acceptParentRefresh />)
  await screen.findByText('还没有笔记')
  const refresh = (source: Window) => act(() => window.dispatchEvent(new MessageEvent('message', { source, origin, data: { type: 'mberp:notes:refresh' } })))
  refresh(window)
  expect(list).toHaveBeenCalledOnce()
  refresh(parent)
  await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
})

it('keeps the loaded workspace on transient failures but revokes readiness on identity loss', async () => {
  const { parent, postMessage } = embeddedPage()
  const client = createPreviewNotesClient('refresh-failure')
  const list = vi.spyOn(client, 'list')
  render(<NotesWorkspace client={client} acceptParentRefresh />)
  await screen.findByText('还没有笔记')
  postMessage.mockClear()
  list.mockRejectedValueOnce(Object.assign(new Error('暂时连接失败'), { status: 503 }))
  const refresh = () => act(() => window.dispatchEvent(new MessageEvent('message', { source: parent, origin, data: { type: 'mberp:notes:refresh' } })))
  refresh()
  expect(await screen.findByRole('alert')).toHaveTextContent('暂时连接失败')
  expect(postMessage).not.toHaveBeenCalled()
  list.mockRejectedValueOnce(Object.assign(new Error('账号已经变化'), { status: 403 }))
  refresh()
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('账号已经变化'))
  expect(postMessage).toHaveBeenCalledWith({ type: 'mberp:notes:unavailable', version: 1, identity }, origin)
})

it('keeps the verified identity for status and revocation after the native skip link changes the fragment', async () => {
  const { parent, postMessage } = embeddedPage()
  const client = createPreviewNotesClient('skip-link-user')
  const list = vi.spyOn(client, 'list')
  const factory = vi.spyOn(notesClient, 'createPreviewNotesClient').mockReturnValue(client)
  const view = render(<Notes />)
  await screen.findByText('还没有笔记')
  expect(postMessage).toHaveBeenCalledWith({ type: 'mberp:notes:ready', version: 1, identity }, origin)
  fireEvent.click(screen.getByRole('link', { name: '跳至笔记内容' }))
  await waitFor(() => expect(window.location.hash).toBe('#pn-content'))
  view.rerender(<Notes />)
  expect(factory).toHaveBeenCalledOnce()
  postMessage.mockClear()
  const status = () => act(() => window.dispatchEvent(new MessageEvent('message', { source: parent, origin, data: { type: 'mberp:notes:status', version: 1 } })))
  status()
  expect(postMessage).toHaveBeenCalledWith({ type: 'mberp:notes:ready', version: 1, identity }, origin)
  postMessage.mockClear()
  list.mockRejectedValueOnce(Object.assign(new Error('账号已经变化'), { status: 403 }))
  act(() => window.dispatchEvent(new MessageEvent('message', { source: parent, origin, data: { type: 'mberp:notes:refresh' } })))
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('账号已经变化'))
  expect(postMessage).toHaveBeenCalledWith({ type: 'mberp:notes:unavailable', version: 1, identity }, origin)
  postMessage.mockClear()
  status()
  expect(postMessage).toHaveBeenCalledWith({ type: 'mberp:notes:unavailable', version: 1, identity }, origin)
})
