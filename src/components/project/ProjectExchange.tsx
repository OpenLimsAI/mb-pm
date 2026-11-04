import { useEffect, useRef, useState } from 'react'
import { Download, FileSpreadsheet, X } from 'lucide-react'
import { asAPIError } from '../../api/client'
import { projectExchange, type ProjectExcelPreview } from '../../api/projectExchange'
import { Button } from '../ui'

interface Props {
  projectId: string
  canManage: boolean
  onApplied: () => void | Promise<void>
}

const display = (value: string | number | null) => value === null ? '未填写' : String(value)

export function ProjectExchange({ projectId, canManage, onApplied }: Props) {
  const [open, setOpen] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<ProjectExcelPreview | null>(null)
  const [reason, setReason] = useState('')
  const [pending, setPending] = useState<'export' | 'preview' | 'apply' | null>(null)
  const [message, setMessage] = useState('')
  const [page, setPage] = useState(0)
  const controller = useRef<AbortController | null>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const request = useRef(0)
  useEffect(() => {
    if (open) dialog.current?.showModal()
    else dialog.current?.close()
  }, [open])
  useEffect(() => () => { request.current++; controller.current?.abort() }, [])
  if (!canManage) return null
  const close = () => {
    if (pending === 'apply') return
    request.current++
    controller.current?.abort()
    setOpen(false); setPending(null); setFile(null); setPreview(null); setReason(''); setMessage(''); setPage(0)
  }
  const select = (next: File | null) => {
    request.current++; controller.current?.abort()
    setPreview(null); setPending(null); setMessage(''); setPage(0)
    if (next && (!next.name.toLowerCase().endsWith('.xlsx') || next.size > 10 * 1024 * 1024)) {
      setFile(null); setMessage('请选择不超过 10 MiB 的 .xlsx 项目工作簿。'); return
    }
    setFile(next)
  }
  const run = async (kind: 'export' | 'preview' | 'apply') => {
    const id = ++request.current
    controller.current?.abort()
    controller.current = new AbortController()
    setPending(kind); setMessage('')
    try {
      if (kind === 'export') {
        const data = await projectExchange.export(projectId, controller.current.signal)
        if (id !== request.current) return
        const url = URL.createObjectURL(data)
        const anchor = document.createElement('a')
        anchor.href = url; anchor.download = '项目计划与进度.xlsx'; anchor.click()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
        setMessage('项目工作簿已下载。修改后在这里上传预览。')
      } else if (kind === 'preview' && file) {
        const next = await projectExchange.preview(projectId, file, controller.current.signal)
        if (id !== request.current) return
        setPreview(next); setPage(0)
        if (!next.errors.length && !next.changedCount) setMessage('校验通过，没有需要更新的内容。')
      } else if (kind === 'apply' && file && preview?.canApply) {
        const result = await projectExchange.apply(projectId, file, preview.fingerprint, reason.trim())
        if (id !== request.current) return
        setPreview(null); setFile(null)
        try { await onApplied(); setMessage(`已更新 ${result.updatedCount} 项任务，并记录变更原因。`) }
        catch { setMessage(`已保存 ${result.updatedCount} 项任务，页面同步失败，请刷新查看最新数据。`) }
      }
    } catch (error) {
      if (id !== request.current) return
      setMessage(asAPIError(error).detail)
      if (kind === 'apply') setPreview(null)
    } finally { if (id === request.current) setPending(null) }
  }
  return <>
    <Button size="sm" onClick={() => setOpen(true)}><FileSpreadsheet className="w-4 h-4" />Excel 导入导出</Button>
    <dialog ref={dialog} aria-labelledby="project-excel-title" className="w-[90vw] max-w-[1000px] max-h-[90vh] rounded-xl p-0 shadow-2xl backdrop:bg-black/35" onCancel={event => { event.preventDefault(); close() }}>
      <div className="flex items-start justify-between gap-3 border-b p-5 sticky top-0 bg-white z-10">
        <div><h2 id="project-excel-title" className="font-semibold text-lg">项目 Excel 导入导出</h2><p className="text-sm text-ink-500 mt-1">导出当前计划与执行数据，修改后预览差异，再确认更新。</p></div>
        <button type="button" aria-label="关闭项目 Excel" className="p-1 rounded hover:bg-ink-100 disabled:opacity-40" disabled={pending === 'apply'} onClick={close}><X className="w-5 h-5" /></button>
      </div>
      <div className="p-5 space-y-4">
        <div className="flex flex-wrap gap-3 items-center"><Button disabled={!!pending} onClick={() => void run('export')}><Download className="w-4 h-4" />{pending === 'export' ? '正在导出…' : '导出当前项目'}</Button><span className="text-xs text-ink-500">.xlsx · 最多 10 MiB / 10000 项任务</span></div>
        <p className="text-sm bg-brand-50 p-3 rounded">只更新已有任务。删除文件中的行不会删除任务；依赖、团队及项目资料仅供参考。负责人可填团队姓名或账号ID，列可重排，请保留表头与身份列。工时单位为人天，费用单位为万元。</p>
        <label className="block text-sm">上传修改后的项目工作簿<input key={file ? 'selected' : 'empty'} aria-label="项目工作簿" type="file" accept=".xlsx" disabled={pending === 'apply'} className="block w-full mt-2 text-sm" onChange={event => select(event.target.files?.[0] ?? null)} /></label>
        {file && <p className="text-xs text-ink-500">已选择：{file.name}</p>}
        <Button variant="primary" disabled={!file || !!pending} onClick={() => void run('preview')}>{pending === 'preview' ? '正在校验…' : '校验并预览差异'}</Button>
        {preview && <div className="space-y-3">
          <p className="font-medium text-sm">读取 {preview.rowCount} 行 · {preview.changedCount} 项任务有变更 · {preview.errors.length} 处错误</p>
          {preview.errors.length > 0 && <div role="alert" className="max-h-52 overflow-auto rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800"><p className="font-medium mb-2">请修正后重新上传。本次未写入任何修改。</p>{preview.errors.map((error, i) => <p key={i}>{error.row ? `第 ${error.row} 行` : '文件'} · {error.column}：{error.message}</p>)}{preview.errors.length >= preview.errorLimit && <p>最多显示 {preview.errorLimit} 处错误，请先修正这些问题。</p>}</div>}
          {preview.changes.length > 0 && <><div className="max-h-80 overflow-auto border rounded"><table className="w-full text-xs text-left"><thead className="sticky top-0 bg-ink-100"><tr><th className="p-2">行 / 任务</th><th className="p-2">字段</th><th className="p-2">原值</th><th className="p-2">新值</th></tr></thead><tbody>{preview.changes.slice(page * 100, (page + 1) * 100).flatMap(change => change.changes.map((field, i) => <tr key={`${change.taskId}-${i}`} className="border-t align-top"><td className="p-2 max-w-56 break-words">{change.row} · {change.taskName}{change.resubmitAcceptance && <span className="block text-amber-800">变更后需重新提交验收</span>}</td><td className="p-2 whitespace-nowrap">{field.field}</td><td className="p-2 max-w-56 break-words whitespace-pre-wrap">{display(field.before)}</td><td className="p-2 max-w-56 break-words whitespace-pre-wrap text-brand-700">{display(field.after)}</td></tr>))}</tbody></table></div>{preview.changes.length > 100 && <div className="flex gap-3 text-xs items-center"><Button size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</Button><span>第 {page + 1} / {Math.ceil(preview.changes.length / 100)} 页</span><Button size="sm" disabled={(page + 1) * 100 >= preview.changes.length} onClick={() => setPage(page + 1)}>下一页</Button></div>}</>}
          {preview.canApply && <><label className="block text-sm">导入原因<input aria-label="Excel 导入原因" className="input mt-1" maxLength={2000} value={reason} disabled={!!pending} onChange={e => setReason(e.target.value)} placeholder="说明计划或执行数据调整的依据" /></label><Button variant="primary" disabled={!!pending || !reason.trim()} onClick={() => void run('apply')}>{pending === 'apply' ? '正在保存…' : `确认更新 ${preview.changedCount} 项任务`}</Button></>}
        </div>}
        {message && <p role="status" className="text-sm bg-ink-50 rounded p-3">{message}</p>}
      </div>
    </dialog>
  </>
}
