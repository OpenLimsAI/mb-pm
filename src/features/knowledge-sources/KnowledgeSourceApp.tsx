import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react'
import {
  ArrowUpRight,
  ChevronDown,
  Clock3,
  Database,
  Download,
  Folder,
  FolderDown,
  FolderOpen,
  FolderSearch,
  Library,
  Link2,
  LoaderCircle,
  Plus,
  RefreshCw,
  Star,
} from 'lucide-react'
import ApplicationActions from '../../components/application/ApplicationActions'
import { usePortalContext } from '../../components/portal/context'
import AcquisitionWorkspace from './AcquisitionWorkspace'
import DownloadTasks from './DownloadTasks'
import FolderActionMenu, { type FolderMenuAction } from './FolderActionMenu'
import FolderImports from './FolderImports'
import FolderTree from './FolderTree'
import KnowledgeFolders from './KnowledgeFolders'
import KnowledgeFallbackLibrary from './KnowledgeFallbackLibrary'
import { formatKnowledgeDate } from './types'
import {
  KnowledgeButton,
  KnowledgeDialog,
  type KnowledgeModalState,
  type KnowledgeMutation,
} from './KnowledgeDialogs'
import LibraryWorkbench from './LibraryWorkbench'
import PaperDeleteDialog from './PaperDeleteDialog'
import ResizableKnowledgeShell from './ResizableKnowledgeShell'
import SourceInsights from './SourceInsights'
import SourceManager from './SourceManager'
import SourceWatchPanel from './SourceWatchPanel'
import {
  findInboxFolder,
  getKnowledgeSourceJobs,
  getKnowledgeSources,
  isInboxFolder,
  mutateKnowledgeSources,
  sourceError,
  type KnowledgeSourceSnapshot,
  type SourcePaper,
} from './api'
import { useKnowledgePreference } from './preferences'
import { knowledgeV3Get } from './v3-api'
import type { WorkspaceState } from './workspace-v3-types'
import './improvements.css'
import './knowledge-sources.css'
import './simple-workspace.css'

type View = 'library' | 'sources' | 'downloads' | 'updates' | 'imports'

interface FileDeletionQueue {
  papers: SourcePaper[]
  index: number
  onDeleted: (paperId: string) => void
}

const EMPTY: KnowledgeSourceSnapshot = {
  papers: [],
  folders: [],
  sources: [],
  jobs: [],
  documents: [],
  catalogRevision: 0,
  canManage: false,
  canOrganize: false,
  starred: [],
  integration: { status: 'unavailable', message: '尚未连接知识库。' },
}

const active = (s: string) => ['queued', 'running', 'pending'].includes(s)

export default function KnowledgeSourceApp() {
  const { preview, user, identityNamespace, applications } = usePortalContext()
  return (
    <Workspace
      key={identityNamespace || user.id}
      storageKey={`kso:v2:${identityNamespace || user.id}`}
      userName={user.displayName || user.username}
      preview={preview}
      allowed={applications.some(a => a.id === 'knowledge-sources' && a.enabled)}
    />
  )
}

