import { useMemo, useRef, useState } from 'react'
import { Pin, ChevronDown, Check, ChevronRight, Folder, FolderDown, FolderPlus, Pencil, Search, X } from 'lucide-react'
import type { SourceFolder, SourcePaper } from './api'
import './knowledge-folders.css'
import { useKnowledgePreference } from './preferences'

interface KnowledgeFoldersProps {
  storageKey?: string
  folders: SourceFolder[]
  papers: SourcePaper[]
  sourceFolderIds: string[]
  selectedIds: string[]
  canOrganize: boolean
  busy: boolean
  onOpen: (id: string) => void
  onCreate: () => void
  onRename: (id: string) => void
  onAssign: (id: string) => void
}

type FolderKind = 'all' | 'topic' | 'source'

export default function KnowledgeFolders({ storageKey = 'kso:folders', folders, papers, sourceFolderIds, selectedIds, canOrganize, busy, onOpen, onCreate, onRename, onAssign }: KnowledgeFoldersProps) {
  const [collapsed,setCollapsed]=useKnowledgePreference(`${storageKey}:folders-collapsed`,false)
  const [pins,setPins]=useKnowledgePreference<string[]>(`${storageKey}:folder-pins`,[])
  const [sort,setSort]=useKnowledgePreference(`${storageKey}:folder-sort`,'name')
  const [search, setSearch] = useState('')
  const [kind, setKind] = useState<FolderKind>('all')
  const searchInput = useRef<HTMLInputElement>(null)
  const sourceIds = useMemo(() => new Set(sourceFolderIds), [sourceFolderIds])
  const selectedPapers = useMemo(() => {
    const ids = new Set(selectedIds)
    const seen = new Set<string>()
    return papers.filter(paper => {
      if (!ids.has(paper.id) || seen.has(paper.id)) return false
      seen.add(paper.id)
      return true
    })
  }, [papers, selectedIds])
  const counts = useMemo(() => {
    const sets=new Map(folders.map(f=>[f.id,new Set<string>()]))
    for(const paper of papers) for(const id of paper.folderIds) sets.get(id)?.add(paper.documentId || paper.id)
    return new Map([...sets].map(([id,entries])=>[id,entries.size]))
  }, [folders,papers])
  const sourceCount = folders.filter(folder => sourceIds.has(folder.id)).length
  const query = search.trim().toLocaleLowerCase()
  const visibleFolders = folders.filter(folder =>
    (!query || folder.name.toLocaleLowerCase().includes(query)) &&
    (kind === 'all' || (kind === 'source' ? sourceIds.has(folder.id) : !sourceIds.has(folder.id))),
  )
  visibleFolders.sort((a,b)=>Number(pins.includes(b.id))-Number(pins.includes(a.id)) || (sort==='count' ? (counts.get(b.id)||0)-(counts.get(a.id)||0) : a.name.localeCompare(b.name)))
  const pathOf=(id:string):string=>{const seen=new Set<string>();const names:string[]=[];let item=folders.find(f=>f.id===id);while(item&&!seen.has(item.id)){seen.add(item.id);names.unshift(item.name);item=folders.find(f=>f.id===item?.parentId)}return names.join(' / ')}
  const filters: { id: FolderKind; label: string; count: number }[] = [
    { id: 'all', label: '全部', count: folders.length },
    { id: 'topic', label: '主题分类', count: folders.length - sourceCount },
    { id: 'source', label: '来源归档', count: sourceCount },
  ]
  const resetFilters = () => { setSearch(''); setKind('all'); searchInput.current?.focus() }

  return <section className="kso-folder-manager-panel" aria-labelledby="kso-folder-manager-heading">
    <div className="kso-folder-manager-heading">
      <div>
        <h2 id="kso-folder-manager-heading"><Folder size={19} aria-hidden="true" />论文文件夹<span className="kso-folder-manager-total">{folders.length} 个</span></h2>
        <p>按主题整理论文，或查看来源下载的默认归档。</p>
      </div>
      <button className="kso-btn quiet" aria-expanded={!collapsed} onClick={()=>setCollapsed(!collapsed)}><ChevronDown size={15}/>{collapsed?'展开文件夹':'收起文件夹'}</button>{canOrganize && <button type="button" className="kso-folder-manager-create" disabled={busy} onClick={onCreate}><FolderPlus size={16} aria-hidden="true" />新建文件夹</button>}
    </div>

    {!collapsed && <><div className="kso-folder-manager-tools">
      <div className="kso-folder-manager-search"><Search size={16} aria-hidden="true" /><input ref={searchInput} type="search" aria-label="搜索文件夹" placeholder="搜索文件夹名称…" value={search} onChange={event => setSearch(event.target.value)} />{search && <button type="button" aria-label="清除文件夹搜索" onClick={() => { setSearch(''); searchInput.current?.focus() }}><X size={14} aria-hidden="true" /></button>}</div>
      <div className="kso-folder-manager-filters" role="group" aria-label="文件夹类型">{filters.map(filter => <button type="button" key={filter.id} aria-pressed={kind === filter.id} onClick={() => setKind(filter.id)}>{filter.label}<span>{filter.count}</span></button>)}</div>
<select className="kso-select" aria-label="文件夹排序" value={sort} onChange={e=>setSort(e.target.value)}><option value="name">按名称</option><option value="count">按论文数量</option></select></div>

    {canOrganize && selectedPapers.length > 0 && <div className="kso-folder-manager-selection" role="status"><FolderPlus size={16} aria-hidden="true" /><span>已选 <strong>{selectedPapers.length}</strong> 篇论文，选择下方目标文件夹即可放入，保留已有分类。</span></div>}

    {visibleFolders.length > 0 ? <div className="kso-folder-manager-grid" role="list" aria-label={`论文文件夹列表，共 ${visibleFolders.length} 个`}>
      {visibleFolders.map(folder => {
        const fromSource = sourceIds.has(folder.id)
        const count = counts.get(folder.id) || 0
        const writable = canOrganize && folder.writable !== false
        const alreadyAssigned = selectedPapers.length > 0 && selectedPapers.every(paper => paper.folderIds.includes(folder.id))
        const FolderIcon = fromSource ? FolderDown : Folder
        return <article className={`kso-folder-manager-card${fromSource ? ' kso-folder-manager-card-source' : ''}`} role="listitem" key={folder.id} aria-label={`文件夹 ${folder.name}`}>
          <button type="button" className="kso-folder-manager-open" aria-label={`打开文件夹 ${folder.name}，${count} 篇论文`} onClick={() => onOpen(folder.id)}>
            <span className="kso-folder-manager-identity"><span className="kso-folder-manager-icon"><FolderIcon size={24} aria-hidden="true" /></span><span className="kso-folder-manager-copy"><strong className="kso-folder-manager-name" title={pathOf(folder.id)}>{pathOf(folder.id)}</strong><span className="kso-folder-manager-kind">{fromSource ? '来源归档' : '主题分类'}</span></span></span>
            <span className="kso-folder-manager-count"><span><b>{count}</b> 篇论文</span><span className="kso-folder-manager-enter">打开<ChevronRight size={15} aria-hidden="true" /></span></span>
            <span className={`kso-folder-manager-hint${count === 0 ? ' kso-folder-manager-hint-empty' : ''}`}>{count === 0 ? '空文件夹 · 选中论文后可放入' : fromSource ? '来源下载后归入这里，再按主题整理' : '浏览此分类中的论文与原件'}</span>
          </button>
          <button type="button" className="kso-folder-pin" aria-label={`${pins.includes(folder.id)?'取消置顶':'置顶'}文件夹 ${folder.name}`} aria-pressed={pins.includes(folder.id)} onClick={()=>setPins(pins.includes(folder.id)?pins.filter(id=>id!==folder.id):[...pins,folder.id])}><Pin size={14}/></button>{writable && <button type="button" className="kso-folder-manager-rename" aria-label={`重命名文件夹 ${folder.name}`} title="重命名文件夹" disabled={busy} onClick={() => onRename(folder.id)}><Pencil size={15} aria-hidden="true" /></button>}
          {writable && selectedPapers.length > 0 && <div className="kso-folder-manager-assign-area"><button type="button" className={`kso-folder-manager-assign${alreadyAssigned ? ' kso-folder-manager-assigned' : ''}`} disabled={busy || alreadyAssigned} aria-label={alreadyAssigned ? `所选论文已全部在 ${folder.name}` : `将选中的 ${selectedPapers.length} 篇论文放入 ${folder.name}`} onClick={() => onAssign(folder.id)}>{alreadyAssigned ? <Check size={15} aria-hidden="true" /> : <FolderPlus size={15} aria-hidden="true" />}{busy ? '处理中…' : alreadyAssigned ? '所选论文已全部归入' : '放入此文件夹'}</button></div>}
        </article>
      })}
    </div> : <div className="kso-folder-manager-empty">
      <Folder size={27} aria-hidden="true" />
      <h3>{folders.length ? '没有匹配的文件夹' : '还没有论文文件夹'}</h3>
      <p>{folders.length ? '试试其他名称，或切换文件夹类型。' : canOrganize ? '点击“新建文件夹”，按研究主题整理已有论文。' : '知识库负责人创建分类后，文件夹会显示在这里。'}</p>
      {folders.length > 0 && <button type="button" className="kso-folder-manager-reset" onClick={resetFilters}>显示全部文件夹</button>}
    </div>}

    {folders.length > 0 && <div className="kso-folder-manager-footer"><span>显示 {visibleFolders.length} / {folders.length} 个文件夹{visibleFolders.length > 3 ? ' · 可在此区域上下滚动' : ''}</span><span>同一论文可属于多个文件夹，不复制原件。</span></div>}
    </>}
  </section>
}
