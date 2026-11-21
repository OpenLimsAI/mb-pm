import { useEffect, useRef, useState } from 'react'
import { Check, FileText, FileUp, X } from 'lucide-react'
import { sourceError, findInboxFolder, type SourceFolder } from './api'
import { knowledgeV3Upload } from './v3-api'
import { LocalFileReadFailure, snapshotLocalPdf } from './upload-file'
import { summarizeUploadFailure, uploadByteCount, type UploadAttempt, type UploadDiagnostic } from './upload-diagnostics'
import './acquisition-v3.css'

interface UploadReceipt {ruleFiling?:{undoTokens?:string[];error?:string}[];registered?:boolean;indexStatus?:string;textExtracted?:boolean}
interface UploadProgress {name:string;index:number;total:number;confirmed:number;percent:number|null;phase:'reading'|'uploading'|'processing'|'done'|'failed'}
const MAX_FILES = 10
const MAX_FILE_MB = 25
interface UploadSelection {
  files: File[]
  skipped: { name: string; reason: string }[]
}
export interface AcquisitionWorkspaceProps {
  folders: SourceFolder[]; initialFolderId?: string; canManage: boolean; onImported?:()=>void; onClose?:()=>void; onUndoTokens?:(tokens:string[])=>void; onAutoImport?:(folderId?:string)=>void
}

