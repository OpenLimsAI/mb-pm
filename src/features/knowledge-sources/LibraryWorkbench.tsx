import { isInboxFolder } from './api'
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { ChevronLeft, ChevronRight, Download, FileText, FolderInput, Search, SlidersHorizontal, Trash2, X } from 'lucide-react'
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
  onDelete?: (papers: LibraryPaper[], onDeleted: (id: string) => void) => void
  onRemoveFromFolder?: (papers: LibraryPaper[]) => Promise<boolean>
  initialQuery?: string
  onSearchAll?: (query: string) => void
}
export default function LibraryWorkbench({ data, folder, storageKey, density, busy, onRefresh, onAdd, onDensityChange, onOrganize, onCounts, onUndo,onStar,onRetry,onDelete,onRemoveFromFolder, initialQuery, onSearchAll }: Props) {
  const fromFolderSearch = initialQuery !== undefined
  const currentFolder = data.folders.find(item => item.id === folder)
  const canMove = !!currentFolder && currentFolder.writable !== false
  const [query, setQuery] = useKnowledgePreference(`${storageKey}:v3:query:${folder}`, '', initialQuery), [mode, setMode] = useKnowledgePreference<'all' | 'title'>(`${storageKey}:v3:searchMode`, 'all', fromFolderSearch ? 'all' : undefined)
  const [savedPaper, setSavedPaper] = useKnowledgePreference(`${storageKey}:v3:paper:${folder}`, new URLSearchParams(window.location.search).get('paper') || '')
  const [offset, setOffset] = useKnowledgePreference(`${storageKey}:v3:offset:${folder}`, 0, fromFolderSearch ? 0 : undefined), [sort, setSort] = useKnowledgePreference<'recent' | 'title'>(`${storageKey}:v3:sort`, 'recent')
  const emptyFilter = fromFolderSearch ? '' : undefined
  const [paperType,setPaperType]=useKnowledgePreference(`${storageKey}:v3:type:${folder}`,'',emptyFilter),[indexStatus,setIndexStatus]=useKnowledgePreference(`${storageKey}:v3:indexStatus:${folder}`,'',emptyFilter)
  const [tags, setTags] = useKnowledgePreference<string[]>(`${storageKey}:v3:tags:${folder}`,[],fromFolderSearch ? [] : undefined), [reading, setReading] = useKnowledgePreference(`${storageKey}:v3:reading:${folder}`,'',emptyFilter), [collectionId, setCollectionId] = useKnowledgePreference(`${storageKey}:v3:collection:${folder}`,'',emptyFilter), [readerOpen, setReaderOpen] = useState(() => !!new URLSearchParams(window.location.search).get('paper'))
  const [externalPaper, setExternalPaper] = useState<LibraryPaper | null>(null), [jumpOffset, setJumpOffset] = useState<number | undefined>(undefined)
  const [workspace, setWorkspace] = useState<WorkspaceState | null>(null)
  const [page, setPage] = useState<LibraryPage | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState(''), [revision, setRevision] = useState(0)
  const [selectedPapers, setSelectedPapers] = useState<LibraryPaper[]>([])
  const selected = selectedPapers.map(item => item.id)
  const [destination, setDestination] = useState(''), [organizing, setOrganizing] = useState(false)
  const [exporting, setExporting] = useState(false), [format, setFormat] = useState('bibtex'), [filters, setFilters] = useState(false)
  const [toolsOpen,setToolsOpen]=useState(false),[toolsMounted,setToolsMounted]=useState(false)
  const [bulkTag,setBulkTag]=useState(''),[tagging,setTagging]=useState(false),[recentRange,setRecentRange]=useState('30')
  const [bulkMenu, setBulkMenu] = useState<'copy' | 'move' | null>(null)
  const openFolderControl = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null), listRef = useRef<HTMLDivElement>(null), anchor = useRef(0), scroll = useRef(0), lastPosition = useRef<number | undefined>(undefined), positionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const initialRestore = useRef({folder, queryStored:stored(`${storageKey}:v3:query:${folder}`),offsetStored:stored(`${storageKey}:v3:offset:${folder}`),paperStored:stored(`${storageKey}:v3:paper:${folder}`),scrollStored:stored(`${storageKey}:v3:scroll:${folder}`),explicitPaper:new URLSearchParams(window.location.search).has('paper')})
  const countsCallback = useRef(onCounts); useEffect(() => { countsCallback.current = onCounts }, [onCounts])
  const workspaceRef=useRef(workspace);useEffect(()=>{workspaceRef.current=workspace},[workspace])
  const localReading=useRef<Record<string,ReadingEntry>>({})
  const readingRequests=useRef<Promise<void>>(Promise.resolve()), mounted=useRef(true)
  const locationTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined), locationDirty=useRef(fromFolderSearch), lastScrollWrite=useRef(0), interacted=useRef(fromFolderSearch)
  const locationRequests=useRef<Promise<void>>(Promise.resolve()),evidenceRequest=useRef<AbortController|null>(null),activePaper=useRef<LibraryPaper|undefined>(undefined)
  const locationValue=useRef({folderId:folder,query,paperId:savedPaper,offset,scrollTop:0})
  useEffect(()=>{locationValue.current={folderId:folder,query,paperId:savedPaper,offset,scrollTop:scroll.current}},[folder,query,savedPaper,offset])
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false}},[])
  const lastPdfPage=useRef('')
  useEffect(()=>{const explicit=new URLSearchParams(window.location.search).get('paper');if(explicit)setSavedPaper(explicit)},[setSavedPaper])
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
        if(!initial.paperStored&&value.location.paperId){setSavedPaper(value.location.paperId)}
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
    if (!page?.searchIndex?.indexing || loading) return
    const timer = window.setTimeout(() => setRevision(n => n + 1), 5000)
    return () => window.clearTimeout(timer)
  }, [page?.searchIndex?.indexing, loading])
  useEffect(()=>{
    if(!bulkMenu)return
    const outside=(event:Event)=>{if(!openFolderControl.current?.contains(event.target as Node))setBulkMenu(null)}
    document.addEventListener('pointerdown',outside)
    document.addEventListener('focusin',outside)
    return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('focusin',outside)}
  },[bulkMenu])
  function bulkKeyDown(event:KeyboardEvent<HTMLElement>){
    event.stopPropagation()
    if(event.key==='Escape'){
      event.preventDefault();setBulkMenu(null)
      event.currentTarget.querySelector<HTMLButtonElement>('button')?.focus()
    }
  }
  const rows = page?.papers || [], paper = rows.find(p => p.id === savedPaper) || (externalPaper?.id === savedPaper ? externalPaper : undefined), visibleSelected = rows.filter(p => selected.includes(p.id))
  const pageLoaded=page!==null,pageHasSaved=!!page?.papers.some(item=>item.id===savedPaper)
  useEffect(()=>{activePaper.current=paper},[paper])
  useEffect(()=>{if(!readerOpen||!savedPaper||!pageLoaded||pageHasSaved||externalPaper?.id===savedPaper)return;const abort=new AbortController();void knowledgeV3Post<PaperDetail>('/library/detail',{paperId:savedPaper,offset:0,limit:48000},abort.signal).then(value=>{if(!abort.signal.aborted)setExternalPaper(value.paper)}).catch(e=>{if(!abort.signal.aborted)setNotice(sourceError(e))});return()=>abort.abort()},[savedPaper,pageLoaded,pageHasSaved,externalPaper?.id,readerOpen])
  useEffect(()=>{lastPosition.current=undefined;return()=>{if(positionTimer.current)clearTimeout(positionTimer.current)}},[paper?.id,paper?.versionId])
  const refreshed = useCallback(() => { setRevision(n => n + 1); onRefresh() }, [onRefresh])
  const enqueueLocation=useCallback((value:{folderId:string;query:string;paperId:string;offset:number;scrollTop:number})=>{
    locationRequests.current=locationRequests.current.then(async()=>{if(mounted.current)await knowledgeV3Post('/workspace/location',value)}).catch(()=>{})
  },[])
  const persistLocation=useCallback(()=>{
    if(locationTimer.current)clearTimeout(locationTimer.current)
    locationTimer.current=setTimeout(()=>{if(mounted.current&&locationDirty.current){locationDirty.current=false;enqueueLocation({...locationValue.current,scrollTop:scroll.current})}},800)
  },[enqueueLocation])
  function resetPage() { interacted.current=true;locationDirty.current=true;scroll.current = 0;try{localStorage.setItem(`${storageKey}:v3:scroll:${folder}`,'0')}catch{/* Storage is optional. */}setOffset(0) }
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
  useEffect(()=>{if(!fromFolderSearch)try{const value=Number(localStorage.getItem(`${storageKey}:v3:scroll:${folder}`));if(Number.isFinite(value)&&value>0)scroll.current=value}catch{/* Local-only scroll restore is optional. */}return()=>{if(locationTimer.current)clearTimeout(locationTimer.current);evidenceRequest.current?.abort()}},[storageKey,folder,fromFolderSearch])
  async function openEvidence(id: string, position?: number) {
    interacted.current=true;evidenceRequest.current?.abort()
    const row=rows.find(p=>p.id===id)
    if(row){choosePaper(row,position);return}
    const abort=new AbortController();evidenceRequest.current=abort
    try{const detail=await knowledgeV3Post<PaperDetail>('/library/detail',{paperId:id,offset:position || 0,limit:48000},abort.signal);if(!abort.signal.aborted&&mounted.current){setExternalPaper(detail.paper);choosePaper(detail.paper,position)}}catch(e){if(!abort.signal.aborted&&mounted.current)setError(sourceError(e))}
  }
  function selectPapers(papers: LibraryPaper[]) {
    setSelectedPapers(previous => {
      const byId = new Map(previous.map(item => [item.id, item]))
      for (const item of papers) byId.set(item.id, item)
      return [...byId.values()]
    })
    setBulkMenu(null)
  }
  function deselectPapers(ids: string[]) {
    const removed = new Set(ids)
    setSelectedPapers(previous => previous.filter(item => !removed.has(item.id)))
    setBulkMenu(null)
  }
  function pick(p: LibraryPaper, event: MouseEvent<HTMLInputElement>) {
    const index = rows.findIndex(row => row.id === p.id)
    if (event.shiftKey) {
      selectPapers(rows.slice(Math.min(anchor.current, index), Math.max(anchor.current, index) + 1))
    } else {
      anchor.current = index
      if (selected.includes(p.id)) deselectPapers([p.id])
      else selectPapers([p])
    }
  }
  async function organize(move: boolean) {
    if (!destination || !selected.length || organizing || busy || (move && !canMove) || destination === folder) return
    setOrganizing(true); setError('')
    try {
      if (await onOrganize(selected, destination, move)) {
        deselectPapers(selected)
        setNotice(move ? '已移动所选资料。' : '已拷贝到目标文件夹，原有分类保留。')
        setRevision(n => n + 1)
      }
    } finally { setOrganizing(false) }
  }
  async function removeFromFolder() {
    if (!onRemoveFromFolder || !selectedPapers.length || busy || organizing) return
    setBulkMenu(null)
    setOrganizing(true)
    try {
      if (await onRemoveFromFolder(selectedPapers)) {
        deselectPapers(selected)
        setRevision(value => value + 1)
      }
    } finally { setOrganizing(false) }
  }
  function fileDeleted(id: string) {
    deselectPapers([id])
    if (locationValue.current.paperId !== id) return
    evidenceRequest.current?.abort()
    setReaderOpen(false)
    setExternalPaper(null)
    setSavedPaper('')
    const url = new URL(window.location.href)
    if (url.searchParams.get('paper') === id) {
      url.searchParams.delete('paper')
      window.history.replaceState(null, '', url)
    }
  }
  async function exportSelection() {
    if (!selected.length || exporting || selected.length > 100) return
    setExporting(true); setError('')
    try { await knowledgeV3Download('/library/export', { paperIds: selected, format }, `知识源资料.${format === 'bibtex' ? 'bib' : format}`); setNotice('资料包已生成，请查看浏览器下载。') }
    catch (e) { setError(sourceError(e)) } finally { setExporting(false) }
  }
  async function addTags() {
    const tag = bulkTag.trim()
    if (!tag || !selected.length || tagging) return
    setTagging(true); setError('')
    const savedIds: string[] = []
    try {
      for (let index = 0; index < selected.length; index += 20) {
        const chunk = selected.slice(index, index + 20)
        const result = await knowledgeV3Post<{ results: { paperId: string; saved: boolean; error?: string }[] }>(
          '/library/tags', { paperIds: chunk, tags: [tag], revision: 0, mode: 'add' },
        )
        savedIds.push(...result.results.filter(item => item.saved).map(item => item.paperId))
        const issue = result.results.find(item => !item.saved)
        if (issue) setError(issue.error || '部分资料标签尚未保存。')
      }
      setNotice(`已为 ${savedIds.length} / ${selected.length} 篇添加共享标签。`)
    } catch (e) {
      setError(sourceError(e))
    } finally {
      deselectPapers(savedIds)
      if (savedIds.length) setRevision(n => n + 1)
      setTagging(false)
    }
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
  const activeFilters = [
    ...(mode === 'title' ? [{ label: '仅标题与编号', clear: () => setMode('all') }] : []),
    ...(reading ? [{ label: { unread: '待读', reading: '在读', done: '读完', later: '稍后' }[reading] || '阅读状态', clear: () => setReading('') }] : []),
    ...(paperType ? [{ label: paperType, clear: () => setPaperType('') }] : []),
    ...(indexStatus ? [{ label: { ready: '可问答', failed: '索引待重试', pending: '索引处理中', not_requested: '未建问答索引', unknown: '状态待确认' }[indexStatus] || '问答索引', clear: () => setIndexStatus('') }] : []),
    ...tags.map(id => ({ label: tagsCatalog.find(tag => tag.id === id)?.name || id, clear: () => setTags(value => value.filter(tag => tag !== id)) })),
    ...(collectionId ? [{ label: workspace?.collections.find(collection => collection.id === collectionId)?.name || '收藏规则', clear: () => setCollectionId('') }] : []),
    ...(folder === 'recent' && recentRange !== '30' ? [{ label: recentRange === 'today' ? '今天' : '近 7 天', clear: () => setRecentRange('30') }] : []),
  ]
  function clearFilters() {
    activeFilters.forEach(filter => filter.clear())
    resetPage()
  }
  const filtered = !!query.trim() || activeFilters.length > 0
  const canRemove = !!currentFolder && currentFolder.writable !== false && !isInboxFolder(currentFolder) && !!onRemoveFromFolder
  const noSelection = selected.length === 0
  const actionsDisabled = noSelection || busy || organizing || tagging || exporting
  const tagUnavailable = selected.some(id => id.startsWith('archive:'))
  return <section className={`ksv-library ksv-simple-library kso-density-${density}`} aria-label="文献研究工作区" onKeyDown={event => {
    const targetEl = event.target instanceof HTMLElement ? event.target : null
    const input = !!targetEl?.closest('input,textarea,select,[contenteditable="true"]')
    const insideReader = !!targetEl?.closest('.ksv-reader,.ksv-pdf-reader,[role="dialog"]')
    if (!input && !insideReader && (event.key === '/' || ((event.ctrlKey || event.metaKey) && event.key === 'f'))) { event.preventDefault(); searchRef.current?.focus() }
    if (event.key === 'Escape' && !input && !insideReader) { setBulkMenu(null); setSelectedPapers([]) }
    if (!input && !insideReader && (event.key === 'ArrowDown' || event.key === 'ArrowUp') && rows.length) { event.preventDefault(); const index = rows.findIndex(p => p.id === savedPaper); choosePaper(rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]) }
  }}>
    <div className="kso-toolbar ksv-simple-toolbar"><label className="kso-search"><Search /><input ref={searchRef} aria-label="全文搜索资料" value={query} maxLength={500} onChange={e => { locationDirty.current=true;setQuery(e.target.value); resetPage() }} placeholder={currentFolder ? "在此文件夹中搜索" : "搜索资料…"} />{query && <button className="kso-icon-btn" aria-label="清除全文搜索" onClick={() => { setQuery(''); resetPage() }}><X /></button>}</label><button className="kso-btn" aria-expanded={filters} onClick={() => setFilters(!filters)}><SlidersHorizontal />筛选</button>{data.canOrganize && <button className="kso-btn primary" onClick={onAdd}><FolderInput />上传 PDF</button>}</div>
    {filters && <div className="ksv-filterbar"><label>搜索范围<select className="kso-select" aria-label="搜索范围" value={mode} onChange={e => { setMode(e.target.value as 'all' | 'title'); resetPage() }}><option value="all">全文与资料信息</option><option value="title">仅标题与编号</option></select></label><label>阅读状态<select className="kso-select" aria-label="阅读状态" value={reading} onChange={e=>{setReading(e.target.value);resetPage()}}><option value="">全部</option><option value="unread">待读</option><option value="reading">在读</option><option value="done">读完</option><option value="later">稍后</option></select></label>{folder==='recent'&&<label>收录时间<select className="kso-select" aria-label="最近下载时间范围" value={recentRange} onChange={e=>{setRecentRange(e.target.value);resetPage()}}><option value="today">今天</option><option value="7">近 7 天</option><option value="30">近 30 天</option></select></label>}<label>资料类型<select className="kso-select" aria-label="筛选资料类型" value={paperType} onChange={e=>{setPaperType(e.target.value);resetPage()}}><option value="">全部资料类型</option>{typeCatalog.map(type=><option key={type} value={type}>{type}</option>)}</select></label><label>问答索引<select className="kso-select" aria-label="筛选问答索引状态" value={indexStatus} onChange={e=>{setIndexStatus(e.target.value);resetPage()}}><option value="">全部索引状态</option><option value="ready">可问答</option><option value="failed">索引待重试</option><option value="pending">索引处理中</option><option value="not_requested">未建问答索引</option><option value="unknown">状态待确认</option></select></label><label>排序<select className="kso-select" value={sort} onChange={e => { setSort(e.target.value as 'recent' | 'title'); resetPage() }}><option value="recent">最近收录</option><option value="title">标题</option></select></label><label>密度<select className="kso-select" value={density} onChange={e => onDensityChange(e.target.value as 'compact' | 'standard')}><option value="compact">紧凑</option><option value="standard">标准</option></select></label><label>标签<select className="kso-select" value={tags[0] || ''} onChange={e => { setTags(e.target.value ? [e.target.value] : []); resetPage() }}><option value="">全部标签</option>{tagsCatalog.map(tag => <option key={tag.id} value={tag.id}>{tag.name}</option>)}</select></label><button className="kso-btn quiet" disabled={!filtered} onClick={() => { setQuery(''); clearFilters() }}>重置筛选</button></div>}
    {page?.searchIndex && !page.searchIndex.complete && mode === 'all' && <div className="ksv-index-status" role="status">全文检索覆盖 {page.searchIndex.indexed} / {page.searchIndex.total} 篇{page.searchIndex.indexing ? '，正在建立本地检索索引…' : '；部分资料尚未建立全文索引。'}{page.searchIndex.failed > 0 && ` ${page.searchIndex.failed} 篇待重试。`}<button className="kso-btn quiet" onClick={() => { void knowledgeV3Post('/library/index/refresh', {}).then(() => setRevision(n => n + 1)).catch(e => setError(sourceError(e))) }}>刷新全文索引</button></div>}
    {page?.noteSearchTruncated&&<p className="ksv-index-status">笔记匹配较多，本次最多展示200个文献关联；可增加关键词缩小范围。</p>}
    {error && <div role="alert" className="kso-inline-error">{error}<button className="kso-btn" onClick={() => setRevision(n => n + 1)}>重新加载</button></div>}{notice && <div role="status" className="ksv-notice">{notice}</div>}
    {activeFilters.length > 0 && <div className="ksv-active-filters" aria-label="已应用筛选">
      {activeFilters.map(({ label, clear }, index) => <button key={`${index}:${label}`} className="ksv-filter-chip" type="button" aria-label={`清除筛选 ${label}`} onClick={() => { clear(); resetPage() }}>{label}<X size={12} aria-hidden="true" /></button>)}
    </div>}
    <div className={`ksv-selection-toolbar${selected.length ? ' has-selection' : ''}`} aria-label="论文选择与批量操作">
      <label className="kso-check ksv-page-check"><input type="checkbox" aria-label="全选本页论文" checked={rows.length > 0 && rows.every(p => selected.includes(p.id))} onChange={e => { if (e.target.checked) selectPapers(rows); else deselectPapers(rows.map(item => item.id)) }} /><span>全选本页</span></label>
      <span className="ksv-selection-count" role="status" title={selected.length > visibleSelected.length ? `已选 ${selected.length} 篇 · 其中 ${selected.length - visibleSelected.length} 篇不在本页` : undefined}>{selected.length ? `已选 ${selected.length} 篇${selected.length > visibleSelected.length ? ` · 其中 ${selected.length - visibleSelected.length} 篇不在本页` : ''}` : `${page?.incomplete ? '当前已检索到' : '共'} ${page?.total ?? '…'} 篇`}</span>
      <div className="ksv-selection-actions">
        {data.canOrganize && (['copy', 'move'] as const).map(action => {
          const move = action === 'move'
          const opened = bulkMenu === action
          return <div key={action} ref={opened ? openFolderControl : null} className="ksv-bulk-folder" onKeyDown={bulkKeyDown}>
            <button type="button" className="kso-btn" aria-expanded={opened} disabled={actionsDisabled || (move && !canMove)}
              title={move && !canMove ? '进入具体文件夹后可移动' : undefined}
              onClick={() => { setBulkMenu(opened ? null : action); setDestination('') }}>
              {move ? '移动到…' : '拷贝到…'}
            </button>
            {opened && <div>
              <label className="kso-field">目标文件夹
                <select className="kso-select" aria-label="批量整理目标文件夹" value={destination} disabled={organizing || busy} onChange={event => setDestination(event.target.value)}>
                  <option value="">选择文件夹</option>
                  {data.folders.filter(item => !isInboxFolder(item) && item.writable !== false && item.id !== folder).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              </label>
              <button type="button" className="kso-btn primary" disabled={!destination || actionsDisabled} onClick={() => void organize(move)}>
                {move ? '确认移动' : '确认拷贝'}
              </button>
            </div>}
          </div>
        })}
        {data.canOrganize && <>
          <button type="button" className="kso-btn" disabled={actionsDisabled || !canRemove}
            title={canRemove ? '移出当前文件夹，保留知识库文件' : '在可整理的文件夹中使用'} onClick={() => void removeFromFolder()}>
            移出此文件夹
          </button>
          {onDelete && <button type="button" className="kso-btn ksv-delete-action" disabled={actionsDisabled}
            title="从整个知识库删除所选文件，需逐篇确认" onClick={() => {
              setBulkMenu(null)
              onDelete(selectedPapers, fileDeleted)
            }}><Trash2 size={15} aria-hidden="true" />删除</button>}
        </>}
        {(data.canEdit || data.canOrganize) && <div className="ksv-tag-controls">
          <input className="kso-select" aria-label="批量添加共享标签" placeholder="添加共享标签…" maxLength={16}
            disabled={actionsDisabled || tagUnavailable || selected.length > 100} value={bulkTag} onChange={e => setBulkTag(e.target.value)} />
          <button type="button" className="kso-btn" disabled={actionsDisabled || !bulkTag.trim() || selected.length > 100 || tagUnavailable}
            title={tagUnavailable ? '未注册原件完成入库后可添加共享标签' : undefined} onClick={() => void addTags()}>
            {tagging ? '正在添加…' : '添加标签'}
          </button>
        </div>}
        <div className="ksv-export-controls">
          <select className="kso-select" aria-label="资料导出格式" value={format} disabled={actionsDisabled}
            onChange={e => setFormat(e.target.value)}>
            <option value="bibtex">BibTeX 引用</option><option value="ris">RIS 引用</option>
            <option value="csv">CSV 清单</option><option value="zip">原件资料包</option>
          </select>
          <button type="button" className="kso-btn" disabled={actionsDisabled || selected.length > 100}
            title={selected.length > 100 ? '每次最多导出 100 篇资料' : undefined} onClick={() => void exportSelection()}>
            <Download aria-hidden="true" />{exporting ? '正在导出…' : '导出所选'}
          </button>
        </div>
        <button type="button" className="kso-btn quiet ksv-clear-selection" disabled={actionsDisabled}
          onClick={() => { setSelectedPapers([]); setBulkMenu(null) }}>取消选择</button>
      </div>
    </div>
    <div className={`ksv-reading-layout${paper && readerOpen ? ' has-reader' : ''}`}><div className="ksv-list" ref={listRef} tabIndex={0} aria-label="论文列表" aria-busy={loading} onScroll={e => { interacted.current=true;scroll.current = Math.round(e.currentTarget.scrollTop);locationDirty.current=true;if(Date.now()-lastScrollWrite.current>250){lastScrollWrite.current=Date.now();try{localStorage.setItem(`${storageKey}:v3:scroll:${folder}`,String(scroll.current))}catch{/* Scrolling works without browser storage. */}}persistLocation() }}>
      {rows.map(p => <article key={p.id} className={`ksv-paper-row${readerOpen && savedPaper === p.id ? ' is-current' : ''}${selected.includes(p.id) ? ' is-selected' : ''}`} draggable={data.canOrganize} onDragStart={event => { const ids = selected.includes(p.id) ? selected : [p.id]; event.dataTransfer.setData('application/x-knowledge-papers', JSON.stringify(ids)); event.dataTransfer.effectAllowed = 'copyMove' }}>
        <input type="checkbox" aria-label={`选择 ${p.title}`} checked={selected.includes(p.id)} onClick={e => pick(p, e)} onChange={() => { /* Selection is handled on click to retain Shift range semantics. */ }} /><button className="ksv-paper-open" onClick={() => choosePaper(p)}><FileText /><span><strong>{p.title}</strong><small>{[p.code, p.sourceName, p.year, p.tags?.slice(0,2).map(tag=>tag.name).join(' · ')].filter(Boolean).join(' · ') || '资料'}{query && p.matches?.[0] && <span className="ksv-match-inline"> · {p.matches[0].field==='note'?'笔记：':''}{p.matches[0].text}</span>}</small></span></button><span className={`ksv-save-state${p.indexStatus === 'ready' ? ' ready' : ''}${p.indexStatus==='failed'?' failed':''}`}>{p.indexStatus === 'failed' ? '待处理' : p.indexStatus === 'pending' ? '处理中' : p.saved ? '原件已保存' : '知识库资料'}</span>
        <button type="button" className="ksv-text-action ksv-adjust-file" aria-label={`调整文件 ${p.title}`}
          onClick={() => { anchor.current = rows.indexOf(p); selectPapers([p]) }}>调整文件</button>
      </article>)}
      {!rows.length && !loading && !error && <div className="kso-empty">
        <Search />
        <h3>{filtered ? '暂未找到匹配资料' : currentFolder ? '这个文件夹还是空的' : '这里还没有资料'}</h3>
        {filtered ? <>
          {page?.incomplete && <p>全文索引尚未覆盖全部资料。</p>}
          <div className="kso-actions">
            {activeFilters.length > 0 && <button className="kso-btn" onClick={clearFilters}>清除筛选</button>}
            {query.trim() && onSearchAll && folder !== 'all' && <button className="kso-btn primary" onClick={() => onSearchAll(query)}>在全部资料中搜索</button>}
            {query.trim() && <button className="kso-btn quiet" onClick={() => { setQuery(''); resetPage(); searchRef.current?.focus() }}>清除搜索词</button>}
          </div>
        </> : data.canOrganize && <button className="kso-btn primary" onClick={onAdd}>上传 PDF</button>}
      </div>}{loading && <p className="ksv-reader-message" role="status">正在检索资料…</p>}
    </div>{paper && readerOpen && <PaperReaderPanel key={`${paper.id}:${jumpOffset ?? 'saved'}`} paper={paper} data={data} initialOffset={jumpOffset} query={query} onClose={() => setReaderOpen(false)} onPrevious={() => choosePaper(rows[rows.findIndex(p => p.id === paper.id) - 1])} onNext={() => choosePaper(rows[rows.findIndex(p => p.id === paper.id) + 1])} canPrevious={rows.findIndex(p => p.id === paper.id) > 0} canNext={rows.findIndex(p => p.id === paper.id) >= 0 && rows.findIndex(p => p.id === paper.id) < rows.length - 1} onChanged={refreshed} onPosition={savePosition} onPdfPosition={savePdfPosition} onRetry={onRetry} busy={busy} onStar={onStar} />}</div>
    <footer className="ksv-pagination"><span>{page ? `${Math.min(offset + 1, page.total)}—${Math.min(offset + rows.length, page.total)} / ${page.total}` : '正在加载'} · 每页最多 50 篇</span><div className="kso-actions"><button className="kso-btn" disabled={offset === 0 || loading} onClick={() => { interacted.current=true;locationDirty.current=true;setOffset(Math.max(0, offset - 50)); scroll.current = 0 }}><ChevronLeft />上一页</button><button className="kso-btn" disabled={page?.nextOffset == null || loading || offset >= 1000000} onClick={() => { interacted.current=true;locationDirty.current=true;setOffset(page?.nextOffset || 0); scroll.current = 0 }}>下一页<ChevronRight /></button></div></footer>
    <details className="ksv-more-tools" open={toolsOpen} onToggle={event=>{setToolsOpen(event.currentTarget.open);if(event.currentTarget.open)setToolsMounted(true)}}><summary>更多工具<span>收藏规则、阅读状态与研究</span></summary>{toolsMounted&&<div className="ksv-more-tools-content">
      <SmartCollections state={workspace} query={{ text: query,types:paperType?[paperType]:[], readingStates: reading?[reading as ReadingState]:[], folderIds: data.folders.some(f => f.id === folder) ? [folder] : [], tags }} folders={data.folders} canOrganize={data.canOrganize} onChoose={(value, id) => { setCollectionId(id); setQuery(value.text || ''); setReading(''); resetPage() }} onChanged={setWorkspace} onOrganized={result => { if (result.undoTokens) onUndo?.(result.undoTokens); setRevision(n => n + 1); onRefresh() }} />
      {paper && <ReadingQueue key={paper.id} paperId={paper.id} versionId={paper.versionId} reading={workspace?.reading[paper.id] || paper.reading} onChanged={value=>updateReading(paper.id,value)} />}
    <div className="ksv-research-tools"><ResearchTools paperIds={selected.length ? selected : data.folders.some(f=>f.id===folder) ? [] : paper ? [paper.id] : []} folderId={data.folders.some(f => f.id === folder) ? folder : undefined} folders={data.folders} canOrganize={data.canOrganize} onApplyClassification={async suggestion => { if (!await onOrganize([suggestion.paperId], suggestion.folderIds, false)) throw new Error('分类未保存，请刷新后重试'); setRevision(n => n + 1) }} onOpenEvidence={(id,position)=>void openEvidence(id,position)} /></div>
    <DuplicateReview folders={data.folders} canOrganize={data.canOrganize} onOrganize={onOrganize} onOpen={id=>void openEvidence(id)} />
    </div>}</details>
  </section>
}
