import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowRight, ChevronDown, FolderClock, LoaderCircle, Plus, RefreshCw } from 'lucide-react'
import { sourceError, type SourceFolder } from './api'
import { controlFolderImport, deleteFolderImport, getFolderImportRun, getFolderImportRuns, getFolderImports, pairFolderImport, readFolderImportRun, retryFolderImportRun, type FolderImportBootstrap, type FolderImportItem, type FolderImportPairing, type FolderImportRun, type FolderImportTask } from './folder-import-api'
import FolderImportSettings from './FolderImportSettings'
import FolderImportConnection from './FolderImportConnection'
import './folder-imports.css'

interface Props {
  folders: SourceFolder[]
  initialFolderId?: string
  openCreate?: number
  canManage: boolean
  onImported?: () => void
  onOpenFolder?: (id: string) => void
  drawerFolderId?: string
  onCloseDrawer?: () => void
  workspaceError?: string
  onRefreshWorkspace?: () => Promise<void>
}
type Panel = { kind: 'create'; folderId?: string } | { kind: 'created'; savedTask: FolderImportTask } | { kind: 'settings' | 'history' | 'pair' | 'delete'; taskId: string } | null
const running = (status: string) => ['queued', 'running', 'scanning', 'transferring', 'processing', 'waiting_quota'].includes(status)
const statuses: Record<string, string> = { idle: '等待扫描', queued: '等待处理', scanning: '正在扫描', transferring: '正在传输', processing: '正在处理', offline: '等待电脑连接', paused: '已暂停', waiting_quota: '等待明日额度', needs_attention: '需要处理', completed: '已完成', partial: '部分完成', failed: '失败', interrupted: '等待恢复', cancelled: '已取消' }
const phases: Record<string, string> = { scan: '正在扫描', transfer: '正在传输', process: '正在处理', waiting_connector: '等待电脑连接', waiting_file: '等待文件就绪', saved: '原件已保存', archive: '正在归档', parse: '正在解析', index: '正在建立问答索引', done: '已完成' }
const dateText = (value?: string | null, timeZone?: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', ...(timeZone ? { timeZone } : {}) }) : '—'
const bytes = (value: number) => value < 1024 * 1024 ? `${Math.max(0, Math.round(value / 1024))} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`
function scheduleText(task: FolderImportTask) {
  if (task.schedule.frequency === 'manual') return '仅手动扫描'
  const day = task.schedule.frequency === 'weekly' ? `每周${['一', '二', '三', '四', '五', '六', '日'][task.schedule.weekday]} ` : '每天 '
  const zone = task.schedule.timezone === 'Asia/Shanghai' ? '北京时间' : task.schedule.timezone === 'Asia/Singapore' ? '新加坡时间' : task.schedule.timezone
  return `${day}${task.schedule.time} · ${zone}`
}
function taskStatus(task: FolderImportTask) { return task.paused ? '已暂停' : task.kind === 'local' && !task.connectorOnline && !running(task.status) ? '等待电脑连接' : statuses[task.status] || '等待扫描' }

export default function FolderImports({ folders, initialFolderId, openCreate, canManage, onImported, onOpenFolder, drawerFolderId, onCloseDrawer, workspaceError, onRefreshWorkspace }: Props) {
  const [data, setData] = useState<FolderImportBootstrap | null>(null)
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [listError, setListError] = useState<{ message: string; background: boolean } | null>(null)
  const [panel, setPanel] = useState<Panel>(openCreate ? { kind: 'create', folderId: initialFolderId } : null), [working, setWorking] = useState('')
  const [pairing, setPairing] = useState<FolderImportPairing | null>(null)
  const alive = useRef(true), request = useRef(0), actionLock = useRef(false), requestedCreate = useRef(openCreate)
  const drawerInitialized = useRef(false)
  const drawerFolder = folders.find(folder => folder.id === drawerFolderId)
  const canCreateInFolder = !drawerFolderId || !!drawerFolder && drawerFolder.writable !== false
  const refresh = useCallback(async (signal?: AbortSignal, background = false) => {
    const id = ++request.current
    try {
      const value = await getFolderImports(signal)
      if (signal?.aborted || !alive.current || id !== request.current) return
      setData(value)
      setListError(null)
      if (drawerFolderId && !drawerInitialized.current) {
        drawerInitialized.current = true
        if (canManage && canCreateInFolder && value.canWrite && !value.tasks.some(task => task.folderId === drawerFolderId)) {
          setPanel({ kind: 'create' })
        }
      }
    } catch (e) {
      if (!signal?.aborted && alive.current && id === request.current) {
        setListError({ message: sourceError(e, '自动导入任务和共享目录'), background })
      }
    }
    finally { if (alive.current && id === request.current) setLoading(false) }
  }, [canCreateInFolder, canManage, drawerFolderId])
  useEffect(() => {
    alive.current = true
    const abort = new AbortController(); void Promise.resolve().then(() => { if (!abort.signal.aborted) return refresh(abort.signal) })
    return () => { alive.current = false; abort.abort() }
  }, [refresh])
  const visibleTasks = data?.tasks.filter(task => !drawerFolderId || task.folderId === drawerFolderId) ?? []
  const active = visibleTasks.some(task => running(task.status) && task.status !== 'waiting_quota')
  const editing = panel?.kind === 'create' || panel?.kind === 'settings'
  const loaded = data !== null
  useEffect(() => {
    if (editing || !loaded) return
    const abort = new AbortController()
    const delay = active ? 2500 : 15000
    let timer: number
    const poll = async () => {
      await refresh(abort.signal, true)
      if (!abort.signal.aborted) timer = window.setTimeout(poll, delay)
    }
    timer = window.setTimeout(poll, delay)
    return () => { window.clearTimeout(timer); abort.abort() }
  }, [editing, loaded, active, refresh])
  useEffect(() => {
    if (openCreate && openCreate !== requestedCreate.current) { requestedCreate.current = openCreate; setPanel({ kind: 'create', folderId: initialFolderId }); setError(''); setPairing(null) }
  }, [openCreate, initialFolderId])
  const writable = canManage && !!data?.canWrite
  const task = panel && 'taskId' in panel ? data?.tasks.find(value => value.id === panel.taskId) : undefined
  function open(value: Panel) { if (actionLock.current) return; setPanel(value); setPairing(null); setNotice(''); setError('') }
  async function act(id: string, action: 'scan' | 'pause' | 'resume' | 'retry') {
    if (actionLock.current || !writable) return
    actionLock.current = true; setWorking(id); setError(''); setNotice('')
    try {
      await controlFolderImport(id, action)
      if (!alive.current) return
      setNotice(action === 'scan' ? '扫描请求已提交；已有任务会继续执行。' : action === 'pause' ? '已暂停后续扫描，已导入资料保留。' : action === 'resume' ? '已恢复扫描计划。' : '失败项已重新排队。')
      if (action === 'scan' || action === 'retry') setPanel({ kind: 'history', taskId: id })
      await refresh()
    } catch (e) { if (alive.current) setError(sourceError(e)) }
    finally { actionLock.current = false; if (alive.current) setWorking('') }
  }
  async function pair(id: string, inline = false) {
    if (actionLock.current || !writable) return
    actionLock.current = true; setWorking(id); setPairing(null); setError('')
    if (!inline) setPanel({ kind: 'pair', taskId: id })
    try { const value = await pairFolderImport(id); if (alive.current) setPairing(value) }
    catch (e) { if (alive.current) setError(sourceError(e)) }
    finally { actionLock.current = false; if (alive.current) setWorking('') }
  }
  async function remove(id: string) {
    if (actionLock.current || !writable) return
    actionLock.current = true; setWorking(id); setError('')
    try { await deleteFolderImport(id); if (!alive.current) return; setPanel(null); setNotice('自动导入任务已删除，知识库资料保留。'); await refresh() }
    catch (e) { if (alive.current) setError(sourceError(e)) }
    finally { actionLock.current = false; if (alive.current) setWorking('') }
  }
  const createdTask = panel?.kind === 'created' ? data?.tasks.find(value => value.id === panel.savedTask.id) || panel.savedTask : undefined
  const focused = !!data && (panel?.kind === 'created' || panel?.kind === 'create' && canCreateInFolder || panel?.kind === 'settings' && !!task || panel?.kind === 'pair' && !!task)
  const listMessage = listError && (!editing || !listError.background || !loaded) ? listError.message : ''
  const loadMessage = [...new Set([workspaceError, listMessage].filter(Boolean))].join(' ')
  function retryLoading() {
    if (workspaceError) void onRefreshWorkspace?.()
    if (listMessage) void refresh()
  }
  const alerts = <>
    {loadMessage && <div className="kso-import-alert" role="alert"><span>{loadMessage}</span><button type="button" className="kso-btn quiet" onClick={retryLoading}>重新加载</button></div>}
    {error && <div className="kso-import-alert" role="alert">{error}</div>}
    {data && !data.workerEnabled && <p className="kso-note" role="status">自动导入处理服务尚未启用，任务会保留，暂不能完成后台处理。</p>}
  </>
  const content = focused && data && panel ? <>
    {alerts}
    {(panel.kind === 'create' || panel.kind === 'created' || panel.kind === 'settings') && <FolderImportSettings saved={!!createdTask} key={panel.kind !== 'settings' ? `new:${openCreate || ''}` : task!.id} task={panel.kind === 'settings' ? task : undefined} bootstrap={data} onRefreshRoots={refresh} folders={folders} initialFolderId={drawerFolderId || (panel.kind === 'create' ? panel.folderId : createdTask?.folderId)} canManage={writable} backLabel={drawerFolderId ? '返回导入任务' : undefined} onClose={() => open(null)} onDelete={panel.kind === 'settings' && task ? () => open({ kind: 'delete', taskId: task.id }) : undefined} onConnect={task ? () => void pair(task.id) : undefined} onSaved={async saved => {
      setPairing(null)
      if (panel.kind === 'create' && saved.kind === 'local') {
        setPanel({ kind: 'created', savedTask: saved })
        setData(current => current && { ...current, tasks: [...current.tasks.filter(item => item.id !== saved.id), saved] })
        await pair(saved.id, true)
      } else {
        setPanel(null); setNotice('自动导入设置已保存。'); await refresh()
      }
    }} />}
    {createdTask && <FolderImportConnection inline key={createdTask.id} task={createdTask} pairing={pairing} sourceFolderName={createdTask.localFolderName || undefined} sourceFolderPath={createdTask.path || undefined} busy={!!working} writable={writable} onClose={() => open(null)} onPair={() => void pair(createdTask.id, true)} />}
    {panel.kind === 'pair' && task && <FolderImportConnection key={task.id} task={task} pairing={pairing} busy={!!working} writable={writable} onClose={() => open(null)} onPair={() => void pair(task.id)} />}
  </> : <>
    {!drawerFolderId && <div className="kso-head"><div><h1>自动导入</h1><p>连接一个文件夹，新文件会自动归档、解析并建立问答索引。</p></div>{writable && <button className="kso-btn primary" disabled={!!working} onClick={() => open({ kind: 'create' })}><Plus />新建自动导入</button>}</div>}
    {drawerFolderId && visibleTasks.length > 0 && <div className="kso-head"><h3>导入任务</h3>{writable && canCreateInFolder && <button className="kso-btn" disabled={!!working} onClick={() => open({ kind: 'create' })}><Plus />新建自动导入</button>}</div>}
    {alerts}
    {notice && <p role="status" className="kso-import-notice">{notice}</p>}
    {data && !writable && <p className="kso-small">当前账号不能配置自动导入，可在资料库查看有权访问的资料。</p>}
    {data && drawerFolderId && !canCreateInFolder && <p className="kso-note">当前文件夹不可写入，请选择有写入权限的文件夹。</p>}
    {loading && !data ? <div className="kso-empty" role="status"><LoaderCircle className="if-spin" />正在读取自动导入任务…</div> : data && !visibleTasks.length ? <div className="kso-import-empty"><FolderClock /><h2>{drawerFolderId ? '此文件夹还没有导入任务' : '让文件夹自动加入知识库'}</h2><p>支持电脑本地文件夹，以及已连接的服务器或 NAS 目录。</p>{writable && canCreateInFolder && panel?.kind !== 'create' && <button className="kso-btn" onClick={() => open({ kind: 'create' })}>{drawerFolderId ? '新建自动导入' : '设置第一个文件夹'}</button>}</div> : data && <div className="kso-import-list">{visibleTasks.map(value => <article className="kso-import-task" key={value.id}>
      <div className="kso-import-task-top">
        <div className="kso-import-task-heading"><button className="kso-import-task-name" onClick={() => open(panel?.kind === 'history' && panel.taskId === value.id ? null : { kind: 'history', taskId: value.id })} aria-expanded={panel?.kind === 'history' && panel.taskId === value.id}><FolderClock /><strong>{value.name}</strong><ChevronDown /></button><span className={`kso-chip ${value.status === 'needs_attention' ? 'warn' : running(value.status) ? 'blue' : ''}`}>{taskStatus(value)}</span></div>
        {writable && <div className="kso-actions kso-import-task-actions">
          <button className="kso-btn primary" disabled={!!working || value.paused || !data.workerEnabled} onClick={() => running(value.status) ? open({ kind: 'history', taskId: value.id }) : void act(value.id, 'scan')}>{running(value.status) ? '查看进度' : '立即扫描'}</button>
          <button className="kso-btn" aria-label={`自动导入设置 ${value.name}`} disabled={!!working} onClick={() => open({ kind: 'settings', taskId: value.id })}>自动导入设置</button>
          <button className="kso-btn quiet" aria-label={`${value.paused ? '恢复' : '暂停'} ${value.name}`} disabled={!!working} onClick={() => void act(value.id, value.paused ? 'resume' : 'pause')}>{value.paused ? '恢复' : '暂停'}</button>
          <button type="button" className="kso-btn quiet danger" aria-label={`删除任务 ${value.name}`} aria-expanded={panel?.kind === 'delete' && panel.taskId === value.id} disabled={!!working} onClick={() => open({ kind: 'delete', taskId: value.id })}>删除任务</button>
        </div>}
      </div>
      {writable && panel?.kind === 'delete' && panel.taskId === value.id && <div className="kso-import-panel" role="group" aria-label="删除自动导入任务">
        <h3>删除「{value.name}」？</h3>
        <p>删除后将停止此任务的扫描。源文件和已导入的知识库资料都会保留。</p>
        <div className="kso-actions">
          <button type="button" className="kso-btn" autoFocus disabled={!!working} onClick={() => open(null)}>取消</button>
          <button type="button" className="kso-btn danger" disabled={!!working} onClick={() => void remove(value.id)}>删除自动导入任务</button>
        </div>
      </div>}
      <div className="kso-import-route" aria-label={`${value.name}文件夹流向`}>
        <div><span className="kso-import-route-label">扫描来源 · {value.kind === 'local' ? '我的电脑' : '服务器 / NAS'}</span><strong title={value.sourcePath || value.path}>{value.sourcePath || value.path || '连接电脑后选择文件夹'}</strong></div>
        <ArrowRight aria-hidden="true" />
        <div><span className="kso-import-route-label">保存到知识库</span>{drawerFolderId ? <strong>{drawerFolder?.name || value.folderName || '目标文件夹不可用'}</strong> : <button onClick={() => onOpenFolder?.(value.folderId)} disabled={!value.folderId} className="kso-import-folder">{folders.find(folder => folder.id === value.folderId)?.name || value.folderName || '目标文件夹不可用'}</button>}</div>
      </div>
      <div className="kso-import-task-bottom"><div className="kso-import-plan"><span>{scheduleText(value)}</span>{!value.paused && value.schedule.frequency !== 'manual' && <span>下次扫描 {dateText(value.nextScanAt, value.schedule.timezone)}</span>}</div>{writable && value.kind === 'local' && !value.connectorOnline && <button className="kso-btn" disabled={!!working} onClick={() => void pair(value.id)}>连接电脑</button>}</div>
      <div className="kso-import-last-result"><span>{value.lastResult ? `上次完成 ${value.lastResult.completed} 份 · 新增 ${value.lastResult.new} · 更新 ${value.lastResult.updated} · 失败 ${value.lastResult.failed}` : '尚未扫描'}</span><button type="button" className="kso-btn quiet" aria-label={`运行记录 ${value.name}`} aria-expanded={panel?.kind === 'history' && panel.taskId === value.id} onClick={() => open(panel?.kind === 'history' && panel.taskId === value.id ? null : { kind: 'history', taskId: value.id })}>{panel?.kind === 'history' && panel.taskId === value.id ? '收起记录' : '运行记录'}</button></div>
      {value.usage && <p className="kso-small">今日已处理 {value.usage.completedFiles} / {value.usage.limit} 份 · 索引完成 {value.usage.indexedFiles} 份{value.status === 'waiting_quota' && value.nextRetryAt && ` · ${dateText(value.nextRetryAt, value.schedule.timezone)} 继续当前任务`}</p>}
      {value.lastError && <p className={value.status === 'waiting_quota' ? 'kso-small' : 'kso-error'}>{value.lastError}</p>}
      {panel?.kind === 'history' && panel.taskId === value.id && <ImportHistory task={value} writable={writable} onImported={onImported} />}
    </article>)}</div>}
  </>
  const workspace = <section className="kso-folder-imports" aria-label="文件夹自动导入">{content}</section>
  return drawerFolderId && onCloseDrawer
    ? <FolderImportDrawer folderName={drawerFolder?.name || '文件夹不可用'} onClose={onCloseDrawer}>{workspace}</FolderImportDrawer>
    : workspace
}

function FolderImportDrawer({ folderName, onClose, children }: { folderName: string; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const headingId = useId()

  useLayoutEffect(() => {
    const element = dialog.current
    if (!element) return
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (!element.open) element.showModal()
    return () => {
      if (element.open) element.close()
      if (trigger?.isConnected) trigger.focus({ preventScroll: true })
    }
  }, [])

  return <dialog ref={dialog} className="kso-import-drawer" aria-labelledby={headingId} onCancel={event => {
    event.preventDefault()
    onClose()
  }}>
    <header className="kso-import-drawer-heading">
      <div><h2 id={headingId}>自动导入设置</h2><p>{folderName}</p></div>
      <button type="button" className="kso-btn quiet" onClick={onClose}>关闭</button>
    </header>
    <div className="kso-import-drawer-body">{children}</div>
  </dialog>
}

function itemLabel(item: FolderImportItem) {
  if (item.status === 'failed') return `${phases[item.phase]?.replace(/^正在/, '').replace(/^原件已保存$/, '原件保存') || '处理'}失败`
  if (item.status === 'unchanged') return '已有资料，跳过处理'
  if (item.status === 'ignored') return '已跳过'
  if (item.status === 'completed') return item.indexStatus === 'ready' ? '可问答' : '索引状态待确认'
  return phases[item.phase] || (item.status === 'pending' ? '等待处理' : '正在处理')
}
function ImportHistory({ task, writable, onImported }: { task: FolderImportTask; writable: boolean; onImported?: () => void }) {
  const [runs, setRuns] = useState<FolderImportRun[]>([]), [detail, setDetail] = useState<{ run: FolderImportRun; items: FolderImportItem[] } | null>(null)
  const [selected, setSelected] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true)
  const request = useRef(0), previousComplete = useRef({ runId: '', count: 0 }), markedRead = useRef<Set<string>>(new Set()), onImportedRef = useRef(onImported)
  useEffect(() => { onImportedRef.current = onImported }, [onImported])
  useEffect(() => {
    const abort = new AbortController()
    async function load() {
      const id = ++request.current
      try {
        const history = await getFolderImportRuns(task.id, abort.signal)
        if (abort.signal.aborted || request.current !== id) return
        setRuns(history.runs)
        const target = selected || history.runs[0]?.id
        if (!target) { setDetail(null); setLoading(false); return }
        const result = await getFolderImportRun(target, abort.signal)
        if (abort.signal.aborted || request.current !== id) return
        setDetail(result); setError(''); setLoading(false)
        const known = previousComplete.current.runId === result.run.id ? previousComplete.current.count : 0
        if (result.run.completed > known) onImportedRef.current?.()
        previousComplete.current = { runId: result.run.id, count: result.run.completed }
        if (!running(result.run.status) && result.items.some(item => item.new) && !markedRead.current.has(target)) {
          markedRead.current.add(target)
          void readFolderImportRun(target).catch(() => { markedRead.current.delete(target) })
        }
      } catch (e) { if (!abort.signal.aborted && request.current === id) { setError(sourceError(e)); setLoading(false) } }
    }
    void load()
    const timer = window.setInterval(() => void load(), running(task.status) && task.status !== 'waiting_quota' ? 2500 : 15000)
    return () => { abort.abort(); window.clearInterval(timer) }
  }, [task.id, task.status, selected])
  async function retry(itemId?: string) {
    if (!detail || busy || !writable) return
    setBusy(true); setError('')
    const id = ++request.current
    try {
      await retryFolderImportRun(detail.run.id, itemId ? [itemId] : undefined)
      const result = await getFolderImportRun(detail.run.id)
      if (request.current === id) setDetail(result)
    }
    catch (e) { setError(sourceError(e)) }
    finally { setBusy(false) }
  }
  const current = detail?.run
  return <div className="kso-import-history" aria-label={`${task.name}运行记录`}>
    <div className="kso-import-panel-head"><h3>运行记录</h3>{runs.length > 0 && <select className="kso-select" aria-label="选择扫描记录" value={selected || runs[0].id} onChange={event => { setSelected(event.target.value); setDetail(null); setLoading(true) }}>{runs.map(run => <option key={run.id} value={run.id}>{dateText(run.createdAt)}{run.initial ? ' · 首次导入' : ''}</option>)}</select>}</div>
    {error && <p className="kso-error" role="alert">{error}</p>}
    {loading && <p className="kso-small" role="status">正在读取运行记录…</p>}
    {!loading && !runs.length && <p className="kso-small">尚无扫描记录。{task.kind === 'local' && !task.connectorOnline ? '连接电脑后会开始首次导入。' : '可以点击“立即扫描”。'}</p>}
    {current && <><div className="kso-import-run-summary"><strong>{statuses[current.status] || phases[current.phase] || '等待处理'}</strong><span>已检查 {current.processed} / {current.total} · 完成 {current.completed} · 失败 {current.failed}</span>{current.initial && <small>首次导入</small>}</div>{current.total > 0 && <progress aria-label="文件处理进度" max={current.total} value={current.processed} />}<p className="kso-small">新增 {current.new} · 更新 {current.updated} · 未变化 {current.unchanged} · 完成表示原件、归档、正文和问答索引均已就绪。</p>{current.warning && <p className="kso-note" role="status">{current.warning}</p>}{current.error && <p className="kso-error">{current.error}</p>}
      <div className="kso-import-result-list">{detail!.items.map(item => <div className="kso-import-result" key={item.id}><div>{item.paperId ? <a href={`/knowledge-sources?folder=${encodeURIComponent(task.folderId)}&paper=${encodeURIComponent(item.paperId)}`}>{item.relativePath}</a> : <strong>{item.relativePath}</strong>}{item.new && !current.initial && item.status === 'completed' && item.indexStatus === 'ready' && <span className="kso-chip blue">NEW</span>}<small>{bytes(item.size)}{item.originalSaved ? ' · 原件已保存' : ''}</small>{item.error && <p className="kso-error">{item.error}</p>}</div><div className="kso-import-result-state"><span className={`kso-chip ${item.status === 'failed' ? 'warn' : item.status === 'completed' && item.indexStatus === 'ready' ? 'green' : ''}`}>{itemLabel(item)}</span>{writable && item.status === 'failed' && !running(current.status) && <button className="kso-btn quiet" aria-label={`重试 ${item.relativePath}`} disabled={busy} onClick={() => void retry(item.id)}>重试</button>}</div></div>)}</div>{writable && current.failed > 0 && !running(current.status) && <button className="kso-btn" disabled={busy} onClick={() => void retry()}><RefreshCw />{busy ? '正在重试…' : '重试本次失败项'}</button>}</>}
  </div>
}
