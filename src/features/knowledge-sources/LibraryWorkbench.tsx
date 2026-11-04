import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react'
import { ChevronLeft, ChevronRight, Download, FileText, FolderInput, Search, SlidersHorizontal, X } from 'lucide-react'
import type { KnowledgeSourceSnapshot } from './api'
import { sourceError } from './api'
import { useKnowledgePreference } from './preferences'
import { knowledgeV3Download, knowledgeV3Get, knowledgeV3Post, type LibraryPage, type LibraryPaper, type LibraryQuery, type PaperDetail } from './v3-api'
import PaperReaderPanel from './PaperReaderPanel'
import SmartCollections from './SmartCollections'
import ReadingQueue from './ReadingQueue'
import ResearchTools from './ResearchTools'
import DuplicateReview from './DuplicateReview'
import type { WorkspaceState, ReadingState, ReadingEntry } from './workspace-v3-types'
import './library-workbench.css'

function stored(key:string){try{return localStorage.getItem(key)!==null}catch{return false}}
function newerReading(previous:ReadingEntry|undefined,incoming:ReadingEntry|undefined,version?:string){
  const valid=(entry:ReadingEntry|undefined)=>entry&&(!version||!entry.versionId||entry.versionId===version)
  if(!valid(previous))return valid(incoming)?incoming:undefined
  if(!valid(incoming))return previous
  return previous?.updatedAt&&incoming?.updatedAt&&Date.parse(previous.updatedAt)>Date.parse(incoming.updatedAt)?previous:incoming
}

