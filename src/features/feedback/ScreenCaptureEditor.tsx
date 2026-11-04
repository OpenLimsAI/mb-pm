import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { Camera, X } from 'lucide-react'
import './capture.css'

type Point = { x: number; y: number }
type Tool = 'crop' | 'arrow' | 'rectangle' | 'mask' | 'text'
type Mark = { tool: Tool; start: Point; end: Point; text?: string }
type Props = { onAdd: (file: File) => void; disabled?: boolean }
const limit = 5 * 1024 * 1024
function bounds(mark: Mark) {
  return { x: Math.min(mark.start.x, mark.end.x), y: Math.min(mark.start.y, mark.end.y), width: Math.abs(mark.end.x - mark.start.x), height: Math.abs(mark.end.y - mark.start.y) }
}
function paint(context: CanvasRenderingContext2D, mark: Mark, preview = false) {
  const { x, y, width, height } = bounds(mark)
  const line = Math.max(3, context.canvas.width / 350)
  context.lineWidth = line; context.strokeStyle = '#d62626'; context.fillStyle = '#d62626'
  context.setLineDash([])
  if (mark.tool === 'mask') { context.fillStyle = '#172c35'; context.fillRect(x, y, width, height) }
  if (mark.tool === 'rectangle') context.strokeRect(x, y, width, height)
  if (mark.tool === 'text') { context.font = `bold ${Math.max(22, context.canvas.width / 55)}px sans-serif`; context.fillText(mark.text || '', mark.start.x, mark.start.y) }
  if (mark.tool === 'arrow') {
    const angle = Math.atan2(mark.end.y - mark.start.y, mark.end.x - mark.start.x), head = line * 5
    context.beginPath(); context.moveTo(mark.start.x, mark.start.y); context.lineTo(mark.end.x, mark.end.y)
    context.moveTo(mark.end.x - head * Math.cos(angle - Math.PI / 6), mark.end.y - head * Math.sin(angle - Math.PI / 6))
    context.lineTo(mark.end.x, mark.end.y); context.lineTo(mark.end.x - head * Math.cos(angle + Math.PI / 6), mark.end.y - head * Math.sin(angle + Math.PI / 6)); context.stroke()
  }
  if (mark.tool === 'crop' && preview) {
    context.strokeStyle = '#087c87'; context.setLineDash([line * 3, line * 2]); context.strokeRect(x, y, width, height); context.setLineDash([])
  }
}
function copyCanvas(source: CanvasImageSource, width: number, height: number) {
  const canvas = document.createElement('canvas')
  const scale = Math.min(1, 3000 / Math.max(width, height))
  canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('当前浏览器无法编辑图片，请直接上传截图。')
  context.drawImage(source, 0, 0, canvas.width, canvas.height)
  return canvas
}
function blobFrom(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('图片导出失败，请重试。')), type, quality))
}

