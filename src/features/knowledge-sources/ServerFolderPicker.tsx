import { useEffect, useRef, useState } from 'react'
import { ArrowUp, ChevronRight, Folder, FolderOpen } from 'lucide-react'
import { sourceError } from './api'
import { listFolderImportDirectories, type FolderImportRoot } from './folder-import-api'
import { serverFolderLocation } from './server-folder-path'

interface Props {
  root: FolderImportRoot
  initialPath: string
  onChoose: (path: string) => void
  onClose: () => void
}

type Listing =
  | { status: 'ready'; directories: string[]; truncated: boolean }
  | { status: 'error'; message: string }

export default function ServerFolderPicker({ root, initialPath, onChoose, onClose }: Props) {
  const [path, setPath] = useState(initialPath)
  const [attempt, setAttempt] = useState(0)
  const [listing, setListing] = useState<Listing | null>(null)
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const currentLocation = useRef<HTMLElement>(null)
  useEffect(() => { currentLocation.current?.focus({ preventScroll: true }) }, [path])

  useEffect(() => {
    const controller = new AbortController()
    listFolderImportDirectories(root.id, path, controller.signal, query).then(result => {
      if (!controller.signal.aborted) setListing({ status: 'ready', ...result })
    }).catch(error => {
      if (!controller.signal.aborted) setListing({ status: 'error', message: sourceError(error) })
    })
    return () => controller.abort()
  }, [root.id, path, query, attempt])

  function navigate(next: string) {
    setListing(null)
    setSearch('')
    setQuery('')
    setPath(next)
  }

  function filter() {
    const next = search.trim()
    if (query === next) return
    setListing(null)
    setQuery(next)
  }

  return <div className="kso-server-browser" role="group" aria-label="浏览服务器文件夹">
    <div className="kso-server-location">
      <FolderOpen aria-hidden="true" />
      <strong ref={currentLocation} tabIndex={-1}>{serverFolderLocation(root, path)}</strong>
      <button type="button" className="kso-btn quiet" disabled={!path} onClick={() => navigate(path.split('/').slice(0, -1).join('/'))}><ArrowUp />上一级</button>
    </div>
    {(!!query || listing?.status === 'ready' && listing.truncated) && <div className="kso-server-search">
      <input aria-label="查找当前目录中的子文件夹" placeholder="输入子文件夹名称" maxLength={255} value={search} onChange={event => setSearch(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); filter() } }} />
      <button type="button" className="kso-btn" onClick={filter} disabled={search.trim() === query}>查找</button>
    </div>}
    {!listing && <p className="kso-small" role="status">正在读取文件夹…</p>}
    {listing?.status === 'error' && <div className="kso-server-browser-error" role="alert">
      <span>无法读取此文件夹。{listing.message}</span>
      <button type="button" className="kso-btn quiet" onClick={() => { setListing(null); setAttempt(current => current + 1) }}>重试</button>
    </div>}
    {listing?.status === 'ready' && <>
      {listing.directories.length ? <ul className="kso-server-children">{listing.directories.map(name => <li key={name}>
        <button type="button" onClick={() => navigate(path ? `${path}/${name}` : name)}><Folder aria-hidden="true" /><span>{name}</span><ChevronRight aria-hidden="true" /></button>
      </li>)}</ul> : <p className="kso-small" role="status">{query ? '没有匹配的子文件夹。' : '此文件夹没有可浏览的子文件夹，可直接选用。'}</p>}
      {listing.truncated && <p className="kso-small">这里只显示部分子文件夹，可按名称查找。</p>}
    </>}
    <div className="kso-server-browser-actions">
      <button type="button" className="kso-btn primary" disabled={listing?.status !== 'ready'} onClick={() => onChoose(path)}>使用当前文件夹</button>
      <button type="button" className="kso-btn quiet" onClick={onClose}>收起</button>
    </div>
  </div>
}
