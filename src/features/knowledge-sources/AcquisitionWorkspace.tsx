import { useEffect, useRef, useState } from 'react'
import { Check, FileText, FileUp, X } from 'lucide-react'
import { sourceError, findInboxFolder, type SourceFolder } from './api'
import { LocalFileReadFailure, snapshotLocalPdf } from './upload-file'
import './acquisition-v3.css'

interface UploadReceipt {ruleFiling?:{undoTokens?:string[];error?:string}[];registered?:boolean;indexStatus?:string;textExtracted?:boolean}
interface UploadProgress {name:string;index:number;total:number;confirmed:number;percent:number|null;phase:'reading'|'uploading'|'processing'|'done'|'failed'}
export interface AcquisitionWorkspaceProps {
  folders: SourceFolder[]; initialFolderId?: string; canManage: boolean; onImported?:()=>void; onClose?:()=>void; onUndoTokens?:(tokens:string[])=>void
}

export default function AcquisitionWorkspace({folders,initialFolderId,canManage,onImported,onClose,onUndoTokens}:AcquisitionWorkspaceProps) {
  // Keep the folder from the action that opened this panel, even if the library view changes.
  const [chosenFolderId,setFolderId]=useState(initialFolderId || '')
  const folderId = chosenFolderId || findInboxFolder(folders)?.id || ''
  const targetExists=!!folderId&&folders.some(folder=>folder.id===folderId)
  const [busy,setBusy]=useState(false),[error,setError]=useState('')
  const [files,setFiles]=useState<File[]>([]),[uploadResult,setUploadResult]=useState(''),[uploadReceipts,setUploadReceipts]=useState<(UploadReceipt&{name:string})[]>([]),[dragging,setDragging]=useState(false)
  const [uploadProgress,setUploadProgress]=useState<UploadProgress|null>(null)
  const pending=useRef<AbortController|null>(null)
  const [localReadFailed,setLocalReadFailed]=useState(false)
  useEffect(()=>()=>pending.current?.abort(),[])
  function chooseFiles(values:FileList|File[]|null) {if(!values)return;const chosen=Array.from(values);if(chosen.some(f=>!f.name.toLowerCase().endsWith('.pdf')||f.size>25*1024*1024)){setError('请选择每份不超过 25 MB 的 PDF 文件。');return}setFiles(previous=>[...previous,...chosen].slice(0,10));setError('');setLocalReadFailed(false);setUploadProgress(null)}
  async function upload() {
    if(busy || !files.length || !canManage)return
    if(!targetExists){setError('所选文件夹已不存在，请重新选择。');return}
    setBusy(true);setError('');setUploadResult('');setUploadReceipts([]);setUploadProgress(null);setLocalReadFailed(false)
    const controller=new AbortController();pending.current=controller;let done=0;const batchUndoTokens:string[]=[]
    try{
      const {knowledgeV3Upload}=await import('./v3-api')
      for(const file of files){
        if(controller.signal.aborted)break
        const current=done+1
        setUploadProgress({name:file.name,index:current,total:files.length,confirmed:done,percent:null,phase:'reading'})
        const snapshot=await snapshotLocalPdf(file,controller.signal)
        if(controller.signal.aborted)break
        setUploadProgress({name:file.name,index:current,total:files.length,confirmed:done,percent:null,phase:'uploading'})
        const data=new FormData();data.append('file',snapshot);data.append('folderId',folderId);data.append('parse','false')
        let acceptingProgress=true
        let receipt:UploadReceipt
        try{
          receipt=await knowledgeV3Upload<UploadReceipt>('/upload',data,controller.signal,event=>{
            if(controller.signal.aborted||!acceptingProgress)return
            const total=event.total
            const percent=typeof total==='number'&&Number.isFinite(total)&&total>0&&Number.isFinite(event.loaded)?Math.min(100,Math.max(0,Math.floor(event.loaded/total*100))):null
            setUploadProgress(previous=>previous?.index===current&&previous.phase==='uploading'?{...previous,percent,phase:percent===100?'processing':'uploading'}:previous)
          })
        }finally{acceptingProgress=false}
        setUploadReceipts(previous=>[...previous,{...receipt,name:file.name}])
        const tokens=receipt.ruleFiling?.flatMap(item=>item.undoTokens || []) || [];batchUndoTokens.push(...tokens)
        done++;setUploadResult(`已上传 ${done} / ${files.length} 份`)
        setUploadProgress(previous=>previous?.index===current?{...previous,confirmed:current,percent:100,phase:'done'}:previous)
      }
      if(!controller.signal.aborted)setFiles([])
    }catch(e){
      if(!controller.signal.aborted){const local=e instanceof LocalFileReadFailure;setLocalReadFailed(local);setError(local?e.message:`${sourceError(e)} 已确认保存 ${done} 份，其余文件可重试。`);setUploadProgress(previous=>previous?{...previous,phase:'failed'}:previous)}
      setFiles(previous=>previous.slice(done))
    }finally{if(done>0)onImported?.();if(batchUndoTokens.length)onUndoTokens?.(batchUndoTokens);setBusy(false)}
  }
  const fileSize=(size:number)=>size<1024*1024?`${Math.max(1,Math.round(size/1024))} KB`:`${(size/1024/1024).toFixed(1)} MB`
  return <section className="kso-v3-acquire kso-simple-acquire" aria-label="统一添加资料">
    <div className="kso-v3-heading"><h2>添加资料</h2>{onClose&&<button type="button" className="kso-icon-btn" aria-label="关闭添加资料" disabled={busy} onClick={onClose}><X/></button>}</div>
    {error&&<p role="alert" className="kso-error">{error}</p>}
      <div className={`kso-v3-drop ${dragging?'is-over':''}`} onDragOver={e=>{e.preventDefault();if(!busy&&canManage)setDragging(true)}} onDragLeave={()=>setDragging(false)} onDrop={e=>{e.preventDefault();setDragging(false);if(!busy&&canManage)chooseFiles(e.dataTransfer.files)}}><FileUp size={24}/><div><strong>将 PDF 拖到这里</strong><small>每次最多 10 份 · 每份不超过 25 MB</small></div><label className="kso-btn">选择文件<input type="file" accept="application/pdf,.pdf" multiple disabled={busy||!canManage} onChange={e=>{chooseFiles(e.target.files);e.target.value=''}}/></label></div>
      {files.length>0&&<div className="kso-intake-files" aria-label="待上传文件">{files.map((file,i)=><div key={`${file.name}-${i}`} className="kso-intake-file"><FileText size={17}/><span>{file.name}</span><small>{fileSize(file.size)}</small><button type="button" className="kso-icon-btn" aria-label={`移除 ${file.name}`} disabled={busy} onClick={()=>setFiles(files.filter((_,j)=>j!==i))}><X size={15}/></button></div>)}<small className="kso-intake-total">已选 {files.length} 份 · {fileSize(files.reduce((sum,file)=>sum+file.size,0))}</small></div>}
    {uploadProgress&&<div className="kso-v3-upload-progress" aria-label="PDF 上传状态"><div className="kso-v3-heading"><strong>{uploadProgress.name}</strong><small>{uploadProgress.index} / {uploadProgress.total} 份</small></div>{uploadProgress.phase!=='reading'&&!localReadFailed&&<progress aria-label="当前文件网络上传进度" max={100} value={uploadProgress.percent??undefined}/>}<p role="status">{uploadProgress.phase==='reading'?'正在读取本地文件…':uploadProgress.phase==='uploading'?uploadProgress.percent===null?'正在上传…':`正在上传 · ${uploadProgress.percent}%`:uploadProgress.phase==='processing'?'正在解析并保存…':uploadProgress.phase==='done'?'原件已保存。':localReadFailed?'本地文件未就绪，尚未上传。':'保存结果待确认，请核对后重试。'}</p></div>}
    <div className="kso-v3-submit"><label className="kso-field">保存到<select aria-label="收录目标文件夹" value={folderId} disabled={busy||!canManage} onChange={e=>{setFolderId(e.target.value);setError('')}}>{!folderId&&<option value="" disabled>正在准备待整理文件夹…</option>}{!targetExists&&<option value={folderId} disabled>文件夹已不存在，请重新选择</option>}{folders.map(f=><option key={f.id} value={f.id}>{f.name}</option>)}</select></label><button type="button" className="kso-btn primary" disabled={busy||!canManage||!targetExists||!files.length} onClick={()=>void upload()}><FileUp size={16}/><span>{busy?'处理中…':`上传 ${files.length} 份 PDF`}</span></button></div>
    {!canManage&&<p className="kso-small">当前账号没有添加资料的权限。</p>}
    {uploadResult&&!busy&&<div className="kso-intake-success" role="status"><Check size={16}/>{uploadResult}</div>}{uploadReceipts.length>0&&<details className="kso-intake-receipts"><summary>查看保存结果（{uploadReceipts.length}）</summary>{uploadReceipts.map((receipt,i)=><div key={i}><strong>{receipt.name}</strong><small>{receipt.textExtracted===false?'原件已保存 · 正文待处理':'原件已保存'}{receipt.registered===false?' · 待登记':''}</small></div>)}</details>}
  </section>
}
