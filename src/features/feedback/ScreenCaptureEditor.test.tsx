import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ScreenCaptureEditor from './ScreenCaptureEditor'

const contexts: Array<{ canvas: HTMLCanvasElement; drawImage: ReturnType<typeof vi.fn>; fillRect: ReturnType<typeof vi.fn>; strokeRect: ReturnType<typeof vi.fn> }> = []
let display: ReturnType<typeof vi.fn>
let stop: ReturnType<typeof vi.fn>
const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal')
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close')
const originalMedia = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')

beforeEach(() => {
  contexts.length = 0
  stop = vi.fn()
  display = vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] })
  vi.stubGlobal('PointerEvent', MouseEvent)
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getDisplayMedia: display } })
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', '') } })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open') } })
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(640)
  vi.spyOn(HTMLVideoElement.prototype, 'videoHeight', 'get').mockReturnValue(480)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    const context = { canvas: this, drawImage: vi.fn(), fillRect: vi.fn(), strokeRect: vi.fn(), setLineDash: vi.fn(), fillText: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn() }
    contexts.push(context)
    return context as unknown as CanvasRenderingContext2D
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (callback, type) { callback(new Blob(['flattened pixels'], { type: type || 'image/png' })) })
})
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  if (originalShow) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShow)
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal')
  if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, 'close', originalClose)
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'close')
  if (originalMedia) Object.defineProperty(navigator, 'mediaDevices', originalMedia)
  else Reflect.deleteProperty(navigator, 'mediaDevices')
})

async function openEditor() {
  await userEvent.click(screen.getByRole('button', { name: '截图并标注' }))
  return screen.findByRole('dialog', { name: '截图标注' })
}

it('requests capture only after a user click and releases the stream before adding anything', async () => {
  const onAdd = vi.fn()
  render(<ScreenCaptureEditor onAdd={onAdd} />)
  expect(display).not.toHaveBeenCalled()
  const dialog = await openEditor()
  expect(display).toHaveBeenCalledWith({ video: true, audio: false })
  expect(stop).toHaveBeenCalledTimes(1)
  expect(onAdd).not.toHaveBeenCalled()
  await userEvent.click(within(dialog).getByRole('button', { name: '添加到反馈' }))
  expect(onAdd).toHaveBeenCalledTimes(1)
  const file = onAdd.mock.calls[0][0] as File
  expect(file).toBeInstanceOf(File)
  expect(file.type).toBe('image/png')
  expect(file.size).toBeLessThanOrEqual(5 * 1024 * 1024)
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
})

it('treats denied permission as a recoverable cancel without adding an image', async () => {
  const onAdd = vi.fn()
  display.mockRejectedValue(new DOMException('denied', 'NotAllowedError'))
  render(<ScreenCaptureEditor onAdd={onAdd} />)
  await userEvent.click(screen.getByRole('button', { name: '截图并标注' }))
  expect(await screen.findByRole('status')).toHaveTextContent('已取消截图')
  expect(onAdd).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '截图并标注' })).toBeEnabled()
})

it('releases a permission request that resolves after the component is unmounted', async () => {
  let permit!: (stream: MediaStream) => void
  display.mockReturnValue(new Promise(resolve => { permit = resolve }))
  const onAdd = vi.fn()
  const view = render(<ScreenCaptureEditor onAdd={onAdd} />)
  await userEvent.click(screen.getByRole('button', { name: '截图并标注' }))
  view.unmount()
  await act(async () => { permit({ getTracks: () => [{ stop }] } as unknown as MediaStream) })
  expect(stop).toHaveBeenCalledTimes(1)
  expect(onAdd).not.toHaveBeenCalled()
})

it('cancels an annotation without uploading or attaching the screenshot', async () => {
  const onAdd = vi.fn()
  render(<ScreenCaptureEditor onAdd={onAdd} />)
  const dialog = await openEditor()
  await userEvent.click(within(dialog).getByRole('button', { name: '取消截图' }))
  expect(onAdd).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '截图并标注' })).toHaveFocus()
})

it('flattens an opaque mask into the exported canvas before producing the attachment', async () => {
  const onAdd = vi.fn()
  render(<ScreenCaptureEditor onAdd={onAdd} />)
  const dialog = await openEditor()
  await userEvent.click(within(dialog).getByRole('button', { name: '遮挡' }))
  const canvas = within(dialog).getByLabelText(/截图标注画布/) as HTMLCanvasElement
  canvas.setPointerCapture = vi.fn()
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 320, bottom: 240, width: 320, height: 240, toJSON() {} })
  fireEvent.pointerDown(canvas, { button: 0, clientX: 20, clientY: 20, pointerId: 1 })
  fireEvent.pointerUp(canvas, { button: 0, clientX: 80, clientY: 60, pointerId: 1 })
  await userEvent.click(within(dialog).getByRole('button', { name: '添加到反馈' }))
  expect(onAdd).toHaveBeenCalledTimes(1)
  expect(contexts.at(-1)?.fillRect).toHaveBeenCalledWith(40, 40, 120, 80)
  expect(HTMLCanvasElement.prototype.toBlob).toHaveBeenCalledTimes(1)
})

it('rejects screenshots that remain over the server image limit after export attempts', async () => {
  const onAdd = vi.fn()
  vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementation((callback, type) => callback(new Blob([new Uint8Array(5 * 1024 * 1024 + 1)], { type: type || 'image/png' })))
  render(<ScreenCaptureEditor onAdd={onAdd} />)
  const dialog = await openEditor()
  await userEvent.click(within(dialog).getByRole('button', { name: '添加到反馈' }))
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('5 MB')
  expect(onAdd).not.toHaveBeenCalled()
  expect(within(dialog).getByRole('button', { name: '添加到反馈' })).toBeEnabled()
})