function Workspace({
  preview,
  allowed,
  userName,
  storageKey,
}: {
  preview: boolean
  allowed: boolean
  userName: string
  storageKey: string
}) {
  const [data, setData] = useState<KnowledgeSourceSnapshot | null>(null)
  const [loading, setLoading] = useState(!preview && allowed)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [savedView, setView] = useKnowledgePreference<View>(`${storageKey}:view`, 'library')
  const [savedFolder, setFolder] = useKnowledgePreference(`${storageKey}:folder`, 'all')
  const [selected, setSelected] = useState('')
  const [picks, setPicks] = useState<string[]>([])
  const [entry, setEntry] = useState(() => {
    const query = new URLSearchParams(window.location.search)
    return {
      source: query.get('source') || '',
      document: query.get('document') || '',
      job: query.get('job') || '',
      folder: query.get('folder') || '',
    }
  })

  const view: View =
    new URLSearchParams(window.location.search).get('view') === 'imports'
      ? 'imports'
      : entry.job
        ? 'downloads'
        : entry.source
          ? 'sources'
          : entry.folder
            ? 'library'
            : savedView
  const requestedFolder = entry.folder || savedFolder
  const inbox = findInboxFolder(data?.folders || [])
  const folder = requestedFolder === 'unsorted' && inbox ? inbox.id : requestedFolder

  const [search, setSearch] = useKnowledgePreference(`${storageKey}:search`, '')
  const [filter, setFilter] = useState('all')
  const [sort, setSort] = useState('recent')
  const [details, setDetails] = useKnowledgePreference(`${storageKey}:details`, false)
  const [density, setDensity] = useKnowledgePreference<'compact' | 'standard'>(
    `${storageKey}:density`,
    'compact',
  )
  const [recentDays, setRecentDays] = useState('30')
  const [shown, setShown] = useState(100)
  const [progress, setProgress] = useState('')
  const [refreshedAt, setRefreshedAt] = useState('')
  const lastFullRefresh = useRef(0)
  const [jobsError, setJobsError] = useState('')
  const [snapshotError, setSnapshotError] = useState('')
  const [acquisition, setAcquisition] = useState<{ folderId?: string; key: number } | null>(null)
  const [v3Counts, setV3Counts] = useState<Record<string, number>>({})
  const [importCreate, setImportCreate] = useState<{ folderId?: string; key: number } | null>(null)
  const [showImportDrawer, setShowImportDrawer] = useState(false)
  const [allSearch, setAllSearch] = useState<string>()
  const pinnedNavigation = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const bar = pinnedNavigation.current
    const workspace = bar?.parentElement
    if (!bar || !workspace) return
    const measure = () =>
      workspace.style.setProperty('--kso-navigation-height', `${bar.offsetHeight}px`)
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(bar)
    return () => observer?.disconnect()
  }, [])

  const locationMenu = useRef<HTMLElement>(null)
  const locationToggle = useRef<HTMLButtonElement>(null)
  const [moreTools, setMoreTools] = useState(false)
  const [mobileFolders, setMobileFolders] = useState(false)

  useEffect(() => {
    if (!mobileFolders) return
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !locationMenu.current?.contains(event.target)) {
        setMobileFolders(false)
      }
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [mobileFolders])

  const [modal, setModal] = useState<KnowledgeModalState | null>(null)
  const [deletionQueue, setDeletionQueue] = useState<FileDeletionQueue | null>(null)
  const deletingPaper = deletionQueue?.papers[deletionQueue.index]
  const locationRestored = useRef(false)
  const navigationRevision = useRef(0)
  const restoreFolderIds = JSON.stringify(data?.folders.map(item => item.id) || [])
  const libraryV3Ready = !!data?.libraryV3
  const inboxRequest = useRef<Promise<unknown> | null>(null)
  const alive = useRef(true)
  const requestId = useRef(0)
  const mutationLock = useRef(false)
  const focusBack = useRef<HTMLElement | null>(null)

  const refresh = useCallback(async () => {
    const id = ++requestId.current
    try {
      let result = await getKnowledgeSources()
      let folderError = ''
      if (
        result.canOrganize &&
        result.integration.status === 'ready' &&
        !result.folders.some(item => item.systemRole === 'inbox')
      ) {
        try {
          inboxRequest.current ||= mutateKnowledgeSources('post', '/folders/inbox', {}).finally(
            () => {
              inboxRequest.current = null
            },
          )
          await inboxRequest.current
          result = await getKnowledgeSources()
          if (!findInboxFolder(result.folders)) folderError = '待整理文件夹尚未创建，请重试。'
        } catch (e) {
          folderError = sourceError(e, '待整理文件夹')
        }
      }
      if (alive.current && id === requestId.current) {
        setData(result)
        setRefreshedAt(new Date().toISOString())
        lastFullRefresh.current = Date.now()
        setSnapshotError(folderError)
        setJobsError('')
      }
    } catch (e) {
      if (alive.current && id === requestId.current) {
        setSnapshotError(sourceError(e, '知识库资料和目标文件夹'))
      }
    } finally {
      if (alive.current && id === requestId.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    alive.current = true
    if (!preview && allowed) {
      void Promise.resolve().then(() => {
        if (alive.current) return refresh()
      })
    }
    return () => {
      alive.current = false
      requestId.current += 1
    }
  }, [preview, allowed, refresh])

  useEffect(() => {
    if (locationRestored.current || !libraryV3Ready || preview || !allowed) return
    const parameters = new URLSearchParams(window.location.search)
    if (['folder', 'paper', 'source', 'document', 'job', 'view'].some(key => parameters.has(key))) {
      locationRestored.current = true
      return
    }
    const abort = new AbortController()
    const initialNavigation = navigationRevision.current
    const knownFolders = JSON.parse(restoreFolderIds) as string[]
    void knowledgeV3Get<WorkspaceState>('/workspace', abort.signal)
      .then(value => {
        if (abort.signal.aborted) return
        locationRestored.current = true
        if (
          navigationRevision.current !== initialNavigation ||
          ['folder', 'paper', 'source', 'document', 'job', 'view'].some(key =>
            new URLSearchParams(window.location.search).has(key),
          ) ||
          document.activeElement?.matches('input,textarea,select')
        ) {
          return
        }
        const target = value.location.folderId
        if (
          target &&
          (['all', 'recent', 'unsorted', 'starred'].includes(target) ||
            knownFolders.includes(target))
        ) {
          setView('library')
          setFolder(target)
        }
      })
      .catch(() => {
        if (!abort.signal.aborted) locationRestored.current = true
      })
    return () => abort.abort()
  }, [libraryV3Ready, restoreFolderIds, preview, allowed, setView, setFolder])

  const running = data?.jobs.some(j => active(j.status))
  const hasData = !!data
  const jobsRef = useRef(data?.jobs)
  useEffect(() => {
    jobsRef.current = data?.jobs
  }, [data?.jobs])
  const pollDownloads = view !== 'imports' && !showImportDrawer

  useEffect(() => {
    if (preview || !allowed || !hasData || !pollDownloads) return
    const abort = new AbortController()
    const delay = running ? 2500 : 15000
    let timer: number
    const poll = async () => {
      try {
        const result = await getKnowledgeSourceJobs(abort.signal)
        if (abort.signal.aborted) return
        const changed = JSON.stringify(result.jobs) !== JSON.stringify(jobsRef.current)
        setJobsError('')
        if (changed) {
          jobsRef.current = result.jobs
          setData(previous => (previous ? { ...previous, jobs: result.jobs } : previous))
          if (
            !result.jobs.some(j => active(j.status)) ||
            Date.now() - lastFullRefresh.current > 15000
          ) {
            await refresh()
          }
        }
      } catch (e) {
        if (!abort.signal.aborted) setJobsError(sourceError(e, '下载任务状态'))
      } finally {
        if (!abort.signal.aborted) timer = window.setTimeout(poll, delay)
      }
    }
    timer = window.setTimeout(poll, delay)
    return () => {
      abort.abort()
      window.clearTimeout(timer)
    }
  }, [running, hasData, preview, allowed, pollDownloads, refresh])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 6000)
    return () => window.clearTimeout(timer)
  }, [notice])

  const mutate: KnowledgeMutation = async (method, path, body, success) => {
    if (preview || mutationLock.current) return false
    mutationLock.current = true
    setBusy(true)
    setError('')
    try {
      const input = body as { paperIds?: string[]; revision?: number }
      if (path === '/papers/folders' && input.paperIds?.length) {
        let revision = input.revision || 0
        for (let offset = 0; offset < input.paperIds.length; offset += 500) {
          setProgress(`整理 ${Math.min(offset + 500, input.paperIds.length)} / ${input.paperIds.length} 篇`)
          await mutateKnowledgeSources(method, path, {
            ...input,
            paperIds: input.paperIds.slice(offset, offset + 500),
            revision,
          })
          if (offset + 500 < input.paperIds.length) {
            revision = (await getKnowledgeSources()).catalogRevision
          }
        }
      } else {
        await mutateKnowledgeSources(method, path, body)
      }
      if (!alive.current) return false
      await refresh()
      if (!alive.current) return false
      setNotice(success)
      return true
    } catch (e) {
      if (alive.current) {
        if (path === '/papers/folders') await refresh()
        setError(sourceError(e))
      }
      return false
    } finally {
      mutationLock.current = false
      if (alive.current) {
        setBusy(false)
        setProgress('')
      }
    }
  }

  function go(v: View, target = folder) {
    setError('')
    setAllSearch(undefined)
    setShowImportDrawer(false)
    if (v !== 'imports') setImportCreate(null)
    setAcquisition(null)
    setMobileFolders(false)
    navigationRevision.current += 1
    const url = new URL(window.location.href)
    for (const key of ['source', 'document', 'job', 'folder', 'paper', 'view']) {
      url.searchParams.delete(key)
    }
    if (v === 'library') url.searchParams.set('folder', target)
    if (v === 'imports') url.searchParams.set('view', 'imports')
    window.history.replaceState(null, '', url)
    setEntry({ source: '', document: '', job: '', folder: '' })
    setView(v)
    setFolder(target)
    setSearch('')
    setFilter('all')
    setPicks([])
    setShown(100)
  }

  const open = (m: KnowledgeModalState) => {
    focusBack.current = document.activeElement as HTMLElement
    setModal(m)
  }

  function close() {
    if (mutationLock.current) return
    setModal(null)
    window.setTimeout(() => focusBack.current?.isConnected && focusBack.current.focus(), 0)
  }

  const d = data || EMPTY
  const folderName = (id: string) => d.folders.find(f => f.id === id)?.name || '未指定'
  const folderCount = (id: string) =>
    d.libraryV3
      ? (v3Counts[id] ?? d.folderCounts?.[id] ?? 0)
      : new Set(
          d.papers.filter(p => p.folderIds.includes(id)).map(p => p.documentId || p.id),
        ).size
  const sourceFolderIds = d.folders
    .filter(f =>
      f.kind
        ? f.kind === 'source'
        : d.sources.some(s => (s.archiveFolderId || s.folderId) === f.id),
    )
    .map(f => f.id)
  const sourceFolders = new Set(sourceFolderIds)
  const unsorted = (p: SourcePaper) =>
    p.folderIds.length === 0 || (!!inbox && p.folderIds.every(id => id === inbox.id))
  const q = search.trim().toLocaleLowerCase()
  const batch = folder.startsWith('batch:')
    ? d.jobs.find(j => j.id === folder.slice(6))
    : undefined
  const batchVersions = new Set(batch?.items.map(i => i.versionId))
  const clockTime = refreshedAt ? Date.parse(refreshedAt) : 0
  const cutoff =
    recentDays === 'today'
      ? new Date(clockTime).setHours(0, 0, 0, 0)
      : clockTime - Number(recentDays) * 86400000

  const matchingPapers = d.papers
    .filter(
      p =>
        (folder === 'all' ||
          (folder.startsWith('batch:')
            ? batchVersions.has(p.versionId) && !!p.versionId
            : folder === 'recent'
              ? p.saved && !!p.createdAt && Date.parse(p.createdAt) >= cutoff
              : folder === 'unsorted'
                ? unsorted(p)
                : folder === 'starred'
                  ? d.starred.includes(p.id)
                  : inbox?.id === folder
                    ? unsorted(p)
                    : p.folderIds.includes(folder))) &&
        (!q ||
          `${p.title} ${p.code || ''} ${p.sourceName || ''}`.toLocaleLowerCase().includes(q)) &&
        (filter === 'all' ||
          (filter === 'ready'
            ? p.indexStatus === 'ready'
            : filter === 'failed'
              ? p.indexStatus === 'failed'
              : p.type === filter)),
    )
    .sort((a, b) =>
      sort === 'name'
        ? a.title.localeCompare(b.title)
        : (b.createdAt || '').localeCompare(a.createdAt || ''),
    )

  const grouped = new Map<string, SourcePaper>()
  for (const item of matchingPapers) {
    const key = item.documentId || item.id
    const previous = grouped.get(key)
    if (!previous || (item.latest && !previous.latest)) grouped.set(key, item)
  }
  const papers = [...grouped.values()]
  const paper = papers.find(p => p.id === selected) || papers[0]
  const currentFolder = d.folders.find(f => f.id === folder)
  const visiblePicks = picks.filter(id => papers.some(p => p.id === id))
  const source = d.sources.find(s => s.folderId === folder)
  const title =
    currentFolder?.name ||
    (batch ? '本次下载文件' : '') ||
    ({ all: '全部资料', recent: '最近下载', unsorted: '待整理', starred: '我的收藏' }[folder] ||
      '全部论文')

  function searchAll(query: string) {
    go('library', 'all')
    setAllSearch(query)
    setSearch(query)
  }

  function removeFromCurrentFolder(selectedPapers: SourcePaper[]) {
    if (
      !selectedPapers.length ||
      !currentFolder ||
      currentFolder.writable === false ||
      isInboxFolder(currentFolder)
    ) {
      return Promise.resolve(false)
    }
    let message = `已从「${currentFolder.name}」移出 ${selectedPapers.length} 份资料。`
    if (selectedPapers.length === 1) {
      const remaining = d.folders.filter(
        item =>
          item.id !== folder &&
          selectedPapers[0].folderIds.includes(item.id) &&
          !isInboxFolder(item),
      )
      const location = remaining.length
        ? `仍可在${remaining.map(item => `「${item.name}」`).join('、')}找到。`
        : inbox
          ? `可在「${inbox.name}」中找到。`
          : '可在全部资料中找到。'
      message = `已从「${currentFolder.name}」移出。${location}`
    }
    return mutate(
      'post',
      '/papers/folders',
      {
        paperIds: selectedPapers.map(item => item.id),
        folderIds: [],
        fromFolderId: folder,
        mode: 'remove',
        revision: d.catalogRevision,
      },
      message,
    )
  }

  function startFileDeletion(targetPapers: SourcePaper[], onDeleted: (paperId: string) => void) {
    if (!deletionQueue && targetPapers.length) {
      setDeletionQueue({ papers: [...targetPapers], index: 0, onDeleted })
    }
  }

  function completeFileDeletion() {
    if (!deletionQueue || !deletingPaper) return
    const { papers: queued, index, onDeleted } = deletionQueue
    onDeleted(deletingPaper.id)
    setSelected(previous => (previous === deletingPaper.id ? '' : previous))
    setPicks(previous => previous.filter(id => id !== deletingPaper.id))
    const completed = index + 1
    setNotice(
      queued.length === 1
        ? '文件已从整个知识库删除。'
        : `已从知识库删除 ${completed} / ${queued.length} 份文件。`,
    )
    setDeletionQueue(completed === queued.length ? null : { ...deletionQueue, index: completed })
    void refresh()
  }

  function openAcquisition() {
    setAcquisition(previous => ({
      folderId: view === 'library' ? currentFolder?.id : undefined,
      key: (previous?.key || 0) + 1,
    }))
  }

  function openAutoImport(folderId?: string) {
    setImportCreate(previous => ({ folderId, key: (previous?.key || 0) + 1 }))
    go('imports')
  }

  function folderAction(id: string, action: FolderMenuAction) {
    if (d.folders.some(f => f.id === id && isInboxFolder(f))) return
    open({
      kind:
        action === 'rename'
          ? 'rename-folder'
          : action === 'delete'
            ? 'delete-folder'
            : 'manage-folder',
      folderId: id,
    })
  }

  function nav(v: View, f: string, label: string, icon: ReactNode, count?: number) {
    const isCurrent = view === v && (v !== 'library' || folder === f)
    return (
      <button
        type="button"
        className={`kso-nav${isCurrent ? ' is-active' : ''}`}
        onClick={() => go(v, f)}
        aria-current={isCurrent ? 'page' : undefined}
      >
        {icon}
        <span>{label}</span>
        {count !== undefined && <small>{count}</small>}
      </button>
    )
  }

  async function assignFolder(folderId: string) {
    if (
      await mutate(
        'post',
        '/papers/folders',
        {
          paperIds: visiblePicks,
          folderIds: [folderId],
          mode: 'add',
          revision: d.catalogRevision,
        },
        `已将所选论文放入「${folderName(folderId)}」，原件保留。`,
      )
    ) {
      setPicks([])
    }
  }

  const importPanelVisible =
    !!data &&
    (view === 'imports' ||
      (showImportDrawer && d.canOrganize && !!currentFolder && currentFolder.writable !== false))
  const visibleError =
    error ||
    (!importPanelVisible && data ? snapshotError : '') ||
    (pollDownloads ? jobsError : '')

  return (
    <div
      id="knowledge-source-app"
      className={`kso-density-${density} kso-simple-workspace${mobileFolders ? ' mobile-folders-open' : ''}`}
    >
      <a className="kso-skip" href="#kso-content">
        跳至知识源内容
      </a>
      <div ref={pinnedNavigation} className="kso-pinned-navigation">
        <header className="kso-top kso-source-header">
          <div className="kso-brand">
            <div className="kso-mark">
              <FolderSearch aria-hidden="true" />
            </div>
            <strong>知识源</strong>
            <span>资料收录与整理</span>
            {preview && <small className="kso-preview">界面预览 · 未连接数据</small>}
          </div>
          <div className="kso-header-actions">
            <button
              type="button"
              className="kso-btn quiet kso-header-refresh"
              aria-label="刷新知识源"
              title="刷新知识源"
              onClick={() => {
                void refresh()
              }}
              disabled={busy || loading || preview || !allowed}
            >
              <RefreshCw aria-hidden="true" />
              刷新
            </button>
            <ApplicationActions userName={userName} preview={preview} />
          </div>
        </header>
        <nav className="kso-workspace-tabs" aria-label="知识源功能">
          {(
            [
              ['library', '资料库'],
              ['sources', '来源下载'],
              ['imports', '自动导入'],
              ['downloads', '下载记录'],
            ] as const
          ).map(([target, label]) => (
            <button
              type="button"
              key={target}
              aria-current={(view === 'updates' ? 'sources' : view) === target ? 'page' : undefined}
              onClick={() => go(target, target === 'library' ? currentFolder?.id || 'all' : folder)}
            >
              {label}
            </button>
          ))}
        </nav>
      </div>
      {notice && (
        <div role="status" className="kso-inline-status">
          {notice}
        </div>
      )}
      {progress && (
        <div role="status" className="kso-inline-status">
          {progress}
        </div>
      )}
      {visibleError && (
        <div role="alert" className="kso-inline-status kso-inline-error">
          {visibleError}
          <KnowledgeButton
            quiet
            onClick={() => {
              void refresh()
            }}
            disabled={busy}
          >
            重试连接
          </KnowledgeButton>
          {refreshedAt && <small>已加载资料时间：{formatKnowledgeDate(refreshedAt)}</small>}
        </div>
      )}
      <WorkspaceLayout
        showFolders={view === 'library'}
        storageKey={storageKey}
        sidebar={
          <aside
            ref={locationMenu}
            className="kso-sidebar"
            onKeyDown={event => {
              if (event.key === 'Escape' && mobileFolders) {
                setMobileFolders(false)
                locationToggle.current?.focus()
              }
            }}
          >
            <button
              ref={locationToggle}
              type="button"
              className="kso-location-toggle"
              aria-label="切换资料位置"
              aria-expanded={mobileFolders}
              aria-controls="kso-library-locations"
              onClick={() => setMobileFolders(!mobileFolders)}
            >
              <Folder />
              <span>{title}</span>
              <small>切换</small>
              <ChevronDown />
            </button>
            <div id="kso-library-locations" className="kso-location-content">
              <div className="kso-side-group">
                <div className="kso-side-label">资料库</div>
                {nav(
                  'library',
                  'all',
                  '全部资料',
                  <Library />,
                  d.libraryV3
                    ? d.libraryTotal
                    : new Set(d.papers.map(p => p.documentId || p.id)).size,
                )}
                {nav('library', 'recent', '最近下载', <Clock3 />)}
                {nav(
                  'library',
                  'starred',
                  '我的收藏',
                  <Star />,
                  d.libraryV3
                    ? d.starred.length
                    : d.papers.filter(p => d.starred.includes(p.id)).length,
                )}
              </div>
              <div className="kso-folder-section">
                <div className="kso-side-label">
                  <span>文件夹</span>
                  {d.canOrganize && (
                    <button
                      className="kso-folder-create"
                      type="button"
                      aria-label="新建文件夹"
                      onClick={() => open({ kind: 'new-folder' })}
                    >
                      新建
                    </button>
                  )}
                </div>
                <div className="kso-side-group">
                  {d.libraryV3 ? (
                    <FolderTree
                      busy={busy}
                      onFolderAction={folderAction}
                      folders={d.folders}
                      current={folder}
                      counts={{ ...d.folderCounts, ...v3Counts }}
                      canOrganize={d.canOrganize}
                      onOpen={id => go('library', id)}
                      onDrop={(target, ids, move) => {
                        void mutate(
                          'post',
                          '/papers/folders',
                          {
                            paperIds: ids,
                            folderIds: [target],
                            mode: move && currentFolder ? 'move' : 'add',
                            ...(move && currentFolder ? { fromFolderId: folder } : {}),
                            revision: d.catalogRevision,
                          },
                          '文件夹整理已完成。',
                        )
                      }}
                    />
                  ) : (
                    [...d.folders]
                      .sort((a, b) => Number(isInboxFolder(b)) - Number(isInboxFolder(a)))
                      .map(f => (
                        <div key={f.id} className="kso-folder-nav-row">
                          {nav(
                            'library',
                            f.id,
                            f.name,
                            sourceFolders.has(f.id) ? <FolderDown /> : <Folder />,
                            folderCount(f.id),
                          )}
                          {d.canOrganize && !isInboxFolder(f) && (
                            <FolderActionMenu
                              name={f.name}
                              disabled={busy}
                              onAction={action => folderAction(f.id, action)}
                            />
                          )}
                        </div>
                      ))
                  )}
                </div>
              </div>
            </div>
            <div className="kso-side-end">
              <Database />
              <span>与知识库共用资料</span>
            </div>
          </aside>
        }
      >
        <main id="kso-content" className="kso-main" aria-busy={loading || busy}>
          {preview ? (
            <EmptyState title="知识源界面预览">
              预览不连接知识库。请正常登录后查看真实论文、文件夹和来源下载任务。
            </EmptyState>
          ) : !allowed ? (
            <EmptyState title="知识源暂不可用">
              请返回工作台刷新应用权限，或联系管理员。
            </EmptyState>
          ) : loading ? (
            <EmptyState title="正在读取知识库">
              <LoaderCircle className="if-spin" />
              正在加载论文、文件夹和来源状态。
            </EmptyState>
          ) : !data ? (
            <EmptyState title="知识库资料尚未加载">
              <div role="alert">
                {snapshotError || '尚未取得资料和文件夹清单。'}{' '}
                <KnowledgeButton
                  onClick={() => {
                    void refresh()
                  }}
                >
                  重新加载
                </KnowledgeButton>
              </div>
            </EmptyState>
          ) : (
            <>
              {d.integration.status !== 'ready' && (
                <div className="kso-connection" role="status">
                  {d.integration.message}
                </div>
              )}
              {acquisition ? (
                <div className="kso-intake-page">
                  <AcquisitionWorkspace
                    key={acquisition.key}
                    initialFolderId={acquisition.folderId}
                    folders={d.folders}
                    canManage={d.canOrganize}
                    onImported={() => {
                      void refresh()
                    }}
                    onClose={() => setAcquisition(null)}
                    onAutoImport={openAutoImport}
                  />
                </div>
              ) : view === 'imports' ? (
                <FolderImports
                  folders={d.folders}
                  workspaceError={snapshotError}
                  onRefreshWorkspace={refresh}
                  initialFolderId={importCreate?.folderId}
                  openCreate={importCreate?.key}
                  canManage={d.canOrganize}
                  onImported={() => {
                    void refresh()
                  }}
                  onOpenFolder={id => go('library', id)}
                />
              ) : view === 'sources' ? (
                <>
                  <SourceManager
                    focusSource={entry.source}
                    focusDocument={entry.document}
                    storageKey={storageKey}
                    density={density}
                    onDensityChange={setDensity}
                    data={d}
                    busy={busy}
                    mutate={mutate}
                    onAdd={() => open({ kind: 'source' })}
                    onDownloads={() => go('downloads')}
                  />
                  <details
                    className="kso-more-source-tools"
                    onToggle={event => setMoreTools(event.currentTarget.open)}
                  >
                    <summary>更多来源工具</summary>
                    {moreTools && (
                      <>
                        <button className="kso-btn" onClick={() => openAcquisition()}>
                          上传 PDF
                        </button>
                        {d.libraryV3 && (
                          <SourceWatchPanel
                            sources={d.sources}
                            onDocument={id => {
                              const document = d.documents.find(item => item.id === id)
                              if (document) {
                                setEntry({
                                  source: document.sourceId,
                                  document: id,
                                  job: '',
                                  folder: '',
                                })
                              }
                            }}
                          />
                        )}
                        <button className="kso-btn" onClick={() => go('updates')}>
                          查看更新与用量
                        </button>
                      </>
                    )}
                  </details>
                </>
              ) : view === 'updates' ? (
                <SourceInsights data={d} busy={busy} mutate={mutate} />
              ) : view === 'downloads' ? (
                <DownloadTasks focusJob={entry.job} data={d} busy={busy} mutate={mutate} go={go} />
              ) : (
                <>
                  <div>
                    <div className="kso-head">
                      <div>
                        <h1>{title}</h1>
                        <p>
                          {folder === 'unsorted' || (currentFolder && isInboxFolder(currentFolder))
                            ? '选择资料，放入合适的文件夹。'
                            : source
                              ? '从此来源收录的资料。'
                              : '点击标题阅读，勾选资料后整理到文件夹。'}
                        </p>
                      </div>
                      <div className="kso-actions">
                        {d.canOrganize && currentFolder && !isInboxFolder(currentFolder) && (
                          <FolderActionMenu
                            name={currentFolder.name}
                            disabled={busy}
                            onAction={action => folderAction(folder, action)}
                          />
                        )}
                        {d.canOrganize && currentFolder && currentFolder.writable !== false && (
                          <KnowledgeButton disabled={busy} onClick={() => setShowImportDrawer(true)}>
                            自动导入设置
                          </KnowledgeButton>
                        )}
                        {d.canManage && (
                          <KnowledgeButton
                            className="kso-source-shortcut"
                            onClick={() => go('sources')}
                          >
                            <Download />
                            从来源下载
                          </KnowledgeButton>
                        )}
                        {!d.libraryV3 && d.canOrganize && (
                          <KnowledgeButton primary onClick={() => openAcquisition()}>
                            <Plus />
                            上传 PDF
                          </KnowledgeButton>
                        )}
                      </div>
                    </div>
                  </div>
                  {source && !d.libraryV3 && (
                    <div className="kso-source-strip">
                      <div>
                        <Link2 />
                        <div>
                          <strong>已关联下载源 {source.name}</strong>
                          <span> · 下载后自动归入此文件夹，整理时复用原件</span>
                        </div>
                      </div>
                      <KnowledgeButton quiet onClick={() => go('sources')}>
                        管理来源
                        <ArrowUpRight />
                      </KnowledgeButton>
                    </div>
                  )}
                  {folder === 'all' && !d.libraryV3 && (
                    <KnowledgeFolders
                      storageKey={storageKey}
                      folders={d.folders}
                      papers={d.papers}
                      sourceFolderIds={sourceFolderIds}
                      selectedIds={visiblePicks}
                      canOrganize={d.canOrganize}
                      busy={busy}
                      onOpen={id => go('library', id)}
                      onCreate={() => open({ kind: 'new-folder' })}
                      onRename={id => open({ kind: 'rename-folder', folderId: id })}
                      onAssign={id => {
                        void assignFolder(id)
                      }}
                    />
                  )}
                  {!d.libraryV3 && (
                    <div className="kso-actions">
                      <label className="kso-small">
                        列表密度{' '}
                        <select
                          className="kso-select"
                          aria-label="列表密度"
                          value={density}
                          onChange={e => setDensity(e.target.value as 'compact' | 'standard')}
                        >
                          <option value="compact">紧凑</option>
                          <option value="standard">标准</option>
                        </select>
                      </label>
                      {folder === 'recent' && (
                        <select
                          className="kso-select"
                          aria-label="下载时间范围"
                          value={recentDays}
                          onChange={e => setRecentDays(e.target.value)}
                        >
                          <option value="today">今天</option>
                          <option value="7">近 7 天</option>
                          <option value="30">近 30 天</option>
                        </select>
                      )}
                    </div>
                  )}
                  {d.libraryV3 ? (
                    <LibraryWorkbench
                      key={folder}
                      initialQuery={allSearch}
                      onSearchAll={searchAll}
                      data={d}
                      folder={folder}
                      storageKey={storageKey}
                      density={density}
                      busy={busy}
                      onRefresh={() => {
                        void refresh()
                      }}
                      onAdd={() => openAcquisition()}
                      onDensityChange={setDensity}
                      onRetry={documentId =>
                        mutate(
                          'post',
                          `/documents/${encodeURIComponent(documentId)}/retry`,
                          {},
                          '已提交解析与索引任务，原件保留。',
                        )
                      }
                      onStar={(paperId, enabled) =>
                        mutate(
                          'post',
                          '/stars',
                          { paperId, enabled },
                          enabled ? '已加入个人收藏。' : '已取消个人收藏。',
                        )
                      }
                      onCounts={counts =>
                        setV3Counts(previous =>
                          JSON.stringify(previous) === JSON.stringify(counts) ? previous : counts,
                        )
                      }
                      onDelete={startFileDeletion}
                      onRemoveFromFolder={
                        currentFolder &&
                        currentFolder.writable !== false &&
                        !isInboxFolder(currentFolder)
                          ? removeFromCurrentFolder
                          : undefined
                      }
                      onOrganize={(ids, target, move) =>
                        mutate(
                          'post',
                          '/papers/folders',
                          {
                            paperIds: ids,
                            folderIds: Array.isArray(target) ? target : [target],
                            mode: move ? 'move' : 'add',
                            ...(move ? { fromFolderId: folder } : {}),
                            revision: d.catalogRevision,
                          },
                          '所选资料整理已完成。',
                        )
                      }
                    />
                  ) : (
                    <KnowledgeFallbackLibrary
                      data={d}
                      papers={papers}
                      paper={paper}
                      currentFolder={currentFolder}
                      folder={folder}
                      search={search}
                      filter={filter}
                      sort={sort}
                      details={details}
                      shown={shown}
                      picks={picks}
                      visiblePicks={visiblePicks}
                      busy={busy}
                      folderName={folderName}
                      mutate={mutate}
                      onSearchChange={value => {
                        setSearch(value)
                        setPicks([])
                      }}
                      onFilterChange={value => {
                        setFilter(value)
                        setPicks([])
                      }}
                      onSortChange={setSort}
                      onToggleDetails={() => setDetails(!details)}
                      onSelectPaper={id => {
                        setSelected(id)
                        setDetails(true)
                      }}
                      onPicksChange={setPicks}
                      onShowMore={() => setShown(n => n + 100)}
                      onOpenModal={open}
                      onGo={go}
                      onNotice={setNotice}
                      onCloseDetails={() => setDetails(false)}
                    />
                  )}
                </>
              )}
            </>
          )}
        </main>
      </WorkspaceLayout>
      <footer className="kso-app-footer">
        <span>
          <Database aria-hidden="true" />
          与知识库共用资料
        </span>
        <span>迈博药业 · 数字化工作空间</span>
      </footer>
      {showImportDrawer &&
        d.canOrganize &&
        currentFolder &&
        currentFolder.writable !== false && (
          <FolderImports
            key={currentFolder.id}
            folders={d.folders}
            workspaceError={snapshotError}
            onRefreshWorkspace={refresh}
            drawerFolderId={currentFolder.id}
            canManage={d.canOrganize}
            onCloseDrawer={() => setShowImportDrawer(false)}
            onImported={() => {
              void refresh()
            }}
          />
        )}
      {deletionQueue && deletingPaper && data && (
        <PaperDeleteDialog
          key={deletingPaper.id}
          paper={deletingPaper}
          folders={d.folders}
          storageKey={storageKey}
          position={
            deletionQueue.papers.length > 1
              ? { current: deletionQueue.index + 1, total: deletionQueue.papers.length }
              : undefined
          }
          onClose={() => setDeletionQueue(null)}
          onDeleted={completeFileDeletion}
        />
      )}
      {modal && data && (
        <KnowledgeDialog
          key={`${modal.kind}:${modal.folderId || ''}`}
          modal={modal}
          data={d}
          folderCount={folderCount}
          busy={busy}
          remoteError={error}
          mutate={mutate}
          onClose={close}
          onNavigate={target => {
            setModal(null)
            go(target)
          }}
          onDone={() => {
            const removed = modal.kind === 'delete-folder' || modal.kind === 'manage-folder'
            const target = modal.folderId
            setModal(null)
            setPicks([])
            if (removed && target === folder) go('library', 'all')
          }}
        />
      )}
    </div>
  )
}

function WorkspaceLayout({
  showFolders,
  ...props
}: ComponentProps<typeof ResizableKnowledgeShell> & { showFolders: boolean }) {
  return showFolders ? (
    <ResizableKnowledgeShell {...props} />
  ) : (
    <div className="kso-section-shell">{props.children}</div>
  )
}

function EmptyState({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="kso-empty">
      <FolderOpen />
      <h3>{title}</h3>
      <div>{children}</div>
    </div>
  )
}
