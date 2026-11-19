import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ArrowLeft, Check, ChevronDown, Clock3, FolderOpen, Laptop, Server } from 'lucide-react'
import { sourceError, type SourceFolder } from './api'
import { probeFolderImport, saveFolderImport, searchFolderImportDirectories, type FolderImportDirectorySearch, type FolderImportBootstrap, type FolderImportConfig, type FolderImportProbe, type FolderImportTask } from './folder-import-api'
import ServerFolderPicker from './ServerFolderPicker'
import FolderImportProbeResult from './FolderImportProbeResult'
import { matchServerFolders, resolveServerFolder, serverFolderLocation, type ServerSelection } from './server-folder-path'
import './folder-import-settings.css'

interface Props {
  task?: FolderImportTask
  bootstrap: FolderImportBootstrap
  folders: SourceFolder[]
  initialFolderId?: string
  saved?: boolean
  canManage: boolean
  backLabel?: string
  onClose: () => void
  onDelete?: () => void
  onConnect?: () => void
  onRefreshRoots?: () => Promise<void>
  onSaved: (task: FolderImportTask) => Promise<void>
}
type Section = 'source' | 'destination' | 'schedule'
const sections: Section[] = ['source', 'destination', 'schedule']
type DirectoryPicker = (options: { mode: 'read' }) => Promise<{ name: string }>
const pickerWindow = window as Window & { showDirectoryPicker?: DirectoryPicker }
const fullFolderPath = (path: string) => /^(?:\/|~\/|[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(path) && !/[\r\n\0]/.test(path) && path.length <= 1500
const weekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const zoneName = (zone: string) => zone === 'Asia/Shanghai' ? '北京时间' : zone === 'Asia/Singapore' ? '新加坡时间' : zone
// Changing a destination, name or schedule does not invalidate a directory check.
const sourceSignature = (value: FolderImportConfig) => JSON.stringify([value.kind, value.serverRootId, value.path, value.includeSubfolders, value.maxFileMb, value.maxFilesPerScan])

export default function FolderImportSettings({ task, bootstrap, folders, initialFolderId, canManage, saved = false, backLabel = '返回自动导入', onClose, onDelete, onConnect, onRefreshRoots, onSaved }: Props) {
  const [config, setConfig] = useState<FolderImportConfig>(() => task ? {
    name: task.name, kind: task.kind, serverRootId: task.serverRootId, localFolderName: task.localFolderName, path: task.path, folderId: task.folderId,
    includeSubfolders: task.includeSubfolders, preserveHierarchy: task.preserveHierarchy, schedule: { ...task.schedule },
    maxFileMb: task.maxFileMb, maxFilesPerScan: task.maxFilesPerScan, dailyFileLimit: task.dailyFileLimit || 1000,
  } : {
    name: '', kind: 'local', path: '', serverRootId: '',
    folderId: initialFolderId || '', includeSubfolders: true, preserveHierarchy: false,
    schedule: { frequency: 'daily', time: '08:00', timezone: 'Asia/Shanghai', weekday: 0 },
    maxFileMb: bootstrap.maxFileMb || 100, maxFilesPerScan: 1000, dailyFileLimit: 1000,
  })
  const [initial] = useState(() => JSON.stringify(config))
  const [expanded, setExpanded] = useState<Section | null>(null)
  const [pickedName, setPickedName] = useState('')
  const [manualPath, setManualPath] = useState('')
  const [entry, setEntry] = useState<'browse' | 'path'>('browse')
  const [browseRoot, setBrowseRoot] = useState<string | null>(null)
  const [folderQuery, setFolderQuery] = useState('')
  const [showPathError, setShowPathError] = useState(false)
  const [searchResult, setSearchResult] = useState<{ query: string; data?: FolderImportDirectorySearch } | null>(null)
  const serverBrowseTrigger = useRef<HTMLButtonElement>(null)
  const [refreshingRoots, setRefreshingRoots] = useState(false)
  const manualInput = useRef<HTMLInputElement>(null)
  const pickerPending = useRef(false)
  const [more, setMore] = useState(false)
  const [busy, setBusy] = useState<'check' | 'save' | ''>(''), [error, setError] = useState('')
  const [probe, setProbe] = useState<{ signature: string; result: FolderImportProbe } | null>(null)
  const action = useRef(false), alive = useRef(true), pending = useRef<AbortController | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { alive.current = true; return () => { alive.current = false; pending.current?.abort() } }, [])
  useEffect(() => { heading.current?.focus() }, [])
  const target = folders.find(folder => folder.id === config.folderId)
  const root = bootstrap.roots.find(value => value.id === config.serverRootId)
  const chosen = config.kind === 'server' && root ? resolveServerFolder(config.path, bootstrap.roots, root).selection : undefined
  const query = folderQuery.trim()
  const typed = matchServerFolders(query, bootstrap.roots)
  const selection = chosen || typed.complete
  const selectedPath = selection ? serverFolderLocation(selection.root, selection.path) : ''
  const browsedRoot = selection?.root.id === browseRoot ? selection.root : undefined
  const browsing = !!browsedRoot

  const searchName = config.kind === 'server' && bootstrap.roots.length && !query.includes('/') && !typed.error ? query : ''
  useEffect(() => {
    if (!searchName) return
    const controller = new AbortController()
    const timer = window.setTimeout(async () => {
      try {
        const data = await searchFolderImportDirectories(searchName, controller.signal)
        if (!controller.signal.aborted) setSearchResult({ query: searchName, data })
      } catch {
        if (!controller.signal.aborted) setSearchResult({ query: searchName })
      }
    }, 250)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [searchName])
  const result = searchResult?.query === searchName ? searchResult : null
  const matches = [...typed.matches]
  for (const item of result?.data?.directories || []) {
    const matchedRoot = bootstrap.roots.find(candidate => candidate.id === item.rootId)
    if (!matchedRoot || item.path.startsWith('/') || matches.some(match => match.root.id === item.rootId && match.path === item.path)) continue
    const { selection: match } = resolveServerFolder(item.path, bootstrap.roots, matchedRoot)
    if (match) matches.push(match)
  }
  const localPath = entry === 'path' ? manualPath.trim() : ''
  const localName = entry === 'browse' ? pickedName : ''
  const sourceValid = config.kind === 'local' ? !!task || !!localName || fullFolderPath(localPath) : !!selection
  const targetValid = !!target && target.writable !== false
  const normalized = selection ? { ...config, serverRootId: selection.root.id, path: selection.path } : config
  const dirty = JSON.stringify(normalized) !== initial
  const locked = !!busy || !canManage || saved
  const name = config.name.trim() || (config.kind === 'local' ? (localName || localPath.split(/[\\/]/).filter(Boolean).pop() || '我的电脑资料').slice(0, 100) : selection?.path.split('/').filter(Boolean).pop() || selection?.root.name || '服务器资料')
  const value: FolderImportConfig = { ...normalized, name }
  if (!task && config.kind === 'local') {
    value.path = localPath
    value.localFolderName = localName || null
    delete value.serverRootId
  }
  const signature = sourceSignature(value)
  const checked = probe?.signature === signature ? probe.result : null
  const sourceTitle = config.kind === 'local' ? '我的电脑' : root?.name || '请选择扫描文件夹'
  const sourcePath = config.kind === 'local' ? task?.sourcePath || config.path || '连接电脑后选择文件夹' : selectedPath || sourceTitle
  const plan = config.schedule.frequency === 'manual' ? '仅手动扫描' : `${config.schedule.frequency === 'weekly' ? `每${weekdays[config.schedule.weekday]}` : '每天'} ${config.schedule.time}`
  const summary = (section: Section) => section === 'source' ? sourcePath : section === 'destination' ? target ? `${target.name}${target.writable === false ? ' · 无写入权限，请重新选择' : ''}` : '请选择可用的文件夹' : `${plan}${config.schedule.frequency === 'manual' ? '' : ` · ${zoneName(config.schedule.timezone)}`}`
  function update(patch: Partial<FolderImportConfig>) { setConfig(current => ({ ...current, ...patch })); setError('') }
  function changeSource(patch: Partial<FolderImportConfig>) {
    setBrowseRoot(null)
    setFolderQuery('')
    setSearchResult(null)
    setShowPathError(false)
    setProbe(null)
    update({ serverRootId: '', path: '', ...patch })
  }
  function searchFolders(input: string) {
    setFolderQuery(input)
    if (input.trim() !== query) setSearchResult(null)
    setBrowseRoot(null)
    setShowPathError(false)
    setProbe(null)
    update({ serverRootId: '', path: '' })
  }
  function chooseFolder(chosenFolder: ServerSelection) {
    changeSource({ serverRootId: chosenFolder.root.id, path: chosenFolder.path })
  }
  function finishFolderInput(enter = false) {
    if (!query) return
    const searchComplete = !searchName || result?.data && !result.data.truncated
    const folder = typed.complete || (enter && searchComplete && matches.length === 1 ? matches[0] : undefined)
    if (folder) chooseFolder(folder)
    else setShowPathError(true)
  }
  function closeServerPicker() {
    setBrowseRoot(null)
    serverBrowseTrigger.current?.focus({ preventScroll: true })
  }
  async function reloadRoots() {
    if (!onRefreshRoots || refreshingRoots) return
    setRefreshingRoots(true)
    try { await onRefreshRoots() }
    catch (reason) { if (alive.current) setError(sourceError(reason)) }
    finally { if (alive.current) setRefreshingRoots(false) }
  }
  function reveal(section: Section) { setExpanded(section) }
  function enterPath() {
    setEntry('path'); setError('')
    requestAnimationFrame(() => manualInput.current?.focus())
  }
  async function chooseDirectory() {
    if (locked || pickerPending.current) return
    if (!pickerWindow.showDirectoryPicker) {
      enterPath(); setError('当前浏览器无法打开文件夹选择器，请输入完整路径。'); return
    }
    pickerPending.current = true
    try {
      const directory = await pickerWindow.showDirectoryPicker({ mode: 'read' })
      if (alive.current) { setPickedName(directory.name); setEntry('browse'); setError('') }
    } catch (e) {
      if (alive.current && !(typeof e === 'object' && e !== null && 'name' in e && e.name === 'AbortError')) {
        setError('无法打开文件夹选择器，可重试或输入完整路径。')
      }
    } finally { pickerPending.current = false }
  }

  async function verifySource(): Promise<boolean> {
    const abort = new AbortController(); pending.current = abort
    const result = await probeFolderImport(value, abort.signal)
    if (!alive.current || abort.signal.aborted) return false
    setProbe({ signature, result })
    if (!result.valid) { reveal('source'); setError(result.message || '无法访问扫描目录，请检查连接。'); return false }
    return true
  }
  async function check() {
    if (!sourceValid || action.current || !canManage) return
    action.current = true; setBusy('check'); setError('')
    try { await verifySource() }
    catch (e) { if (alive.current) setError(sourceError(e)) }
    finally { action.current = false; if (alive.current) setBusy('') }
  }
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (action.current || !canManage || saved || browsing) return
    if (!sourceValid) { reveal('source'); setError('请选择可用的扫描目录。'); return }
    if (!targetValid) { reveal('destination'); setError('请选择有写入权限的知识库文件夹。'); return }
    if (!Number.isInteger(config.maxFileMb) || config.maxFileMb < 1 || config.maxFileMb > (bootstrap.maxFileMb || 100) || !Number.isInteger(config.maxFilesPerScan) || config.maxFilesPerScan < 1 || config.maxFilesPerScan > 10000 || !Number.isInteger(config.dailyFileLimit) || config.dailyFileLimit < 1 || config.dailyFileLimit > 50000) {
      setMore(true); setError('请检查更多选项中的文件大小、每次扫描和每日处理上限。'); return
    }
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(config.schedule.time)) { reveal('schedule'); setError('请填写有效的扫描时间。'); return }
    action.current = true; setError('')
    try {
      if (config.kind === 'server' && !checked?.valid) {
        setBusy('check')
        try { if (!await verifySource()) return }
        catch (e) { if (alive.current) { reveal('source'); setError(sourceError(e)) }; return }
      }
      if (!alive.current) return
      setBusy('save')
      const result = await saveFolderImport(value, task?.id)
      if (alive.current) await onSaved(result.task)
    } catch (e) { if (alive.current) setError(sourceError(e)) }
    finally { action.current = false; if (alive.current) setBusy('') }
  }

  const sourceFields = <>
    {!task && <div className="kso-setup-choices" role="radiogroup" aria-label="扫描位置">{([
      ['local', '我的电脑', '电脑中的文件夹', <Laptop key="local" />],
      ['server', '服务器 / NAS', '已连接的共享目录', <Server key="server" />],
    ] as const).map(([kind, title, description, icon]) => <label key={kind} className={`kso-setup-choice ${config.kind === kind ? 'selected' : ''}`}><input type="radio" name="import-source" aria-label={title} checked={config.kind === kind} disabled={locked} onChange={() => changeSource({ kind })} />{icon}<span><strong>{title}</strong><small>{description}</small></span><Check className="kso-setup-choice-check" aria-hidden="true" /></label>)}</div>}
    {config.kind === 'local' ? <div className="kso-setup-local">
      {task && <><div className="kso-setup-path"><Laptop /><span>{sourcePath}</span></div><p className="kso-small">{task.connectorOnline ? '电脑已连接。' : '等待电脑连接，上线后自动继续。'}</p></>}
      {task ? <p className="kso-small">更换电脑文件夹，需要重新连接。</p> : <>
        <span className="kso-setup-field-title">电脑上的文件夹</span>
        <div className="kso-setup-picker">
          <button type="button" className="kso-btn" disabled={locked} onClick={() => void chooseDirectory()}><FolderOpen />{localName ? '更换文件夹' : '选择电脑文件夹'}</button>
          {localName && <strong className="kso-setup-selected-folder" role="status">{localName}</strong>}
          {entry !== 'path' && <button type="button" className="kso-btn quiet" disabled={locked} onClick={enterPath}>输入完整路径</button>}
        </div>
        {entry === 'path' && <label className="kso-field kso-local-path-input">本机文件夹完整路径<input ref={manualInput} aria-label="本机文件夹完整路径" value={manualPath} maxLength={1500} disabled={locked} placeholder="例如 /Users/me/Documents/论文 或 D:\论文" autoComplete="off" spellCheck={false} onChange={event => { setManualPath(event.target.value); setError('') }} />{manualPath && !fullFolderPath(localPath) && <small>请输入完整路径，例如 /Users/me/Documents/论文。</small>}</label>}
        <p className="kso-small">定时扫描需要在这台电脑上运行连接程序，并保持开机联网。</p>
      </>}
      {task && onConnect && <button type="button" className="kso-btn" disabled={locked || dirty} onClick={onConnect}>{task.connectorOnline ? '重新连接电脑' : '连接电脑'}</button>}
      {task && dirty && <small>请先保存修改，再连接电脑。</small>}
    </div> : <>
      {task && ['queued', 'scanning', 'transferring', 'processing', 'waiting_quota'].includes(task.status) && <p className="kso-small">当前扫描结束后才能更换来源。保存位置和扫描时间仍可修改。</p>}
      {bootstrap.roots.length ? <>
        <div className="kso-server-source-row">
          <label className="kso-field">扫描文件夹<input disabled={locked || browsing} value={chosen ? selectedPath : folderQuery}
            placeholder="输入文件夹名称或粘贴完整路径" autoComplete="off" spellCheck={false} aria-invalid={showPathError && !!typed.error}
            onChange={event => searchFolders(event.target.value)} onBlur={event => {
              // A suggestion button handles its own selection after the input loses focus.
              if (event.relatedTarget?.closest('.kso-server-children')) return
              finishFolderInput()
            }}
            onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); finishFolderInput(true) } }} /></label>
          <button ref={serverBrowseTrigger} type="button" className="kso-btn" aria-expanded={browsing} disabled={locked || !selection} onClick={() => setBrowseRoot(browsing ? null : selection?.root.id || null)}><FolderOpen />选择服务器文件夹</button>
        </div>
        {!chosen && !browsing && matches.length > 0 && <ul className="kso-server-children" aria-label="匹配的扫描文件夹">
          {matches.map(match => {
            const title = match.path.split('/').pop() || match.root.name
            const location = serverFolderLocation(match.root, match.path)
            const duplicate = matches.some(other => other.root.id !== match.root.id && serverFolderLocation(other.root, other.path) === location)
            return <li key={JSON.stringify([match.root.id, match.path])}><button type="button" disabled={locked} onClick={() => chooseFolder(match)}>
              <FolderOpen aria-hidden="true" /><span><strong>{title}</strong>{(location !== title || duplicate) && <small>{location}{duplicate && ' · ' + match.root.id}</small>}</span>
            </button></li>
          })}
        </ul>}
        {searchName && !result && <p className="kso-small" role="status">正在查找文件夹…</p>}
        {result && !result.data && <p className="kso-small" role="status">暂时无法查找子文件夹，可粘贴完整路径。</p>}
        {result?.data?.truncated && <p className="kso-small">仅显示部分匹配项，可输入更具体的名称或粘贴完整路径。</p>}
        {result?.data && !result.data.truncated && !matches.length && <p className="kso-small" role="status">未找到匹配的扫描文件夹。</p>}
        {showPathError && typed.error && <p className="kso-error" role="alert">{typed.error}</p>}
        {config.serverRootId && !root && <p className="kso-small">目录连接已失效，请重新选择。</p>}
        {browsedRoot && !locked && <ServerFolderPicker key={browsedRoot.id} root={browsedRoot} initialPath={selection?.path || ''} onClose={closeServerPicker} onChoose={path => {
          chooseFolder({ root: browsedRoot, path })
          closeServerPicker()
        }} />}
        {!browsing && <div className="kso-setup-check"><button type="button" className="kso-btn quiet" disabled={locked || !sourceValid} onClick={() => void check()}>{busy === 'check' ? '正在检查…' : '检查目录'}</button><span>保存时会自动检查目录是否可访问。</span></div>}
      </> : <div className="kso-server-empty">
        <strong>尚无已连接目录</strong><p>请管理员将资料目录连接到自动导入服务。连接后可在这里选择要扫描的文件夹。</p>
        {onRefreshRoots && <button type="button" className="kso-btn" disabled={refreshingRoots} onClick={() => void reloadRoots()}>{refreshingRoots ? '正在刷新…' : '刷新目录列表'}</button>}
      </div>}
      {checked?.valid && <FolderImportProbeResult result={checked} />}
    </>}
  </>
  const destinationFields = <>
    {target?.writable === false && <p className="kso-error">当前文件夹无写入权限，请重新选择。</p>}
    <label className="kso-field">{task ? '知识库文件夹' : '拷贝到知识库文件夹'}<select aria-label="自动导入目标文件夹" value={config.folderId} disabled={locked} onChange={event => update({ folderId: event.target.value })}>
      {!target && <option value={config.folderId} disabled>{config.folderId ? '文件夹已不存在，请重新选择' : '请选择知识库文件夹'}</option>}
      {folders.map(folder => <option key={folder.id} value={folder.id} disabled={folder.writable === false}>{folder.name}</option>)}
    </select></label>
    {task && <p className="kso-small">之后导入的资料会保存到此文件夹。</p>}
  </>
  const scheduleFields = <>
    <div className="kso-setup-frequency" role="radiogroup" aria-label="扫描计划">{([['daily', '每天'], ['weekly', '每周'], ['manual', '仅手动']] as const).map(([frequency, label]) => <label key={frequency} className={config.schedule.frequency === frequency ? 'selected' : ''}><input type="radio" name="import-frequency" aria-label={label} checked={config.schedule.frequency === frequency} disabled={locked} onChange={() => update({ schedule: { ...config.schedule, frequency, ...(frequency === 'manual' && !config.schedule.time ? { time: '08:00' } : {}) } })} /><span>{label}</span></label>)}</div>
    {config.schedule.frequency !== 'manual' ? <><div className="kso-setup-time">
      {config.schedule.frequency === 'weekly' && <label className="kso-field">每周<select aria-label="每周扫描日期" disabled={locked} value={config.schedule.weekday} onChange={event => update({ schedule: { ...config.schedule, weekday: Number(event.target.value) } })}>{weekdays.map((day, index) => <option key={day} value={index}>{day}</option>)}</select></label>}
      <label className="kso-field">开始时间<input aria-label="扫描时间" type="time" required disabled={locked} value={config.schedule.time} onChange={event => update({ schedule: { ...config.schedule, time: event.target.value } })} /></label>
    </div><details className="kso-setup-timezone"><summary>{zoneName(config.schedule.timezone)} <ChevronDown /></summary><label className="kso-field">时区<select aria-label="扫描时区" disabled={locked} value={config.schedule.timezone} onChange={event => update({ schedule: { ...config.schedule, timezone: event.target.value } })}>{[...new Set(['Asia/Shanghai', 'Asia/Singapore', 'UTC', config.schedule.timezone])].map(zone => <option key={zone} value={zone}>{zoneName(zone)}</option>)}</select></label></details></> : <p className="kso-small">首次仍会导入现存文件，之后只在点击“立即扫描”时检查更新。</p>}
  </>
  const fields: Record<Section, ReactNode> = { source: sourceFields, destination: destinationFields, schedule: scheduleFields }
  const titles: Record<Section, string> = { source: '扫描文件夹', destination: '保存位置', schedule: '扫描时间' }
  const icons: Record<Section, ReactNode> = { source: config.kind === 'local' ? <Laptop /> : <Server />, destination: <FolderOpen />, schedule: <Clock3 /> }

  return <form noValidate className="kso-import-setup" aria-label={task ? '自动导入设置' : '新建自动导入设置'} onSubmit={event => void submit(event)}>
    <button type="button" className="kso-setup-back" disabled={!!busy} onClick={onClose}><ArrowLeft />{backLabel}</button>
    <header className="kso-setup-heading"><h1 ref={heading} tabIndex={-1}>{task ? task.name : saved ? '自动导入已保存' : '新建自动导入'}</h1>{!saved && <p>{task ? '查看当前设置，点击需要修改的项目。' : '首次导入已有 PDF，之后按计划处理新增或更新的文件。'}</p>}</header>
    {!canManage && <p className="kso-note">当前账号无权修改自动导入设置。</p>}
    <div className={`kso-setup-sheet ${task ? 'editing' : ''}`}>
      {task ? sections.map(section => <section className={`kso-setup-section ${expanded === section ? 'expanded' : ''}`} key={section}>
        <button type="button" className="kso-setup-row" aria-label={`更改${titles[section]}`} aria-expanded={expanded === section} aria-controls={`import-${section}-fields`} disabled={locked} onClick={() => { setBrowseRoot(null); setExpanded(expanded === section ? null : section) }}>
          <span className="kso-setup-row-icon">{icons[section]}</span><span className="kso-setup-row-copy"><span>{titles[section]}</span><strong>{summary(section)}</strong></span><span className="kso-setup-row-action">{expanded === section ? '收起' : '更改'}<ChevronDown /></span>
        </button>
        {expanded === section && <div id={`import-${section}-fields`} className="kso-setup-section-fields">{fields[section]}</div>}
      </section>) : <>
        <section className="kso-create-fields" aria-label="扫描来源"><h2>扫描来源</h2>{sourceFields}</section>
        <section className="kso-create-fields" aria-label="保存位置">{destinationFields}</section>
        <section className="kso-create-fields" aria-label="扫描计划设置"><h2>扫描时间</h2><div className="kso-create-plan">{scheduleFields}</div></section>
      </>}
      <details className="kso-setup-options" open={more} onToggle={event => setMore(event.currentTarget.open)}><summary>更多选项<ChevronDown /></summary><div className="kso-setup-option-fields">
        <label className="kso-field">名称<input aria-label="自动导入名称" maxLength={100} disabled={locked} value={config.name} placeholder={name} onChange={event => update({ name: event.target.value })} /></label>
        <label className="kso-check"><input type="checkbox" checked={config.includeSubfolders} disabled={locked} onChange={event => update({ includeSubfolders: event.target.checked, ...(!event.target.checked ? { preserveHierarchy: false } : {}) })} />包含子文件夹</label>
        <label className="kso-check"><input type="checkbox" checked={config.preserveHierarchy} disabled={locked || !config.includeSubfolders} onChange={event => update({ preserveHierarchy: event.target.checked })} />在知识库中保留子文件夹分类</label>
        <div className="kso-setup-limits"><label className="kso-field">单份 PDF 上限（MB）<input aria-label="自动导入文件大小上限" type="number" min={1} max={bootstrap.maxFileMb || 100} required disabled={locked} value={config.maxFileMb} onChange={event => update({ maxFileMb: Number(event.target.value) })} /></label>
          <label className="kso-field">每次扫描上限（份）<input aria-label="每次扫描处理上限" type="number" min={1} max={10000} required disabled={locked} value={config.maxFilesPerScan} onChange={event => update({ maxFilesPerScan: Number(event.target.value) })} /></label>
          <label className="kso-field">每日处理上限（份）<input aria-label="每日处理上限" type="number" min={1} max={50000} required disabled={locked} value={config.dailyFileLimit} onChange={event => update({ dailyFileLimit: Number(event.target.value) })} /></label></div>
        <p className="kso-small">达到上限后保留进度，下次继续处理。</p>
      </div></details>
    </div>
    {task && <p className="kso-setup-note">归档、解析和问答索引会自动完成。</p>}
    {error && <p className="kso-error kso-setup-error" role="alert">{error}</p>}
    {!saved && <footer className="kso-setup-footer">
      <span className="kso-setup-save-state" role="status">{busy === 'check' ? '正在检查扫描目录…' : busy === 'save' ? '正在保存…' : task && dirty ? '有未保存的修改' : ''}</span>
      <button type="button" className="kso-btn" disabled={!!busy} onClick={onClose}>取消</button>
      <button type="submit" className="kso-btn primary" disabled={locked || browsing || !sourceValid || !targetValid || !!task && !dirty}>{busy ? busy === 'check' ? '正在检查…' : '正在保存…' : task ? '保存设置' : config.kind === 'local' ? '保存并连接电脑' : '开始导入'}</button>
    </footer>}
    {task && onDelete && canManage && <details className="kso-setup-management"><summary>任务管理</summary><button type="button" className="kso-import-delete-link" disabled={!!busy} onClick={onDelete}>删除此自动导入任务</button><p className="kso-small">删除任务只停止扫描，已导入的资料会保留。</p></details>}
  </form>
}