type Props = {
  data: KnowledgeSourceSnapshot; folder: string; storageKey: string; density: 'compact' | 'standard'; busy: boolean
  onRefresh: () => void; onAdd: () => void; onDensityChange: (value: 'compact' | 'standard') => void
  onOrganize: (ids: string[], folderId: string | string[], move: boolean) => Promise<boolean>
  onCounts: (counts: Record<string, number>) => void; onUndo?: (tokens: string[]) => void
  onStar?: (paperId:string,enabled:boolean)=>Promise<boolean>
  onRetry?: (documentId:string)=>Promise<boolean>
}
export default function LibraryWorkbench({ data, folder, storageKey, density, busy, onRefresh, onAdd, onDensityChange, onOrganize, onCounts, onUndo,onStar,onRetry }: Props) {
  const [query, setQuery] = useKnowledgePreference(`${storageKey}:v3:query:${folder}`, ''), [mode, setMode] = useKnowledgePreference<'all' | 'title'>(`${storageKey}:v3:searchMode`, 'all')
  const [savedPaper, setSavedPaper] = useKnowledgePreference(`${storageKey}:v3:paper:${folder}`, new URLSearchParams(window.location.search).get('paper') || '')
  const [offset, setOffset] = useKnowledgePreference(`${storageKey}:v3:offset:${folder}`, 0), [sort, setSort] = useKnowledgePreference<'recent' | 'title'>(`${storageKey}:v3:sort`, 'recent')
  const [paperType,setPaperType]=useKnowledgePreference(`${storageKey}:v3:type:${folder}`,''),[indexStatus,setIndexStatus]=useKnowledgePreference(`${storageKey}:v3:indexStatus:${folder}`,'')
  const [tags, setTags] = useKnowledgePreference<string[]>(`${storageKey}:v3:tags:${folder}`,[]), [reading, setReading] = useKnowledgePreference(`${storageKey}:v3:reading:${folder}`,''), [collectionId, setCollectionId] = useKnowledgePreference(`${storageKey}:v3:collection:${folder}`,''), [readerOpen, setReaderOpen] = useState(!!savedPaper)
  const [externalPaper, setExternalPaper] = useState<LibraryPaper | null>(null), [jumpOffset, setJumpOffset] = useState<number | undefined>(undefined)
  const [workspace, setWorkspace] = useState<WorkspaceState | null>(null)
  const [page, setPage] = useState<LibraryPage | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState(''), [revision, setRevision] = useState(0)
  const [selected, setSelected] = useState<string[]>([]), [destination, setDestination] = useState(''), [organizing, setOrganizing] = useState(false), [menu, setMenu] = useState<{ x: number; y: number; paper: LibraryPaper } | null>(null)
  const [exporting, setExporting] = useState(false), [format, setFormat] = useState('bibtex'), [filters, setFilters] = useState(false)
  const [bulkTag,setBulkTag]=useState(''),[tagging,setTagging]=useState(false),[recentRange,setRecentRange]=useState('30')
  const searchRef = useRef<HTMLInputElement>(null), listRef = useRef<HTMLDivElement>(null), anchor = useRef(0), scroll = useRef(0), lastPosition = useRef<number | undefined>(undefined), positionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const initialRestore = useRef({folder, queryStored:stored(`${storageKey}:v3:query:${folder}`),offsetStored:stored(`${storageKey}:v3:offset:${folder}`),paperStored:stored(`${storageKey}:v3:paper:${folder}`),scrollStored:stored(`${storageKey}:v3:scroll:${folder}`),explicitPaper:new URLSearchParams(window.location.search).has('paper')})
  const countsCallback = useRef(onCounts); useEffect(() => { countsCallback.current = onCounts }, [onCounts])
  const selectedRef = useRef(selected); useEffect(() => { selectedRef.current = selected }, [selected])
  const workspaceRef=useRef(workspace);useEffect(()=>{workspaceRef.current=workspace},[workspace])
  const localReading=useRef<Record<string,ReadingEntry>>({})
  const readingRequests=useRef<Promise<void>>(Promise.resolve()), mounted=useRef(true)
  const locationTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined), locationDirty=useRef(false), lastScrollWrite=useRef(0), interacted=useRef(false)
  const locationRequests=useRef<Promise<void>>(Promise.resolve()),evidenceRequest=useRef<AbortController|null>(null),activePaper=useRef<LibraryPaper|undefined>(undefined)
  const locationValue=useRef({folderId:folder,query,paperId:savedPaper,offset,scrollTop:0})
  useEffect(()=>{locationValue.current={folderId:folder,query,paperId:savedPaper,offset,scrollTop:scroll.current}},[folder,query,savedPaper,offset])
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false}},[])
  const lastPdfPage=useRef('')
  useEffect(() => {
    const abort = new AbortController()
    void knowledgeV3Get<WorkspaceState>('/workspace', abort.signal).then(value=>{
      if(abort.signal.aborted)return
      const restoredReading={...value.reading}
      for(const [id,entry] of Object.entries(localReading.current)){const merged=newerReading(restoredReading[id],entry);if(merged)restoredReading[id]=merged}
      const next={...value,reading:restoredReading};workspaceRef.current=next;setWorkspace(next)
      const initial=initialRestore.current
      if(!interacted.current&&!initial.explicitPaper&&value.location.folderId===initial.folder){
        if(!initial.scrollStored)scroll.current=Math.max(0,value.location.scrollTop || 0)
        if(!initial.paperStored&&value.location.paperId){setSavedPaper(value.location.paperId);setReaderOpen(true)}
        if(!initial.queryStored&&value.location.query)setQuery(value.location.query)
        if(!initial.offsetStored&&Number.isInteger(value.location.offset)&&value.location.offset!>=0&&value.location.offset!<=1000000)setOffset(value.location.offset!)
        window.requestAnimationFrame(()=>{if(!abort.signal.aborted&&listRef.current)listRef.current.scrollTop=scroll.current})
      }
    }).catch(e => { if (!abort.signal.aborted) setNotice(sourceError(e)) })
    return () => abort.abort()
  }, [setOffset,setQuery,setSavedPaper])
  useEffect(() => {
    const abort = new AbortController()
    const timeout = window.setTimeout(() => {
      if(!Number.isInteger(offset)||offset<0||offset>1000000){setOffset(0);return}
      setLoading(true)
      const input: LibraryQuery = { query, searchMode: mode, folderId: folder, offset, limit: 50, sort, tagIds: tags, readingStatus: reading || undefined, collectionId: collectionId || undefined,type:paperType || undefined,indexStatus:(indexStatus || undefined) as LibraryQuery['indexStatus'] }
      if(folder==='recent')input.savedAfter=recentRange==='today'?new Date(new Date().setHours(0,0,0,0)).toISOString():new Date(Date.now()-Number(recentRange)*86400000).toISOString()
      void knowledgeV3Post<LibraryPage>('/library/query', input, abort.signal).then(result => {
        if (abort.signal.aborted) return
        const updatedPapers=result.papers.map(item=>{const local=localReading.current[item.id] || workspaceRef.current?.reading[item.id];const reading=newerReading(local,item.reading as ReadingEntry|undefined,item.versionId);if(reading)localReading.current[item.id]=reading;return reading?{...item,reading}:item});if(workspaceRef.current){const next={...workspaceRef.current,reading:{...workspaceRef.current.reading,...localReading.current}};workspaceRef.current=next;setWorkspace(next)}setPage({...result,papers:updatedPapers}); setError(''); countsCallback.current(result.folderCounts || {}); setLoading(false)
        if(result.total===0&&offset!==0)setOffset(0)
        else if (result.total > 0 && offset >= result.total) setOffset(Math.max(0, Math.floor((result.total - 1) / 50) * 50))
        window.requestAnimationFrame(() => { if (listRef.current) listRef.current.scrollTop = scroll.current })
      }).catch(e => { if (!abort.signal.aborted) { setError(sourceError(e)); setLoading(false) } })
    }, query ? 250 : 0)
    return () => { abort.abort(); window.clearTimeout(timeout) }
  }, [query, mode, folder, offset, sort, tags, reading, collectionId, revision, setOffset, data.catalogRevision, data.refreshedAt,recentRange,paperType,indexStatus])
  useEffect(() => {
    if (!page?.searchIndex?.indexing) return
    const timer = window.setInterval(() => setRevision(n => n + 1), 5000)
    return () => window.clearInterval(timer)
  }, [page?.searchIndex?.indexing])
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('click', close); window.addEventListener('keydown', close)
    return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', close) }
  }, [menu])
  const rows = page?.papers || [], paper = rows.find(p => p.id === savedPaper) || (externalPaper?.id === savedPaper ? externalPaper : undefined), visibleSelected = rows.filter(p => selected.includes(p.id))
  const pageLoaded=page!==null,pageHasSaved=!!page?.papers.some(item=>item.id===savedPaper)
  useEffect(()=>{activePaper.current=paper},[paper])
  useEffect(()=>{if(!savedPaper||!pageLoaded||pageHasSaved||externalPaper?.id===savedPaper)return;const abort=new AbortController();void knowledgeV3Post<PaperDetail>('/library/detail',{paperId:savedPaper,offset:0,limit:48000},abort.signal).then(value=>{if(!abort.signal.aborted)setExternalPaper(value.paper)}).catch(e=>{if(!abort.signal.aborted)setNotice(sourceError(e))});return()=>abort.abort()},[savedPaper,pageLoaded,pageHasSaved,externalPaper?.id])
  useEffect(()=>{lastPosition.current=undefined;return()=>{if(positionTimer.current)clearTimeout(positionTimer.current)}},[paper?.id,paper?.versionId])
  const refreshed = useCallback(() => { setRevision(n => n + 1); onRefresh() }, [onRefresh])
  const enqueueLocation=useCallback((value:{folderId:string;query:string;paperId:string;offset:number;scrollTop:number})=>{
    locationRequests.current=locationRequests.current.then(async()=>{if(mounted.current)await knowledgeV3Post('/workspace/location',value)}).catch(()=>{})
  },[])
  const persistLocation=useCallback(()=>{
    if(locationTimer.current)clearTimeout(locationTimer.current)
    locationTimer.current=setTimeout(()=>{if(mounted.current&&locationDirty.current){locationDirty.current=false;enqueueLocation({...locationValue.current,scrollTop:scroll.current})}},800)
  },[enqueueLocation])
  function resetPage() { interacted.current=true;locationDirty.current=true;scroll.current = 0;try{localStorage.setItem(`${storageKey}:v3:scroll:${folder}`,'0')}catch{/* Storage is optional. */}setOffset(0);setLoading(true) }
  function choosePaper(p: LibraryPaper|undefined, position?: number) {
    if(!p)return
    interacted.current=true;evidenceRequest.current?.abort()
    setJumpOffset(position ?? (query ? p.matches?.find(match=>match.field!=='note')?.offset : undefined))
    setSavedPaper(p.id); setReaderOpen(true)
    const url = new URL(window.location.href); url.searchParams.set('paper', p.id); url.searchParams.set('folder', folder); window.history.replaceState(null, '', url)
    if(locationTimer.current)clearTimeout(locationTimer.current)
    locationDirty.current=false
    enqueueLocation({folderId:folder,query,paperId:p.id,offset,scrollTop:Math.round(listRef.current?.scrollTop || 0)})
  }
  useEffect(()=>{if(locationDirty.current)persistLocation()},[folder,query,savedPaper,offset,persistLocation])
  useEffect(()=>{try{const value=Number(localStorage.getItem(`${storageKey}:v3:scroll:${folder}`));if(Number.isFinite(value)&&value>0)scroll.current=value}catch{/* Local-only scroll restore is optional. */}return()=>{if(locationTimer.current)clearTimeout(locationTimer.current);evidenceRequest.current?.abort()}},[storageKey,folder])
  async function openEvidence(id: string, position?: number) {
    interacted.current=true;evidenceRequest.current?.abort()
    const row=rows.find(p=>p.id===id)
    if(row){choosePaper(row,position);return}
    const abort=new AbortController();evidenceRequest.current=abort
    try{const detail=await knowledgeV3Post<PaperDetail>('/library/detail',{paperId:id,offset:position || 0,limit:48000},abort.signal);if(!abort.signal.aborted&&mounted.current){setExternalPaper(detail.paper);choosePaper(detail.paper,position)}}catch(e){if(!abort.signal.aborted&&mounted.current)setError(sourceError(e))}
  }
  function pick(p: LibraryPaper, event: MouseEvent<HTMLInputElement>) {
    const index = rows.findIndex(row => row.id === p.id)
    if (event.shiftKey) {
      const range = rows.slice(Math.min(anchor.current, index), Math.max(anchor.current, index) + 1).map(row => row.id)
      setSelected([...new Set([...selectedRef.current, ...range])])
    } else { anchor.current = index; setSelected(selectedRef.current.includes(p.id) ? selectedRef.current.filter(id => id !== p.id) : [...selectedRef.current, p.id]) }
  }
  async function organize(move: boolean) {
    if (!destination || !selected.length) return
    setOrganizing(true); setError('')
    if (await onOrganize(selected, destination, move)) { setSelected([]); setNotice(move ? '已移动所选资料，可撤销整理。' : '已加入目标文件夹，原有分类保留。'); setRevision(n => n + 1) }
    setOrganizing(false)
  }
  async function exportSelection() {
    setExporting(true); setError('')
    try { await knowledgeV3Download('/library/export', { paperIds: selected, format }, `知识源资料.${format === 'bibtex' ? 'bib' : format}`); setNotice('资料包已生成，请查看浏览器下载。') }
    catch (e) { setError(sourceError(e)) } finally { setExporting(false) }
  }
  async function addTags(){
    if(!bulkTag.trim() || !selected.length)return
    setTagging(true);setError('');let saved=0;const failed:string[]=[]
    try{for(let index=0;index<selected.length;index+=20){const result=await knowledgeV3Post<{savedCount:number;results:{paperId:string;saved:boolean;error?:string}[]}>('/library/tags',{paperIds:selected.slice(index,index+20),tags:[bulkTag.trim()],revision:0,mode:'add'});saved+=result.savedCount;failed.push(...result.results.filter(item=>!item.saved).map(item=>item.paperId));const issue=result.results.find(item=>!item.saved);if(issue)setError(issue.error || '部分资料标签尚未保存。')}setNotice(`已为 ${saved} / ${selected.length} 篇添加共享标签。`);setSelected(failed);setRevision(n=>n+1)}catch(e){setError(sourceError(e))}finally{setTagging(false)}
  }
  function savePosition(value: number) {
    if (!paper || Math.abs(value - (lastPosition.current ?? -1000)) < 50) return
    lastPosition.current = value
    if (positionTimer.current) clearTimeout(positionTimer.current)
    positionTimer.current = setTimeout(() => enqueueReadingSave(paper,{offset:value,section:'text'}),800)
  }
  function enqueueReadingSave(target:LibraryPaper,position:NonNullable<ReadingEntry['position']>){
    readingRequests.current=readingRequests.current.then(async()=>{
      if(!mounted.current)return
      const latest=localReading.current[target.id] || workspaceRef.current?.reading[target.id] || target.reading
      try{const entry=await knowledgeV3Post<ReadingEntry>('/workspace/reading',{paperId:target.id,versionId:target.versionId,automatic:true,expectedUpdatedAt:latest?.updatedAt || null,state:latest?.state&&latest.state!=='unread'?latest.state:'reading',position:{...latest?.position,...position}});if(mounted.current)updateReading(target.id,entry)}catch{if(mounted.current){lastPdfPage.current='';setNotice('自动阅读进度尚未同步；较新的阅读状态会保留。')}}
    })
  }
  function updateReading(id:string,entry:ReadingEntry){
    const current=activePaper.current
    if(current?.id===id&&current.versionId&&entry.versionId&&current.versionId!==entry.versionId)return
    const prior=localReading.current[id] || workspaceRef.current?.reading[id]
    if(newerReading(prior,entry)!==entry)return
    localReading.current[id]=entry
    if(workspaceRef.current){workspaceRef.current={...workspaceRef.current,reading:{...workspaceRef.current.reading,[id]:entry}};setWorkspace(workspaceRef.current)}
    setPage(previous=>previous?{...previous,papers:previous.papers.map(item=>item.id===id?{...item,reading:entry}:item)}:previous)
    setExternalPaper(previous=>previous?.id===id?{...previous,reading:entry}:previous)
  }
  function savePdfPosition(value:number){
    if(!paper)return
    const key=`${paper.id}:${paper.versionId || ''}:${value}`
    if(lastPdfPage.current===key)return
    lastPdfPage.current=key
    enqueueReadingSave(paper,{page:value,section:'pdf'})
  }
  useEffect(() => () => { if (positionTimer.current) clearTimeout(positionTimer.current) }, [])
  const tagsCatalog = page?.tags || data.tags || []
  const typeCatalog=[...new Set([paperType,...rows.map(item=>item.type || ''),...data.documents.map(item=>item.documentType || ''),'Guideline','知识库论文'].filter(Boolean))]
  const bulkTagsControl = (data.canEdit || data.canOrganize) && <><input className="kso-select" aria-label="批量添加共享标签" placeholder="添加共享标签…" maxLength={16} value={bulkTag} onChange={e=>setBulkTag(e.target.value)}/><button className="kso-btn" disabled={tagging||!bulkTag.trim()||selected.length>100||selected.some(id=>id.startsWith('archive:'))} onClick={()=>void addTags()}>{tagging?'正在添加…':'添加标签'}</button>{selected.some(id=>id.startsWith('archive:'))&&<small>未注册原件完成入库后可添加共享标签</small>}</>
  return <section className={`ksv-library kso-density-${density}`} aria-label="文献研究工作区" onKeyDown={event => {
    const input = event.target instanceof HTMLElement && !!event.target.closest('input,textarea,select,[contenteditable="true"]')
    if (!input && (event.key === '/' || ((event.ctrlKey || event.metaKey) && event.key === 'f'))) { event.preventDefault(); searchRef.current?.focus() }
    if (event.key === 'Escape') { setMenu(null); setSelected([]) }
    if (!input && (event.key === 'ArrowDown' || event.key === 'ArrowUp') && rows.length) { event.preventDefault(); const index = rows.findIndex(p => p.id === savedPaper); choosePaper(rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]) }
  }}>
    <SmartCollections state={workspace} query={{ text: query,types:paperType?[paperType]:[], readingStates: reading?[reading as ReadingState]:[], folderIds: data.folders.some(f => f.id === folder) ? [folder] : [], tags }} folders={data.folders} canOrganize={data.canOrganize} onChoose={(value, id) => { setCollectionId(id); setQuery(value.text || ''); setReading(''); resetPage() }} onChanged={setWorkspace} onOrganized={result => { if (result.undoTokens) onUndo?.(result.undoTokens); setRevision(n => n + 1); onRefresh() }} />
    <div className="ksv-topline"><div className="kso-actions"><span className="ksv-reading-label">阅读队列</span>{[['', '全部'], ['unread', '待读'], ['reading', '在读'], ['done', '读完'], ['later', '稍后']].map(([value, label]) => <button type="button" key={value} className={`ksv-tab${reading === value ? ' active' : ''}`} aria-pressed={reading === value} onClick={() => { setReading(value); resetPage() }}>{label}</button>)}</div>{folder==='recent'&&<select className="kso-select" aria-label="最近下载时间范围" value={recentRange} onChange={e=>{setRecentRange(e.target.value);resetPage()}}><option value="today">今天</option><option value="7">近7天</option><option value="30">近30天</option></select>}<button className="kso-btn primary" onClick={onAdd}><FolderInput />添加资料</button></div>
    <div className="kso-toolbar"><label className="kso-search"><Search /><input ref={searchRef} aria-label="全文搜索资料" value={query} maxLength={500} onChange={e => { locationDirty.current=true;setQuery(e.target.value); resetPage() }} placeholder="搜索正文、标题、指南编号、标签或笔记…" />{query && <button className="kso-icon-btn" aria-label="清除全文搜索" onClick={() => { setQuery(''); resetPage() }}><X /></button>}</label><select className="kso-select" aria-label="搜索范围" value={mode} onChange={e => { setMode(e.target.value as 'all' | 'title'); resetPage() }}><option value="all">全文与资料信息</option><option value="title">仅标题与编号</option></select><button className="kso-btn" aria-expanded={filters} onClick={() => setFilters(!filters)}><SlidersHorizontal />筛选与排序</button></div>
    {filters && <div className="ksv-filterbar"><label>资料类型<select className="kso-select" aria-label="筛选资料类型" value={paperType} onChange={e=>{setPaperType(e.target.value);resetPage()}}><option value="">全部资料类型</option>{typeCatalog.map(type=><option key={type} value={type}>{type}</option>)}</select></label><label>问答索引<select className="kso-select" aria-label="筛选问答索引状态" value={indexStatus} onChange={e=>{setIndexStatus(e.target.value);resetPage()}}><option value="">全部索引状态</option><option value="ready">可问答</option><option value="failed">索引待重试</option><option value="pending">索引处理中</option><option value="not_requested">未建问答索引</option><option value="unknown">状态待确认</option></select></label><label>排序<select className="kso-select" value={sort} onChange={e => { setSort(e.target.value as 'recent' | 'title'); resetPage() }}><option value="recent">最近收录</option><option value="title">标题</option></select></label><label>密度<select className="kso-select" value={density} onChange={e => onDensityChange(e.target.value as 'compact' | 'standard')}><option value="compact">紧凑</option><option value="standard">标准</option></select></label><label>标签<select className="kso-select" value={tags[0] || ''} onChange={e => { setTags(e.target.value ? [e.target.value] : []); resetPage() }}><option value="">全部标签</option>{tagsCatalog.map(tag => <option key={tag.id} value={tag.id}>{tag.name}</option>)}</select></label><button className="kso-btn quiet" onClick={() => { setQuery(''); setTags([]); setReading(''); setCollectionId('');setPaperType('');setIndexStatus(''); resetPage() }}>重置筛选</button></div>}
    {page?.searchIndex && !page.searchIndex.complete && mode === 'all' && <div className="ksv-index-status" role="status">全文检索覆盖 {page.searchIndex.indexed} / {page.searchIndex.total} 篇{page.searchIndex.indexing ? '，正在建立本地检索索引…' : '；部分资料尚未建立全文索引。'}{page.searchIndex.failed > 0 && ` ${page.searchIndex.failed} 篇待重试。`}<button className="kso-btn quiet" onClick={() => { void knowledgeV3Post('/library/index/refresh', {}).then(() => setRevision(n => n + 1)).catch(e => setError(sourceError(e))) }}>刷新全文索引</button></div>}
    {page?.noteSearchTruncated&&<p className="ksv-index-status">笔记匹配较多，本次最多展示200个文献关联；可增加关键词缩小范围。</p>}
    {error && <div role="alert" className="kso-inline-error">{error}<button className="kso-btn" onClick={() => setRevision(n => n + 1)}>重新加载</button></div>}{notice && <div role="status" className="ksv-notice">{notice}</div>}
    {selected.length > 0 && <div className="kso-bulk"><strong>已选 {selected.length} 篇{selected.length > visibleSelected.length && ` · 其中 ${selected.length - visibleSelected.length} 篇不在本页`}</strong>{data.canOrganize && <><select className="kso-select" aria-label="批量整理目标文件夹" value={destination} onChange={e => setDestination(e.target.value)}><option value="">选择文件夹</option>{data.folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select><button className="kso-btn" disabled={!destination || organizing || busy} onClick={() => void organize(false)}>加入文件夹</button>{data.folders.some(f => f.id === folder) && <button className="kso-btn" disabled={!destination || organizing || busy || destination === folder} onClick={() => void organize(true)}>移动到文件夹</button>}</>}{bulkTagsControl}<select className="kso-select" aria-label="资料导出格式" value={format} onChange={e => setFormat(e.target.value)}><option value="bibtex">BibTeX 引用</option><option value="ris">RIS 引用</option><option value="csv">CSV 清单</option><option value="zip">原件资料包</option></select><button className="kso-btn" disabled={exporting || selected.length > 100} onClick={() => void exportSelection()}><Download />{exporting ? '正在导出…' : '导出所选'}</button><button className="kso-btn quiet" onClick={() => setSelected([])}>取消选择</button></div>}
    {paper && <ReadingQueue key={paper.id} paperId={paper.id} versionId={paper.versionId} reading={workspace?.reading[paper.id] || paper.reading} onChanged={value=>updateReading(paper.id,value)} />}
    <div className={`ksv-reading-layout${paper && readerOpen ? ' has-reader' : ''}`}><div className="ksv-list" ref={listRef} tabIndex={0} aria-label="论文列表" aria-busy={loading} onScroll={e => { interacted.current=true;scroll.current = Math.round(e.currentTarget.scrollTop);locationDirty.current=true;if(Date.now()-lastScrollWrite.current>250){lastScrollWrite.current=Date.now();try{localStorage.setItem(`${storageKey}:v3:scroll:${folder}`,String(scroll.current))}catch{/* Scrolling works without browser storage. */}}persistLocation() }}>
      <div className="ksv-list-heading"><label className="kso-check"><input type="checkbox" aria-label="全选本页论文" checked={rows.length > 0 && rows.every(p => selected.includes(p.id))} onChange={e => setSelected(e.target.checked ? [...new Set([...selected, ...rows.map(p => p.id)])] : selected.filter(id => !rows.some(p => p.id === id)))} />全选本页</label><span>{page?.incomplete ? '当前已检索到' : '共'} {page?.total ?? '…'} 篇</span></div>
      {rows.map((p, index) => <article key={p.id} className={`ksv-paper-row${savedPaper === p.id ? ' is-current' : ''}${selected.includes(p.id) ? ' is-selected' : ''}`} draggable={data.canOrganize} onDragStart={event => { const ids = selected.includes(p.id) ? selected : [p.id]; event.dataTransfer.setData('application/x-knowledge-papers', JSON.stringify(ids)); event.dataTransfer.effectAllowed = 'copyMove' }} onContextMenu={e => { e.preventDefault(); setMenu({ x: Math.min(e.clientX, window.innerWidth - 220), y: Math.min(e.clientY, window.innerHeight - 180), paper: p }) }}>
        <input type="checkbox" aria-label={`选择 ${p.title}`} checked={selected.includes(p.id)} onClick={e => pick(p, e)} onChange={() => { /* Selection is handled on click to retain Shift range semantics. */ }} /><button className="ksv-paper-open" onClick={() => choosePaper(p)}><FileText /><span><strong>{p.title}</strong><small>{[p.code, p.sourceName, p.year, p.reading?.state === 'done' ? '已读完' : p.reading?.state === 'reading' ? '阅读中' : p.reading?.state === 'later' ? '稍后阅读' : null].filter(Boolean).join(' · ')}</small>{p.matches?.slice(0, 2).map((match, n) => <span key={n} className="ksv-match">{match.field === 'note' ? '笔记：' : ''}{match.text}</span>)}{p.tags?.length ? <span className="ksv-row-tags">{p.tags.slice(0, 4).map(tag => <span className="kso-chip" key={tag.id}>{tag.name}</span>)}</span> : null}</span></button><span className={`ksv-save-state${p.indexStatus === 'ready' ? ' ready' : ''}`}>{p.indexStatus === 'ready' ? '可问答' : p.saved ? '原件已保存' : '知识库资料'}</span><span className="ksv-row-index" aria-hidden="true">{offset + index + 1}</span>
      </article>)}
      {!rows.length && !loading && <div className="kso-empty"><Search /><h3>{query ? '暂未找到匹配资料' : '当前条件下没有资料'}</h3><p>{page?.incomplete ? '全文索引尚未覆盖全部资料，可以稍后刷新或先按标题搜索。' : '调整搜索、标签或阅读状态，也可以添加新资料。'}</p><button className="kso-btn" onClick={onAdd}>添加资料</button></div>}{loading && <p className="ksv-reader-message" role="status">正在检索资料…</p>}
    </div>{paper && readerOpen && <PaperReaderPanel key={`${paper.id}:${jumpOffset ?? 'saved'}`} paper={paper} data={data} initialOffset={jumpOffset} query={query} onClose={() => setReaderOpen(false)} onPrevious={() => choosePaper(rows[rows.findIndex(p => p.id === paper.id) - 1])} onNext={() => choosePaper(rows[rows.findIndex(p => p.id === paper.id) + 1])} canPrevious={rows.findIndex(p => p.id === paper.id) > 0} canNext={rows.findIndex(p => p.id === paper.id) >= 0 && rows.findIndex(p => p.id === paper.id) < rows.length - 1} onChanged={refreshed} onPosition={savePosition} onPdfPosition={savePdfPosition} onRetry={onRetry} busy={busy} onStar={onStar} />}</div>
    <footer className="ksv-pagination"><span>{page ? `${Math.min(offset + 1, page.total)}—${Math.min(offset + rows.length, page.total)} / ${page.total}` : '正在加载'} · 每页最多 50 篇</span><div className="kso-actions"><button className="kso-btn" disabled={offset === 0 || loading} onClick={() => { interacted.current=true;locationDirty.current=true;setOffset(Math.max(0, offset - 50)); scroll.current = 0 }}><ChevronLeft />上一页</button><button className="kso-btn" disabled={page?.nextOffset == null || loading || offset >= 1000000} onClick={() => { interacted.current=true;locationDirty.current=true;setOffset(page?.nextOffset || 0); scroll.current = 0 }}>下一页<ChevronRight /></button></div></footer>
    <div className="ksv-research-tools"><ResearchTools paperIds={selected.length ? selected : data.folders.some(f=>f.id===folder) ? [] : paper ? [paper.id] : []} folderId={data.folders.some(f => f.id === folder) ? folder : undefined} folders={data.folders} canOrganize={data.canOrganize} onApplyClassification={async suggestion => { if (!await onOrganize([suggestion.paperId], suggestion.folderIds, false)) throw new Error('分类未保存，请刷新后重试'); setRevision(n => n + 1) }} onOpenEvidence={(id,position)=>void openEvidence(id,position)} /></div>
    <DuplicateReview folders={data.folders} canOrganize={data.canOrganize} onOrganize={onOrganize} onOpen={id=>void openEvidence(id)} />
    {menu && <div className="ksv-context-menu" role="menu" style={{ top: menu.y, left: menu.x }}><button role="menuitem" onClick={() => choosePaper(menu.paper)}>页内阅读</button><button role="menuitem" onClick={() => setSelected(selected.includes(menu.paper.id) ? selected : [...selected, menu.paper.id])}>选择并整理</button><button role="menuitem" onClick={() => { setSelected([menu.paper.id]); setNotice('已选中此资料，请选择导出格式。') }}>导出这篇资料</button></div>}
  </section>
}
