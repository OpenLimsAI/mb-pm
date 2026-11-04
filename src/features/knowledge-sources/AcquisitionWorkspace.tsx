import { useEffect, useRef, useState } from 'react'
import { Download, ExternalLink, FileUp, Link2, Search, X } from 'lucide-react'
import { knowledgeV3Get, knowledgeV3Post } from './v3-api'
import { sourceError } from './api'
import './acquisition-v3.css'

interface Template { id: string; name: string; url: string; capabilities: string[]; coverage: string }
interface Found { id: string; title: string; url: string; metadata: {doi?:string;pmid?:string;year?:string;authors?:string[]} }
interface SearchResult { items: Found[]; total: number; truncated: boolean; coverage: string; officialUrl: string; previewToken: string }
interface UploadReceipt {ruleFiling?:{undoTokens?:string[];error?:string}[];registered?:boolean;indexStatus?:string;textExtracted?:boolean}
interface ImportResult { items: {documentId:string;title:string;alreadyImported:boolean}[]; jobs:{jobId:string}[]; errors:{input?:string;error:string}[]; downloadRequested:boolean;indexRequested:boolean }
export interface AcquisitionWorkspaceProps {
  folders: {id:string;name:string}[]; canManage: boolean; onImported?:()=>void; onClose?:()=>void; onUndoTokens?:(tokens:string[])=>void
}

