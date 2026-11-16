import { useEffect, useRef, useState } from 'react'
import { Check, Download, ExternalLink, FileText, FileUp, Link2, Search, X } from 'lucide-react'
import { knowledgeV3Get, knowledgeV3Post } from './v3-api'
import { sourceError } from './api'
import { LocalFileReadFailure, snapshotLocalPdf } from './upload-file'
import './acquisition-v3.css'

interface Template { id: string; name: string; url: string; capabilities: string[]; coverage: string }
interface Found { id: string; title: string; url: string; metadata: {doi?:string;pmid?:string;year?:string;authors?:string[]} }
interface SearchResult { items: Found[]; total: number; truncated: boolean; coverage: string; officialUrl: string; previewToken: string }
interface UploadReceipt {ruleFiling?:{undoTokens?:string[];error?:string}[];registered?:boolean;indexStatus?:string;textExtracted?:boolean}
interface UploadProgress {name:string;index:number;total:number;confirmed:number;percent:number|null;phase:'reading'|'uploading'|'processing'|'done'|'failed'}
interface ImportResult { items: {documentId:string;title:string;alreadyImported:boolean}[]; jobs:{jobId:string}[]; errors:{input?:string;error:string}[]; downloadRequested:boolean;indexRequested:boolean }
export interface AcquisitionWorkspaceProps {
  folders: {id:string;name:string}[]; canManage: boolean; onImported?:()=>void; onClose?:()=>void; onUndoTokens?:(tokens:string[])=>void
}