export default function AcquisitionWorkspace({folders,initialFolderId,canManage,onImported,onClose,onUndoTokens,onAutoImport}:AcquisitionWorkspaceProps) {
  // Keep the folder from the action that opened this panel, even if the library view changes.
  const [chosenFolderId,setFolderId]=useState(initialFolderId || '')
  const folderId = chosenFolderId || findInboxFolder(folders)?.id || ''
  const targetExists=!!folderId&&folders.some(folder=>folder.id===folderId)
  const [busy,setBusy]=useState(false),[error,setError]=useState('')
  const [{ files, skipped }, setSelection] = useState<UploadSelection>({ files: [], skipped: [] })
  const [uploadResult,setUploadResult]=useState(''),[uploadReceipts,setUploadReceipts]=useState<(UploadReceipt&{name:string})[]>([]),[dragging,setDragging]=useState(false)
  const [uploadProgress,setUploadProgress]=useState<UploadProgress|null>(null)
  const [uploadDiagnostic, setUploadDiagnostic] = useState<UploadDiagnostic | null>(null)
  const pending=useRef<AbortController|null>(null)
  const [localReadFailed,setLocalReadFailed]=useState(false)
  useEffect(()=>()=>pending.current?.abort(),[])
  function chooseFiles(values: FileList | File[] | null) {
    if (!values?.length) return
    const chosen = Array.from(values)
    setSelection(previous => {
      const next: UploadSelection = { files: [...previous.files], skipped: [] }
      for (const file of chosen) {
        let reason = ''
        if (!file.name.toLowerCase().endsWith('.pdf')) reason = '仅支持 PDF 文件'
        else if (file.size > MAX_FILE_MB * 1024 * 1024) reason = `超过每份 ${MAX_FILE_MB} MB 的限制`
        else if (next.files.length >= MAX_FILES) reason = `本批已满 ${MAX_FILES} 份，可在下一批上传`
        if (reason) next.skipped.push({ name: file.name, reason })
        else next.files.push(file)
      }
      return next
    })
    setError('')
    setLocalReadFailed(false)
    setUploadProgress(null)
    setUploadDiagnostic(null)
  }
  async function upload() {
    if(busy || !files.length || !canManage)return
    if(!targetExists){setError('所选文件夹已不存在，请重新选择。');return}
    setBusy(true);setError('');setUploadResult('');setUploadReceipts([]);setUploadProgress(null);setLocalReadFailed(false);setUploadDiagnostic(null)
    const controller=new AbortController();pending.current=controller;let done=0;const batchUndoTokens:string[]=[]
    let currentAttempt: UploadAttempt | null = null
    let startedAt = 0
    try{
      for(const file of files){
        if(controller.signal.aborted)break
        const current=done+1
        currentAttempt = null
        setUploadProgress({name:file.name,index:current,total:files.length,confirmed:done,percent:null,phase:'reading'})
        const snapshot=await snapshotLocalPdf(file,controller.signal)
        if(controller.signal.aborted)break
        setUploadProgress({name:file.name,index:current,total:files.length,confirmed:done,percent:null,phase:'uploading'})
        const data=new FormData();data.append('file',snapshot);data.append('folderId',folderId);data.append('parse','false')
        const trace = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
        const attempt: UploadAttempt = { trace, stage: 'uploading', loadedBytes: null, totalBytes: null }
        currentAttempt = attempt
        startedAt = performance.now()
        let acceptingProgress=true
        let receipt:UploadReceipt
        try{
          receipt=await knowledgeV3Upload<UploadReceipt>(`/upload?upload_trace=${attempt.trace}`,data,controller.signal,event=>{
            if(controller.signal.aborted||!acceptingProgress)return
            const total=event.total
            const percent=typeof total==='number'&&Number.isFinite(total)&&total>0&&Number.isFinite(event.loaded)?Math.min(100,Math.max(0,Math.floor(event.loaded/total*100))):null
            attempt.loadedBytes = uploadByteCount(event.loaded)
            attempt.totalBytes = uploadByteCount(total)
            if (percent === 100) attempt.stage = 'processing'
            setUploadProgress(previous=>previous?.index===current&&previous.phase==='uploading'?{...previous,percent,phase:percent===100?'processing':'uploading'}:previous)
          })
        }finally{acceptingProgress=false}
        setUploadReceipts(previous=>[...previous,{...receipt,name:file.name}])
        const tokens=receipt.ruleFiling?.flatMap(item=>item.undoTokens || []) || [];batchUndoTokens.push(...tokens)
        done++;setUploadResult(`已上传 ${done} / ${files.length} 份`)
        setUploadProgress(previous=>previous?.index===current?{...previous,confirmed:current,percent:100,phase:'done'}:previous)
      }
      if(!controller.signal.aborted)setSelection(previous => ({ ...previous, files: [] }))
    }catch(e){
      if (!controller.signal.aborted) {
        const local = e instanceof LocalFileReadFailure
        setLocalReadFailed(local)
        setError(local ? e.message : `${sourceError(e)} 已确认保存 ${done} 份，其余文件可重试。`)
        if (!local && currentAttempt) {
          setUploadDiagnostic(summarizeUploadFailure(e, currentAttempt, performance.now() - startedAt))
        }
        setUploadProgress(previous => previous ? { ...previous, phase: 'failed' } : previous)
      }
      setSelection(previous => ({ ...previous, files: previous.files.slice(done) }))
    }finally{if(done>0)onImported?.();if(batchUndoTokens.length)onUndoTokens?.(batchUndoTokens);setBusy(false)}
  }
  const fileSize=(size:number)=>size<1024*1024?`${Math.max(1,Math.round(size/1024))} KB`:`${(size/1024/1024).toFixed(1)} MB`
  return <section className="kso-v3-acquire kso-simple-acquire" aria-label="统一添加资料">
    <div className="kso-v3-heading"><h2>上传 PDF</h2><div className="kso-actions">{onAutoImport&&<button type="button" className="kso-btn quiet" disabled={busy||!canManage||!targetExists} onClick={()=>onAutoImport(chosenFolderId || undefined)}>从文件夹自动导入</button>}{onClose&&<button type="button" className="kso-btn quiet" aria-label="关闭添加资料" disabled={busy} onClick={onClose}>返回</button>}</div></div>
    {error&&<p role="alert" className="kso-error">{error}</p>}
    {uploadDiagnostic && <details className="kso-v3-upload-diagnostic">
      <summary>查看技术摘要</summary>
      <dl>
        <dt>追踪编号</dt><dd>{uploadDiagnostic.trace}</dd>
        <dt>失败阶段</dt><dd>{uploadDiagnostic.stage === 'processing' ? '等待服务器回执' : '上传文件'}</dd>
        <dt>当前文件耗时</dt><dd>{uploadDiagnostic.elapsedSeconds} 秒</dd>
        <dt>错误代码</dt><dd>{uploadDiagnostic.code}</dd>
        <dt>HTTP 状态</dt><dd>{uploadDiagnostic.status ?? '未收到HTTP回执'}</dd>
        <dt>已报告发送字节</dt><dd>{uploadDiagnostic.loadedBytes === null ? '未报告' : `${uploadDiagnostic.loadedBytes} B`}</dd>
        <dt>请求总字节</dt><dd>{uploadDiagnostic.totalBytes === null ? '未报告' : `${uploadDiagnostic.totalBytes} B`}</dd>
      </dl>
      <small>字节进度由浏览器报告。可提供追踪编号，核对服务器是否已处理。</small>
    </details>}
      <div className={`kso-v3-drop ${dragging?'is-over':''}`} onDragOver={e=>{e.preventDefault();if(!busy&&canManage)setDragging(true)}} onDragLeave={()=>setDragging(false)} onDrop={e=>{e.preventDefault();setDragging(false);if(!busy&&canManage)chooseFiles(e.dataTransfer.files)}}><FileUp size={24}/><div><strong>将 PDF 拖到这里</strong><small>每次最多 {MAX_FILES} 份 · 每份不超过 {MAX_FILE_MB} MB</small></div><label className="kso-btn">选择文件<input type="file" accept="application/pdf,.pdf" multiple disabled={busy||!canManage} onChange={e=>{chooseFiles(e.target.files);e.target.value=''}}/></label></div>
      {skipped.length > 0 && <div className="kso-error" role="status">
        <strong>本次有 {skipped.length} 份文件未加入</strong>
        <ul>{skipped.map((file, index) => <li key={index}>{file.name} · {file.reason}</li>)}</ul>
      </div>}
      {files.length>0&&<div className="kso-intake-files" aria-label="待上传文件">{files.map((file,i)=><div key={`${file.name}-${i}`} className="kso-intake-file"><FileText size={17}/><span>{file.name}</span><small>{fileSize(file.size)}</small><button type="button" className="kso-icon-btn" aria-label={`移除 ${file.name}`} disabled={busy} onClick={()=>setSelection(previous => ({ ...previous, files: previous.files.filter((_, index) => index !== i) }))}><X size={15}/></button></div>)}<small className="kso-intake-total">已选 {files.length} 份 · {fileSize(files.reduce((sum,file)=>sum+file.size,0))} · 还可添加 {MAX_FILES - files.length} 份</small></div>}
    {uploadProgress&&<div className="kso-v3-upload-progress" aria-label="PDF 上传状态"><div className="kso-v3-heading"><strong>{uploadProgress.name}</strong><small>{uploadProgress.index} / {uploadProgress.total} 份</small></div>{uploadProgress.phase!=='reading'&&!localReadFailed&&<progress aria-label="当前文件网络上传进度" max={100} value={uploadProgress.percent??undefined}/>}<p role="status">{uploadProgress.phase==='reading'?'正在读取本地文件…':uploadProgress.phase==='uploading'?uploadProgress.percent===null?'正在上传…':`正在上传 · ${uploadProgress.percent}%`:uploadProgress.phase==='processing'?'正在解析并保存…':uploadProgress.phase==='done'?'原件已保存。':localReadFailed?'本地文件未就绪，尚未上传。':'保存结果待确认，请核对后重试。'}</p></div>}
    <div className="kso-v3-submit"><label className="kso-field">保存到<select aria-label="收录目标文件夹" value={folderId} disabled={busy||!canManage} onChange={e=>{setFolderId(e.target.value);setError('')}}>{!folderId&&<option value="" disabled>正在准备待整理文件夹…</option>}{!targetExists&&<option value={folderId} disabled>文件夹已不存在，请重新选择</option>}{folders.map(f=><option key={f.id} value={f.id}>{f.name}</option>)}</select></label><button type="button" className="kso-btn primary" disabled={busy||!canManage||!targetExists||!files.length} onClick={()=>void upload()}><FileUp size={16}/><span>{busy?'处理中…':`上传 ${files.length} 份 PDF`}</span></button></div>
    {!canManage&&<p className="kso-small">当前账号没有添加资料的权限。</p>}
    {uploadResult&&!busy&&<div className="kso-intake-success" role="status"><Check size={16}/>{uploadResult}</div>}{uploadReceipts.length>0&&<details className="kso-intake-receipts"><summary>查看保存结果（{uploadReceipts.length}）</summary>{uploadReceipts.map((receipt,i)=><div key={i}><strong>{receipt.name}</strong><small>{receipt.textExtracted===false?'原件已保存 · 正文待处理':'原件已保存'}{receipt.registered===false?' · 待登记':''}</small></div>)}</details>}
  </section>
}
