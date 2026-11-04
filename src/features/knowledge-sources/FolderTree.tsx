import { useState, type DragEvent } from 'react'
import { ChevronDown, ChevronRight, Folder, FolderDown, Search, X } from 'lucide-react'
import type { SourceFolder } from './api'

function folderTree(folders: SourceFolder[]) {
  const ids = new Set(folders.map(f => f.id))
  return folders.filter(f => !f.parentId || !ids.has(f.parentId)).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
}
function dragPaperIds(event: DragEvent): string[] {
  try {
    const value: unknown = JSON.parse(event.dataTransfer.getData('application/x-knowledge-papers'))
    return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === 'string' && id.trim().length > 0 && id.length <= 1100))] : []
  } catch { return [] }
}
export default function FolderTree({ folders, current, counts = {}, canOrganize, onOpen, onDrop }: {
  folders: SourceFolder[]; current: string; counts?: Record<string, number>; canOrganize: boolean
  onOpen: (id: string) => void; onDrop: (folder: string, ids: string[], move: boolean) => void
}) {
  const [expanded, setExpanded] = useState<string[]>([]), [over, setOver] = useState(''),[query,setQuery]=useState('')
  const term=query.trim().toLocaleLowerCase(),byId=new Map(folders.map(folder=>[folder.id,folder])),visible=new Set<string>()
  if(term){for(const folder of folders){let current:SourceFolder|undefined=folder;const chain:SourceFolder[]=[],seen=new Set<string>();let matched=false;while(current&&!seen.has(current.id)){chain.push(current);seen.add(current.id);if(current.name.toLocaleLowerCase().includes(term))matched=true;current=current.parentId?byId.get(current.parentId):undefined}if(matched)chain.forEach(item=>visible.add(item.id))}}
  function branch(folder: SourceFolder, ancestors: string[]) {
    if (ancestors.includes(folder.id)||term&&!visible.has(folder.id)) return null
    const children = folders.filter(f => f.parentId === folder.id).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
    const open = !!term || expanded.includes(folder.id)
    return <div key={folder.id} className="ksv-tree-branch"><div className={`ksv-tree-row${over === folder.id ? ' is-drop' : ''}`} style={{ paddingInlineStart: ancestors.length * 12 }}
      onDragOver={event => { if (canOrganize && event.dataTransfer.types.includes('application/x-knowledge-papers')) { event.preventDefault(); event.dataTransfer.dropEffect = event.shiftKey ? 'move' : 'copy'; setOver(folder.id) } }}
      onDragLeave={() => setOver('')} onDrop={event => { event.preventDefault(); setOver(''); const ids = dragPaperIds(event); if (canOrganize && ids.length) onDrop(folder.id, ids, event.shiftKey) }}>
      {children.length > 0 ? <button type="button" className="kso-icon-btn" aria-label={`${open ? '收起' : '展开'}${folder.name}`} aria-expanded={open} onClick={() => setExpanded(open ? expanded.filter(id => id !== folder.id) : [...expanded, folder.id])}>{open ? <ChevronDown /> : <ChevronRight />}</button> : <span className="ksv-tree-spacer" />}
      <button type="button" className={`kso-nav${folder.id === current ? ' is-active' : ''}`} onClick={() => onOpen(folder.id)} aria-current={folder.id === current ? 'page' : undefined}>{folder.kind === 'source' ? <FolderDown /> : <Folder />}<span>{folder.name}</span>{counts[folder.id] !== undefined && <small>{counts[folder.id]}</small>}</button>
    </div>{open && children.map(child => branch(child, [...ancestors, folder.id]))}</div>
  }
  return <div className="ksv-folder-tree" aria-label="论文目录树"><label className="ksv-tree-search"><Search size={14}/><input type="search" aria-label="搜索论文文件夹" placeholder="搜索文件夹…" maxLength={100} value={query} onChange={event=>setQuery(event.target.value)}/>{query&&<button type="button" className="kso-icon-btn" aria-label="清除文件夹搜索" onClick={()=>setQuery('')}><X size={13}/></button>}</label><div className="ksv-tree-content">{folderTree(folders).map(folder => branch(folder, []))}{term&&!visible.size&&<p className="kso-small">没有匹配的文件夹</p>}</div>{over && <small className="kso-small">放入此文件夹 · 按住 Shift 移动</small>}</div>
}