export default function ScreenCaptureEditor({ onAdd, disabled }: Props) {
  const [base, setBase] = useState<HTMLCanvasElement | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [tool, setTool] = useState<Tool>('arrow')
  const [text, setText] = useState('')
  const [marks, setMarks] = useState<Mark[]>([])
  const [drag, setDrag] = useState<Mark | null>(null)
  const [crop, setCrop] = useState<Mark | null>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const stream = useRef<MediaStream | null>(null)
  const alive = useRef(true)
  const start = useRef<Point | null>(null)
  useEffect(() => { alive.current = true; return () => { alive.current = false; stream.current?.getTracks().forEach(track => track.stop()) } }, [])
  useEffect(() => {
    if (!base || !dialog.current) return
    if (!dialog.current.open) dialog.current.showModal()
    const previous = document.body.style.overflow; document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previous }
  }, [base])
  useEffect(() => {
    const target = canvas.current
    if (!target || !base) return
    target.width = base.width; target.height = base.height
    const context = target.getContext('2d')
    if (!context) return
    context.drawImage(base, 0, 0); marks.forEach(mark => paint(context, mark))
    if (crop) paint(context, crop, true)
    if (drag) paint(context, drag, true)
  }, [base, marks, drag, crop])
  function close() {
    if (busy) return
    dialog.current?.close(); setBase(null); setMarks([]); setCrop(null); setDrag(null); setText(''); setError('')
    trigger.current?.focus()
  }
  async function capture() {
    if (busy || disabled) return
    setError(''); setBusy(true)
    try {
      if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('此浏览器不支持直接截图，请使用系统截图后粘贴或上传。')
      const media = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
      stream.current = media
      if (!alive.current) return
      const video = document.createElement('video'); video.muted = true; video.srcObject = media
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([video.play(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('截图超时，请重试或上传截图。')), 8000) })])
        if (!video.videoWidth || !video.videoHeight) throw new Error('未能读取画面，请重新选择窗口。')
        const captured = copyCanvas(video, video.videoWidth, video.videoHeight)
        if (alive.current) { setMarks([]); setCrop(null); setBase(captured) }
      } finally { if (timer) clearTimeout(timer); video.pause(); video.srcObject = null }
    } catch (cause) {
      if (alive.current) setError(cause instanceof DOMException && cause.name === 'NotAllowedError' ? '已取消截图。也可以使用系统截图后粘贴或上传。' : cause instanceof Error ? cause.message : '截图失败，请重试。')
    } finally { stream.current?.getTracks().forEach(track => track.stop()); stream.current = null; if (alive.current) setBusy(false) }
  }
  function point(event: PointerEvent<HTMLCanvasElement>): Point {
    const target = event.currentTarget, rect = target.getBoundingClientRect()
    return { x: Math.max(0, Math.min(target.width, (event.clientX - rect.left) * target.width / rect.width)), y: Math.max(0, Math.min(target.height, (event.clientY - rect.top) * target.height / rect.height)) }
  }
  function pointerDown(event: PointerEvent<HTMLCanvasElement>) {
    if (busy || event.button !== 0) return
    event.preventDefault(); const position = point(event)
    if (tool === 'text') { if (text.trim()) setMarks(current => [...current, { tool, start: position, end: position, text: text.trim() }]); return }
    start.current = position; event.currentTarget.setPointerCapture(event.pointerId)
    setDrag({ tool, start: position, end: position })
  }
  function pointerUp(event: PointerEvent<HTMLCanvasElement>) {
    if (!start.current) return
    const mark = { tool, start: start.current, end: point(event) }
    const size = bounds(mark)
    if (tool === 'crop' ? size.width > 3 && size.height > 3 : size.width > 3 || size.height > 3) { if (tool === 'crop') setCrop(mark); else setMarks(current => [...current, mark]) }
    start.current = null; setDrag(null)
  }
  function applyCrop() {
    if (!base || !crop) return
    const region = bounds(crop), source = document.createElement('canvas'); source.width = base.width; source.height = base.height
    const context = source.getContext('2d'); if (!context) return
    context.drawImage(base, 0, 0); marks.forEach(mark => paint(context, mark))
    const result = document.createElement('canvas'); result.width = Math.max(1, Math.round(region.width)); result.height = Math.max(1, Math.round(region.height))
    result.getContext('2d')?.drawImage(source, region.x, region.y, region.width, region.height, 0, 0, result.width, result.height)
    setMarks([]); setCrop(null); setBase(result)
  }
  async function exportImage() {
    if (!base || busy) return
    setBusy(true); setError('')
    try {
      // Export only flattened pixels: no source screenshot or reversible masking metadata.
      const output = document.createElement('canvas'); output.width = base.width; output.height = base.height
      const context = output.getContext('2d'); if (!context) throw new Error('当前浏览器无法导出图片。')
      context.drawImage(base, 0, 0); marks.forEach(mark => paint(context, mark))
      let blob = await blobFrom(output, 'image/png'), extension = 'png'
      if (blob.size > limit) {
        extension = 'jpg'
        for (const quality of [0.9, 0.75, 0.55]) { blob = await blobFrom(output, 'image/jpeg', quality); if (blob.size <= limit) break }
      }
      if (blob.size > limit) throw new Error('图片仍超过 5 MB，请先框选较小区域再添加。')
      if (!alive.current) return
      onAdd(new File([blob], `反馈截图-${Date.now()}.${extension}`, { type: blob.type }))
      dialog.current?.close(); setBase(null); setMarks([]); setCrop(null); trigger.current?.focus()
    } catch (cause) { setError(cause instanceof Error ? cause.message : '图片导出失败。') }
    finally { if (alive.current) setBusy(false) }
  }
  return <>
    <button ref={trigger} type="button" className="feedback-outline-button" disabled={disabled || busy} onClick={() => void capture()}><Camera size={16} />{busy && !base ? '正在截图…' : '截图并标注'}</button>
    {error && !base && <p role="status" className="feedback-field-help">{error}</p>}
    {base && createPortal(<dialog ref={dialog} className="feedback-capture-dialog" aria-labelledby="capture-title" onCancel={event => { event.preventDefault(); close() }} onKeyDown={event => { event.stopPropagation() }}>
      <header><div><h2 id="capture-title">截图标注</h2><p>拖动绘制；遮挡区域会保存为不透明色块。确认后才添加到反馈。</p></div><button type="button" aria-label="取消截图" disabled={busy} onClick={close}><X size={20} /></button></header>
      <div className="feedback-capture-toolbar" role="group" aria-label="标注工具">{([['crop', '框选裁剪'], ['arrow', '箭头'], ['rectangle', '方框'], ['mask', '遮挡'], ['text', '文字']] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={tool === value} disabled={busy} onClick={() => setTool(value)}>{label}</button>)}
        {tool === 'text' && <input aria-label="标注文字" value={text} maxLength={100} onChange={event => setText(event.target.value)} placeholder="输入后点击图片放置" />}
        <button type="button" disabled={busy || !marks.length} onClick={() => setMarks(current => current.slice(0, -1))}>撤销标注</button>
        {crop && <><button type="button" disabled={busy} onClick={applyCrop}>应用裁剪</button><button type="button" onClick={() => setCrop(null)}>取消框选</button></>}
      </div>
      <div className="feedback-capture-stage"><canvas ref={canvas} aria-label="截图标注画布，使用指针拖动绘制" onPointerDown={pointerDown} onPointerMove={event => { if (start.current) setDrag({ tool, start: start.current, end: point(event) }) }} onPointerUp={pointerUp} onPointerCancel={() => { start.current = null; setDrag(null) }} /></div>
      {error && <p role="alert">{error}</p>}
      <footer><span>{crop ? '框选后请先点击“应用裁剪”，再添加图片。' : '也可取消后使用系统截图、粘贴或上传。'}</span><button type="button" disabled={busy} onClick={close}>取消</button><button className="feedback-create" type="button" disabled={busy || !!crop} onClick={() => void exportImage()}>{busy ? '正在处理…' : '添加到反馈'}</button></footer>
    </dialog>, document.body)}
  </>
}