export default function AcquisitionWorkspace({folders,canManage,onImported,onClose,onUndoTokens}:AcquisitionWorkspaceProps) {
  const [mode,setMode]=useState<'links'|'search'|'upload'>('upload')
  const [templates,setTemplates]=useState<Template[]>([]),[templateId,setTemplateId]=useState('pubmed')
  const [input,setInput]=useState(''),[query,setQuery]=useState(''),[folderId,setFolderId]=useState('')
  const [download,setDownload]=useState(false),[index,setIndex]=useState(false)
  const [found,setFound]=useState<SearchResult|null>(null),[selected,setSelected]=useState<string[]>([])
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[result,setResult]=useState<ImportResult|null>(null)
  const [files,setFiles]=useState<File[]>([]),[uploadResult,setUploadResult]=useState(''),[uploadReceipts,setUploadReceipts]=useState<(UploadReceipt&{name:string})[]>([]),[dragging,setDragging]=useState(false)
  const [uploadProgress,setUploadProgress]=useState<UploadProgress|null>(null)
  const pending=useRef<AbortController|null>(null)
  const [localReadFailed,setLocalReadFailed]=useState(false)
  useEffect(()=>()=>pending.current?.abort(),[])
  useEffect(()=>{
    if(mode!=='search'||templates.length)return
    const controller=new AbortController()
    void knowledgeV3Get<{items:Template[]}>('/templates',controller.signal).then(r=>setTemplates(r.items)).catch(e=>{if(!controller.signal.aborted)setError(sourceError(e))})
    return()=>controller.abort()
  },[mode,templates.length])
  async function search() {
    if(busy || !query.trim())return
    setBusy(true);setError('');setResult(null)
    const controller=new AbortController();pending.current=controller
    try{const r=await knowledgeV3Post<SearchResult>('/acquisition/search',{templateId,query:query.trim(),limit:30},controller.signal);setFound(r);setSelected([])}catch(e){if(!controller.signal.aborted)setError(sourceError(e))}finally{setBusy(false)}
  }
  async function save() {
    if(busy || !canManage)return
    setBusy(true);setError('');setResult(null)
    const controller=new AbortController();pending.current=controller
    try{const body=mode==='search'?{previewToken:found?.previewToken,documentIds:selected}:{items:input.split(/\r?\n/).map(s=>s.trim()).filter(Boolean).map(value=>({input:value}))};const r=await knowledgeV3Post<ImportResult>('/acquisition/import',{...body,folderId:folderId||null,download,parse:download&&index},controller.signal);setResult(r);if(r.items.length){onImported?.();if(!r.errors.length){setInput('');setSelected([])}}}catch(e){if(!controller.signal.aborted)setError(sourceError(e))}finally{setBusy(false)}
  }
  function chooseFiles(values:FileList|File[]|null) {if(!values)return;const chosen=Array.from(values);if(chosen.some(f=>!f.name.toLowerCase().endsWith('.pdf')||f.size>25*1024*1024)){setError('请选择每份不超过 25 MB 的 PDF 文件。');return}setFiles(previous=>[...previous,...chosen].slice(0,10));setError('');setLocalReadFailed(false);setUploadProgress(null)}
  async function upload() {
    if(busy || !files.length || !canManage)return
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
        const data=new FormData();data.append('file',snapshot);if(folderId)data.append('folderId',folderId);data.append('parse','false')
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
  const chosenTemplate=templates.find(t=>t.id===templateId)
  const count=mode==='search'?selected.length:input.split(/\r?\n/).filter(s=>s.trim()).length
  const fileSize=(size:number)=>size<1024*1024?`${Math.max(1,Math.round(size/1024))} KB`:`${(size/1024/1024).toFixed(1)} MB`
  return <section className="kso-v3-acquire kso-simple-acquire" aria-label="统一添加资料">
    <div className="kso-v3-heading"><h2>添加资料</h2>{onClose&&<button type="button" className="kso-icon-btn" aria-label="关闭添加资料" disabled={busy} onClick={onClose}><X/></button>}</div>
    <div className="kso-v3-tabs kso-intake-tabs" role="tablist" aria-label="资料收录方式">{([['upload','上传 PDF',FileUp],['search','官方来源检索',Search],['links','标识符与链接',Link2]] as const).map(([key,label,Icon])=><button key={key} type="button" role="tab" aria-selected={mode===key} className={`kso-btn ${mode===key?'primary':''}`} disabled={busy} onClick={()=>{setMode(key);setError('');setResult(null)}}><Icon size={16}/>{label}</button>)}</div>
    {error&&<p role="alert" className="kso-error">{error}</p>}
    {mode==='links'&&<label className="kso-field">粘贴 DOI、PMID 或网址<textarea aria-label="待收录的标识符与链接" rows={3} placeholder={'10.1000/your-doi\nPMID: 12345678\nhttps://...'} value={input} disabled={busy||!canManage} onChange={e=>setInput(e.target.value)}/><small>每行一项，最多 10 项。</small></label>}
    {mode==='search'&&<><div className="kso-v3-search"><label className="kso-field">官方来源<select aria-label="选择官方检索来源" value={templateId} disabled={busy} onChange={e=>{setTemplateId(e.target.value);setFound(null);setSelected([])}}>{templates.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label><form onSubmit={e=>{e.preventDefault();void search()}}><label className="kso-field">检索词<input value={query} disabled={busy} onChange={e=>setQuery(e.target.value)} maxLength={300} placeholder="输入主题或指南关键词" aria-label="官方来源检索词"/></label><button type="submit" className="kso-btn" disabled={busy||!query.trim()}><Search size={16}/>{busy?'检索中…':'查找'}</button></form></div>{chosenTemplate&&<small className="kso-intake-coverage">{chosenTemplate.coverage} <a href={chosenTemplate.url} target="_blank" rel="noreferrer">来源网站<ExternalLink size={12}/></a></small>}{found&&<div className="kso-v3-found"><div className="kso-v3-heading"><strong>找到 {found.total} 项{found.truncated?`，本次显示前 ${found.items.length} 项`:''}</strong><label className="kso-check"><input type="checkbox" checked={!!found.items.length&&found.items.every(x=>selected.includes(x.id))} onChange={e=>setSelected(e.target.checked?found.items.map(x=>x.id):[])}/>全选检索结果</label></div>{found.items.map(item=><label key={item.id} className="kso-v3-result"><input type="checkbox" checked={selected.includes(item.id)} onChange={e=>setSelected(e.target.checked?[...selected,item.id]:selected.filter(x=>x!==item.id))}/><span><strong>{item.title}</strong><small>{[item.metadata.year,item.metadata.doi&&`DOI ${item.metadata.doi}`,item.metadata.pmid&&`PMID ${item.metadata.pmid}`].filter(Boolean).join(' · ')||item.url}</small><a href={item.url} target="_blank" rel="noreferrer" onClick={e=>e.stopPropagation()}>原始来源</a></span></label>)}{!found.items.length&&<p>当前目录范围内没有匹配资料，可调整关键词或通过官网检索。</p>}</div>}</>}
    {mode==='upload'&&<>
      <div className={`kso-v3-drop ${dragging?'is-over':''}`} onDragOver={e=>{e.preventDefault();if(!busy&&canManage)setDragging(true)}} onDragLeave={()=>setDragging(false)} onDrop={e=>{e.preventDefault();setDragging(false);if(!busy&&canManage)chooseFiles(e.dataTransfer.files)}}><FileUp size={24}/><div><strong>将 PDF 拖到这里</strong><small>每次最多 10 份 · 每份不超过 25 MB</small></div><label className="kso-btn">选择文件<input type="file" accept="application/pdf,.pdf" multiple disabled={busy||!canManage} onChange={e=>{chooseFiles(e.target.files);e.target.value=''}}/></label></div>
      {files.length>0&&<div className="kso-intake-files" aria-label="待上传文件">{files.map((file,i)=><div key={`${file.name}-${i}`} className="kso-intake-file"><FileText size={17}/><span>{file.name}</span><small>{fileSize(file.size)}</small><button type="button" className="kso-icon-btn" aria-label={`移除 ${file.name}`} disabled={busy} onClick={()=>setFiles(files.filter((_,j)=>j!==i))}><X size={15}/></button></div>)}<small className="kso-intake-total">已选 {files.length} 份 · {fileSize(files.reduce((sum,file)=>sum+file.size,0))}</small></div>}
    </>}
    {mode==='upload'&&uploadProgress&&<div className="kso-v3-upload-progress" aria-label="PDF 上传状态"><div className="kso-v3-heading"><strong>{uploadProgress.name}</strong><small>{uploadProgress.index} / {uploadProgress.total} 份</small></div>{uploadProgress.phase!=='reading'&&!localReadFailed&&<progress aria-label="当前文件网络上传进度" max={100} value={uploadProgress.percent??undefined}/>}<p role="status">{uploadProgress.phase==='reading'?'正在读取本地文件…':uploadProgress.phase==='uploading'?uploadProgress.percent===null?'正在上传…':`正在上传 · ${uploadProgress.percent}%`:uploadProgress.phase==='processing'?'正在解析并保存…':uploadProgress.phase==='done'?'原件已保存。':localReadFailed?'本地文件未就绪，尚未上传。':'保存结果待确认，请核对后重试。'}</p></div>}
    <div className="kso-v3-submit"><label className="kso-field">保存到<select aria-label="收录目标文件夹" value={folderId} disabled={busy||!canManage} onChange={e=>setFolderId(e.target.value)}><option value="">默认文件夹</option>{folders.map(f=><option key={f.id} value={f.id}>{f.name}</option>)}</select></label>{mode!=='upload'&&<details className="kso-intake-options"><summary>{index?'同时下载 · 建立索引':download?'同时下载原件':'更多选项'}</summary><label className="kso-check"><input type="checkbox" checked={download} disabled={busy||!canManage} onChange={e=>{setDownload(e.target.checked);if(!e.target.checked)setIndex(false)}}/>同时下载可公开获取的原件</label><label className="kso-check"><input type="checkbox" checked={index} disabled={busy||!canManage||!download} onChange={e=>setIndex(e.target.checked)}/>建立问答索引</label></details>}<button type="button" className="kso-btn primary" disabled={busy||!canManage||(mode==='upload'?!files.length:count===0||mode==='links'&&count>10)} onClick={()=>void(mode==='upload'?upload():save())}>{mode==='upload'?<FileUp size={16}/>:<Download size={16}/>}<span>{busy?'处理中…':mode==='upload'?`上传 ${files.length} 份 PDF`:download?`收录并下载 ${count} 项`:`收录 ${count} 项资料`}</span></button></div>
    {!canManage&&<p className="kso-small">当前账号没有添加资料的权限。</p>}
    {result&&<div className="kso-note" role="status"><strong>已收录 {result.items.length} 项{result.items.some(x=>x.alreadyImported)&&`，其中 ${result.items.filter(x=>x.alreadyImported).length} 项为已有资料`}</strong><p>{result.jobs.length?`已创建 ${result.jobs.length} 个下载任务，可在下载记录查看进度。`:'已保存链接与资料信息。'}</p>{result.errors.map((item,i)=><p key={i} className="kso-error">{item.input&&`${item.input}：`}{item.error}</p>)}</div>}{uploadResult&&!busy&&<div className="kso-intake-success" role="status"><Check size={16}/>{uploadResult}</div>}{uploadReceipts.length>0&&<details className="kso-intake-receipts"><summary>查看保存结果（{uploadReceipts.length}）</summary>{uploadReceipts.map((receipt,i)=><div key={i}><strong>{receipt.name}</strong><small>{receipt.textExtracted===false?'原件已保存 · 正文待处理':'原件已保存'}{receipt.registered===false?' · 待登记':''}</small></div>)}</details>}
  </section>
}