export default function AcquisitionWorkspace({folders,canManage,onImported,onClose,onUndoTokens}:AcquisitionWorkspaceProps) {
  const [mode,setMode]=useState<'links'|'search'|'upload'>('links')
  const [templates,setTemplates]=useState<Template[]>([]),[templateId,setTemplateId]=useState('pubmed')
  const [input,setInput]=useState(''),[query,setQuery]=useState(''),[folderId,setFolderId]=useState('')
  const [download,setDownload]=useState(false),[index,setIndex]=useState(false)
  const [found,setFound]=useState<SearchResult|null>(null),[selected,setSelected]=useState<string[]>([])
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[result,setResult]=useState<ImportResult|null>(null)
  const [files,setFiles]=useState<File[]>([]),[uploadResult,setUploadResult]=useState(''),[uploadReceipts,setUploadReceipts]=useState<(UploadReceipt&{name:string})[]>([]),[dragging,setDragging]=useState(false)
  const pending=useRef<AbortController|null>(null)
  useEffect(()=>{const controller=new AbortController();void knowledgeV3Get<{items:Template[]}>('/templates',controller.signal).then(r=>setTemplates(r.items)).catch(e=>{if(!controller.signal.aborted)setError(sourceError(e))});return()=>{controller.abort();pending.current?.abort()}},[])
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
  function chooseFiles(values:FileList|File[]|null) {if(!values)return;const chosen=Array.from(values);if(chosen.some(f=>!f.name.toLowerCase().endsWith('.pdf')||f.size>25*1024*1024)){setError('请选择每份不超过 25 MB 的 PDF 文件。');return}setFiles(previous=>[...previous,...chosen].slice(0,10));setError('')}
  async function upload() {
    if(busy || !files.length || !canManage)return
    setBusy(true);setError('');setUploadResult('');setUploadReceipts([])
    const controller=new AbortController();pending.current=controller;let done=0;const batchUndoTokens:string[]=[]
    try{const {knowledgeV3Upload}=await import('./v3-api');for(const file of files){const data=new FormData();data.append('file',file);if(folderId)data.append('folderId',folderId);data.append('parse','false');const receipt=await knowledgeV3Upload<UploadReceipt>('/upload',data,controller.signal);setUploadReceipts(previous=>[...previous,{...receipt,name:file.name}]);const tokens=receipt.ruleFiling?.flatMap(item=>item.undoTokens || []) || [];batchUndoTokens.push(...tokens);done++;setUploadResult(`已上传 ${done} / ${files.length} 份`)}setFiles([]);onImported?.()}catch(e){if(!controller.signal.aborted)setError(`已完成 ${done} 份，其余文件可重试。${sourceError(e)}`);setFiles(previous=>previous.slice(done))}finally{if(batchUndoTokens.length)onUndoTokens?.(batchUndoTokens);setBusy(false)}
  }
  const chosenTemplate=templates.find(t=>t.id===templateId)
  const count=mode==='search'?selected.length:input.split(/\r?\n/).filter(s=>s.trim()).length
  return <section className="kso-v3-acquire" aria-label="统一添加资料">
    <div className="kso-v3-heading"><div><h2>添加资料</h2><p>DOI、PMID、公开链接、官方来源或已有 PDF，统一归入知识库文件夹。</p></div>{onClose&&<button type="button" className="kso-icon-btn" aria-label="关闭添加资料" disabled={busy} onClick={onClose}><X/></button>}</div>
    <div className="kso-v3-tabs" role="tablist" aria-label="资料收录方式">{([['links','标识符与链接',Link2],['search','官方来源检索',Search],['upload','上传 PDF',FileUp]] as const).map(([key,label,Icon])=><button key={key} type="button" role="tab" aria-selected={mode===key} className={`kso-btn ${mode===key?'primary':''}`} disabled={busy} onClick={()=>{setMode(key);setError('');setResult(null)}}><Icon size={16}/>{label}</button>)}</div>
    {error&&<p role="alert" className="kso-error">{error}</p>}
    {mode==='links'&&<label className="kso-field">DOI、PMID 或公开 HTTPS 链接<textarea aria-label="待收录的标识符与链接" rows={4} placeholder={'10.1000/your-doi\nPMID: 12345678\nhttps://...'} value={input} disabled={busy||!canManage} onChange={e=>setInput(e.target.value)}/><small>每行一项，每次最多 10 项。DOI / PMID 自动补充官方元数据；普通链接可先收录，再补全资料卡。</small></label>}
    {mode==='search'&&<><div className="kso-v3-search"><label className="kso-field">官方来源<select aria-label="选择官方检索来源" value={templateId} disabled={busy} onChange={e=>{setTemplateId(e.target.value);setFound(null);setSelected([])}}>{templates.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label><form onSubmit={e=>{e.preventDefault();void search()}}><label className="kso-field">检索词<input value={query} disabled={busy} onChange={e=>setQuery(e.target.value)} maxLength={300} placeholder="输入主题或指南关键词" aria-label="官方来源检索词"/></label><button type="submit" className="kso-btn primary" disabled={busy||!query.trim()}><Search size={16}/>{busy?'检索中…':'检索来源'}</button></form></div>{chosenTemplate&&<div className="kso-note"><p>{chosenTemplate.coverage}</p><p>{chosenTemplate.capabilities.join(' · ')} · <a href={chosenTemplate.url} target="_blank" rel="noreferrer">在官网查看<ExternalLink size={12}/></a></p></div>}{found&&<div className="kso-v3-found"><div className="kso-v3-heading"><strong>找到 {found.total} 项{found.truncated?`，本次显示前 ${found.items.length} 项`:''}</strong><label className="kso-check"><input type="checkbox" checked={!!found.items.length&&found.items.every(x=>selected.includes(x.id))} onChange={e=>setSelected(e.target.checked?found.items.map(x=>x.id):[])}/>全选检索结果</label></div>{found.items.map(item=><label key={item.id} className="kso-v3-result"><input type="checkbox" checked={selected.includes(item.id)} onChange={e=>setSelected(e.target.checked?[...selected,item.id]:selected.filter(x=>x!==item.id))}/><span><strong>{item.title}</strong><small>{[item.metadata.year,item.metadata.doi&&`DOI ${item.metadata.doi}`,item.metadata.pmid&&`PMID ${item.metadata.pmid}`].filter(Boolean).join(' · ')||item.url}</small><a href={item.url} target="_blank" rel="noreferrer" onClick={e=>e.stopPropagation()}>原始来源</a></span></label>)}{!found.items.length&&<p>当前目录范围内没有匹配资料，可调整关键词或通过官网检索。</p>}</div>}</>}
    {mode==='upload'&&<div className={`kso-v3-drop ${dragging?'is-over':''}`} onDragOver={e=>{e.preventDefault();if(!busy)setDragging(true)}} onDragLeave={()=>setDragging(false)} onDrop={e=>{e.preventDefault();setDragging(false);if(!busy&&canManage)chooseFiles(e.dataTransfer.files)}}><FileUp/><strong>拖入 PDF 文件</strong><label className="kso-btn">选择文件<input type="file" accept="application/pdf,.pdf" multiple disabled={busy||!canManage} onChange={e=>{chooseFiles(e.target.files);e.target.value=''}}/></label><small>最多 10 份，每份 25 MB；上传后复用知识库原件、解析和标签能力。</small>{files.map((file,i)=><div key={`${file.name}-${i}`} className="kso-v3-heading"><span>{file.name}</span><button type="button" className="kso-btn quiet" disabled={busy} onClick={()=>setFiles(files.filter((_,j)=>j!==i))}>移除</button></div>)}</div>}
    <div className="kso-v3-submit"><label className="kso-field">目标文件夹<select aria-label="收录目标文件夹" value={folderId} disabled={busy||!canManage} onChange={e=>setFolderId(e.target.value)}><option value="">使用收录来源默认文件夹</option>{folders.map(f=><option key={f.id} value={f.id}>{f.name}</option>)}</select></label><div>{mode!=='upload'&&<label className="kso-check"><input type="checkbox" checked={download} disabled={busy||!canManage} onChange={e=>{setDownload(e.target.checked);if(!e.target.checked)setIndex(false)}}/>同时下载可公开获取的原件</label>}{mode!=='upload'&&<label className="kso-check"><input type="checkbox" checked={index} disabled={busy||!canManage||!download} onChange={e=>setIndex(e.target.checked)}/>建立问答索引</label>}{mode==='upload'&&<small>原件先保存，问答索引可在知识库中发起。</small>}</div><button type="button" className="kso-btn primary" disabled={busy||!canManage||(mode==='upload'?!files.length:count===0||mode==='links'&&count>10)} onClick={()=>void(mode==='upload'?upload():save())}><Download size={16}/>{busy?'正在处理…':mode==='upload'?`上传 ${files.length} 份 PDF`:download?`收录并下载 ${count} 项`:`收录 ${count} 项资料`}</button></div>
    {!canManage&&<p className="kso-small">当前账号可检索和查看来源，收录原件需要知识库写入与下载权限。</p>}
    {result&&<div className="kso-note" role="status"><strong>已收录 {result.items.length} 项{result.items.some(x=>x.alreadyImported)&&`，其中 ${result.items.filter(x=>x.alreadyImported).length} 项为已有资料`}</strong><p>{result.jobs.length?`已创建 ${result.jobs.length} 个下载任务，请到下载任务查看实际保存结果。`:'当前只保存资料链接及元数据，未将其标记为已下载。'}</p>{result.errors.map((item,i)=><p key={i} className="kso-error">{item.input&&`${item.input}：`}{item.error}</p>)}</div>}{uploadResult&&<p role="status">{uploadResult}</p>}{uploadReceipts.map((receipt,i)=><div className="kso-note" key={i}><strong>{receipt.name}</strong><p>{receipt.registered===true?'原件已保存 · 知识库已登记':receipt.registered===false?'原件已保存 · 待知识库注册':'原件保存完成 · 登记状态待确认'} · {receipt.indexStatus==='ready'?'已有问答索引':receipt.indexStatus==='pending'?'索引处理中':receipt.indexStatus==='failed'?'索引待重试':'未建立问答索引'}</p>{receipt.textExtracted===false&&<small>正文尚未提取，可在知识库重新解析。</small>}</div>)}
  </section>
}
