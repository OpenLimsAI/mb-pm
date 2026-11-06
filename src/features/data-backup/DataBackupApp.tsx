import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Archive, CheckCircle2, Clock3, HardDrive, LoaderCircle, RefreshCw, ShieldCheck, Trash2, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import PortalLayout from '../../components/portal/PortalLayout'
import { usePortalContext } from '../../components/portal/context'
import { accessLost, backupApi, BackupApiError, previewSnapshot, type BackupArchive, type BackupPlan, type BackupSnapshot, type DeletePreview, type PlanRequest } from './api'
import './data-backup.css'

function bytes(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value) || value < 0) return '待确认'
  if (value < 1024) return `${value} B`
  const power = Math.min(4, Math.floor(Math.log(value) / Math.log(1024)))
  return `${(value / 1024 ** power).toFixed(1)} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][power]}`
}
function exactBytes(value: number) { return `${bytes(value)}（${value.toLocaleString('zh-CN')} 字节）` }
function date(value?: string | null) { return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未记录' }
function expired(value: string) { return Date.parse(value) <= Date.now() }
function planDate(value: string | null | undefined, timezone: string) {
  if (!value || !Number.isFinite(Date.parse(value))) return '待确认'
  try { return `${new Date(value).toLocaleString('zh-CN', { hour12: false, timeZone: timezone })}（${timezone}）` } catch { return '待确认' }
}
const states: Record<string, string> = { active: '已启用', disabled: '未启用', conflict: '配置冲突', unknown: '待确认', verified: '已验证', pending: '正在读取清单', unreadable: '无法读取', succeeded: '删除完成', failed: '删除失败', partial: '部分完成', running: '删除中', queued: '等待处理', interrupted: '已中断' }
const contentKinds = { database: '数据库', files: '业务文件', configuration: '配置' }
const statusText = (value: string) => states[value] || '待确认'
const errorText = (error: unknown) => error instanceof Error ? error.message : '请求未完成，请刷新状态后重试。'
interface Confirmation { preview: DeletePreview; requestId: string; revision: string }

export default function DataBackupApp() {
  const { user, applications, preview, logout, identityNamespace } = usePortalContext()
  const allowed = applications.some(app => app.id === 'data-backup' && app.enabled)
  return <PortalLayout user={user} logout={logout} preview={preview}>
    <BackupWorkspace key={`${identityNamespace || user.id}:${user.id}:${allowed}:${preview}`} identity={user.id} allowed={allowed} preview={preview} />
  </PortalLayout>
}

export function BackupWorkspace({ identity, allowed, preview }: { identity: string; allowed: boolean; preview: boolean }) {
  const [snapshot, setSnapshot] = useState<BackupSnapshot | null>(preview ? previewSnapshot : null)
  const [loading, setLoading] = useState(!preview && allowed), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [blocked, setBlocked] = useState(false), [busy, setBusy] = useState(false)
  const [selection, setSelection] = useState<string[]>([]), [dialog, setDialog] = useState<Confirmation | null>(null)
  const [rootFilter, setRootFilter] = useState(''), [query, setQuery] = useState(''), [statusFilter, setStatusFilter] = useState('')
  const [planDraft, setPlanDraft] = useState<PlanRequest | null>(null)
  const filesRef = useRef<HTMLElement>(null)
  const life = useRef<AbortController | null>(null), polling = useRef(false), mutation = useRef(false), planSaving = useRef(false), sequence = useRef(0), revoked = useRef(false)
  const catalog = useRef<BackupSnapshot | null>(null), selected = useRef<string[]>([]), previewGeneration = useRef(0)
  function select(ids: string[]) { if (ids.length > 100) { setNotice('每次最多选择 100 份备份，请分批操作。'); return }; selected.current = ids; setSelection(ids) }
  const handleFailure = useCallback((failure: unknown) => {
    if (accessLost(failure)) {
      revoked.current = true; life.current?.abort(); catalog.current = null; selected.current = []; sequence.current++; previewGeneration.current++
      setBlocked(true); setSnapshot(null); setDialog(null); setSelection([]); setPlanDraft(null); setNotice('')
    }
    setError(errorText(failure))
  }, [])
  const refresh = useCallback(async () => {
    const controller = life.current
    if (preview || !allowed || revoked.current || !controller || controller.signal.aborted || polling.current || planSaving.current) return
    polling.current = true
    const generation = ++sequence.current
    try {
      const data = await backupApi.snapshot(identity, controller.signal)
      if (!controller.signal.aborted && !revoked.current && sequence.current === generation) {
        if (catalog.current && catalog.current.catalogRevision !== data.catalogRevision) {
          if (selected.current.length) setNotice('备份目录已更新，请重新选择文件并确认删除清单。')
          selected.current = []; setSelection([]); setDialog(null); previewGeneration.current++
        }
        if (catalog.current && catalog.current.plan.revision !== data.plan.revision) {
          setPlanDraft(null); setNotice('备份计划已更新，请重新打开编辑并核对计划。')
        }
        catalog.current = data; setSnapshot(data); setError('')
      }
    } catch (failure) {
      if (!controller.signal.aborted && sequence.current === generation) handleFailure(failure)
    } finally {
      if (!controller.signal.aborted) { polling.current = false; setLoading(false) }
    }
  }, [preview, allowed, identity, handleFailure])
  useEffect(() => {
    const controller = new AbortController(); life.current = controller; polling.current = false
    void Promise.resolve().then(() => { if (!controller.signal.aborted) void refresh() })
    return () => controller.abort()
  }, [refresh])
  const indexing = snapshot?.archives.some(archive => archive.status === 'pending') ?? false
  useEffect(() => {
    if (preview || !allowed || blocked) return
    const tick = () => { if (document.visibilityState !== 'hidden') void refresh() }
    const timer = window.setInterval(tick, indexing ? 5000 : 30000)
    document.addEventListener('visibilitychange', tick)
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', tick) }
  }, [preview, allowed, blocked, indexing, refresh])
  const connected = !preview && allowed && !blocked && snapshot?.connected === true
  const writable = connected && !error && !busy
  function clearSelection() { select([]); setDialog(null); previewGeneration.current++ }
  function chooseRoot(id: string) {
    clearSelection(); setRootFilter(id)
    filesRef.current?.scrollIntoView?.({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' })
  }
  function clearFilters() { clearSelection(); setRootFilter(''); setQuery(''); setStatusFilter('') }
  async function savePlan(body: PlanRequest) {
    const controller = life.current, current = catalog.current
    if (!writable || mutation.current || !controller || controller.signal.aborted || !current?.plan.editable || body.revision !== current.plan.revision) return
    mutation.current = true; planSaving.current = true; sequence.current++; setBusy(true); setError(''); setNotice(''); clearSelection()
    let refreshAfter = false
    try {
      const plan = await backupApi.updatePlan(identity, body, controller.signal)
      if (controller.signal.aborted || revoked.current) return
      catalog.current = { ...current, plan }; setSnapshot(previous => previous ? { ...previous, plan } : previous)
      setPlanDraft(null); setNotice(body.enabled ? '每日备份计划已保存，服务器将按新计划执行。' : '每日备份计划已暂停。'); refreshAfter = true
    } catch (failure) {
      if (!controller.signal.aborted) {
        handleFailure(failure)
        if (failure instanceof BackupApiError && failure.status === 409 && !accessLost(failure)) {
          setPlanDraft(null); setNotice('备份计划可能已变化，正在重新读取实际状态，请核对后再编辑。'); refreshAfter = true
        }
      }
    } finally {
      if (!controller.signal.aborted) { mutation.current = false; planSaving.current = false; setBusy(false); if (refreshAfter) void refresh() }
    }
  }
  async function openDeletion(ids: string[]) {
    const controller = life.current, current = catalog.current
    if (!connected || busy || mutation.current || !controller || !current || controller.signal.aborted || !ids.length) return
    if (ids.some(id => !visibleArchives.some(archive => archive.id === id && !archive.protected))) return
    const generation = ++previewGeneration.current, revision = current.catalogRevision
    mutation.current = true; setBusy(true); setNotice(''); setError(''); select(ids)
    try {
      const result = await backupApi.previewDeletion(identity, ids, revision, controller.signal)
      if (controller.signal.aborted || revoked.current || generation !== previewGeneration.current || catalog.current?.catalogRevision !== revision) return
      setDialog({ preview: result, revision, requestId: crypto.randomUUID() })
    } catch (failure) {
      if (!controller.signal.aborted) { handleFailure(failure); if (failure instanceof BackupApiError && failure.status === 409 && !accessLost(failure)) { setNotice(`${failure.message} 请刷新清单后重新选择。`); void refresh() } }
    } finally { if (!controller.signal.aborted) { mutation.current = false; setBusy(false) } }
  }
  async function submitDeletion(confirmation: string) {
    const controller = life.current
    if (!connected || mutation.current || !controller || controller.signal.aborted || !dialog || dialog.revision !== catalog.current?.catalogRevision || expired(dialog.preview.expiresAt) || confirmation !== `删除 ${dialog.preview.itemCount} 份备份`) return
    mutation.current = true; sequence.current++; setBusy(true); setError('')
    try {
      const receipt = await backupApi.deleteArchives(identity, { token: dialog.preview.token, confirmation, requestId: dialog.requestId }, controller.signal)
      if (controller.signal.aborted || revoked.current) return
      setSnapshot(previous => previous ? { ...previous, deletions: [receipt, ...previous.deletions.filter(entry => entry.id !== receipt.id)] } : previous)
      setDialog(null); select([])
      setNotice(receipt.error ? `${statusText(receipt.status)}：${receipt.error}` : `本次删除结果：${statusText(receipt.status)}，已删除 ${receipt.deletedCount} 份备份，合计 ${bytes(receipt.deletedBytes)}。`)
      void refresh()
    } catch (failure) {
      if (!controller.signal.aborted) {
        handleFailure(failure)
        if (failure instanceof BackupApiError && failure.status === 409 && !accessLost(failure)) { setDialog(null); select([]); setNotice(`${failure.message} 请重新选择备份。`); void refresh() }
      }
    } finally { if (!controller.signal.aborted) { mutation.current = false; setBusy(false) } }
  }
  const root = snapshot?.roots.find(item => item.id === rootFilter)
  const search = query.trim().toLocaleLowerCase()
  const visibleArchives = snapshot?.archives.filter(archive => {
    const matchesRoot = !rootFilter || (archive.rootId ? archive.rootId === rootFilter : root && snapshot.roots.filter(item => item.label === root.label).length === 1 && archive.rootLabel === root.label)
    return matchesRoot && (!statusFilter || archive.status === statusFilter) && (!search || [archive.name, archive.rootLabel, ...archive.contents.flatMap(item => [item.name, item.detail])].join(' ').toLocaleLowerCase().includes(search))
  }) || []
  const filtered = !!(rootFilter || query || statusFilter)
  const available = visibleArchives.filter(archive => !archive.protected).map(archive => archive.id)
  const selectAllIds = available.slice(0, 100)
  const selectedArchives = snapshot?.archives.filter(archive => selection.includes(archive.id)) || []
  const latest = snapshot?.archives.filter(archive => archive.status === 'verified').sort((a, b) => (Date.parse(b.createdAt || '') || 0) - (Date.parse(a.createdAt || '') || 0))[0]
  return <div className="backup-app">
    <div className="backup-heading"><div><div className="workspace-section-label">DATA MANAGEMENT</div><h1><Archive aria-hidden="true" />数据备份</h1><p>查看实际备份计划、文件内容和磁盘占用，按需清理已确认的备份。</p></div><button className="backup-btn" disabled={preview || !allowed || blocked || loading || busy} onClick={() => void refresh()}><RefreshCw size={16} aria-hidden="true" />刷新状态</button></div>
    {preview && <div className="backup-banner" role="status">界面预览 · 下方文件均为虚构示例，不是服务器备份。预览不读取实际计划和容量，也不能保存计划或执行删除。</div>}
    {error && <div className="backup-banner warning" role="alert">{error}{blocked ? <Link to="/">返回应用工作台</Link> : <button className="backup-btn" disabled={busy} onClick={() => void refresh()}>重新读取状态</button>}</div>}
    {notice && <p role="status" className="backup-banner">{notice}</p>}
    {!preview && (!allowed || blocked) ? <section className="backup-panel backup-empty"><ShieldCheck aria-hidden="true" /><h2>仅系统管理员可管理数据备份</h2><p>请返回工作台刷新当前账号权限。</p><Link to="/">返回应用工作台</Link></section> : loading ? <section className="backup-panel backup-empty" aria-busy="true"><LoaderCircle aria-hidden="true" /><p>正在读取服务器备份状态…</p></section> : !snapshot ? <section className="backup-panel backup-empty"><h2>尚未获取备份状态</h2><p>当前无法确认备份是否成功，请恢复连接后重新读取。</p></section> : <>
      {!!snapshot.alerts.length && <section className="backup-banner warning" aria-label="备份提醒"><strong>需要关注</strong><ul>{snapshot.alerts.map((item, index) => <li key={index}>{item}</li>)}</ul></section>}
      <div className="backup-metrics">
        <Metric icon={<HardDrive aria-hidden="true" />} title="备份总磁盘占用" value={bytes(snapshot.storage.backupBytes)} detail={`归档文件大小 ${bytes(snapshot.storage.archiveBytes)} · 其他材料占盘 ${bytes(snapshot.storage.otherBytes)}`} />
        <Metric icon={<HardDrive aria-hidden="true" />} title="服务器剩余空间" value={bytes(snapshot.storage.freeBytes)} detail={`磁盘总容量 ${bytes(snapshot.storage.totalBytes)}`} />
        <Metric icon={<CheckCircle2 aria-hidden="true" />} title="最近已验证备份" value={preview ? '预览未读取' : latest ? date(latest.createdAt) : '暂无已验证记录'} detail={latest && !preview ? `文件大小 ${bytes(latest.sizeBytes)}` : '以服务器的验证记录为准'} />
      </div>
      <section className="backup-panel backup-plan" aria-labelledby="backup-plan-title">
        <div className="backup-panel-heading"><div><h2 id="backup-plan-title"><Clock3 size={18} aria-hidden="true" />实际备份计划</h2><p>查看并调整服务器每日备份时间。</p></div><div className="backup-row-actions"><span className={`backup-badge ${['unknown', 'conflict'].includes(snapshot.plan.status) ? 'warning' : ''}`}>{statusText(snapshot.plan.status)}</span>{snapshot.plan.editable && snapshot.plan.dailyTime && snapshot.plan.revision && ['active', 'disabled'].includes(snapshot.plan.status) && !planDraft && <button className="backup-btn" disabled={!writable} onClick={() => setPlanDraft({ dailyTime: snapshot.plan.dailyTime!, enabled: snapshot.plan.status === 'active', revision: snapshot.plan.revision! })}>修改每日计划</button>}</div></div>
        <p className="backup-plan-summary">{snapshot.plan.summary || '未获取到可确认的计划，请检查服务器配置。'}</p><p>{snapshot.plan.retentionSummary || '保留规则尚未确认。'}</p>
        <p className="backup-next-run">预计下次执行：{snapshot.plan.status === 'disabled' ? '计划已暂停' : planDate(snapshot.plan.nextRunAt, snapshot.plan.timezone)}</p>
        {!snapshot.plan.editable && <p className="backup-muted">{preview ? '预览不读取或修改服务器计划。' : snapshot.plan.editReason || '当前备份服务未开放计划编辑，请联系管理员检查服务器配置。'}</p>}
        {planDraft && <PlanEditor draft={planDraft} plan={snapshot.plan} disabled={!writable} busy={busy} onChange={setPlanDraft} onCancel={() => setPlanDraft(null)} onSave={() => void savePlan(planDraft)} />}
        <div className="backup-plan-meta"><span>来源：{snapshot.plan.source === 'cron' ? '服务器定时任务（Cron）' : snapshot.plan.source || '待确认'}</span><span>执行时区：{snapshot.plan.timezone || '待确认'}</span><span>检查时间：{date(snapshot.plan.checkedAt)}</span></div>
      </section>
      {!!snapshot.roots.length && <section className="backup-panel"><div className="backup-panel-heading"><div><h2>备份存储分布</h2><p>点击分类查看下方备份文件。磁盘占用包含实际分配的空间；其他材料仅统计。</p></div><button className="backup-btn" disabled={busy} aria-pressed={!rootFilter} aria-controls="backup-files" onClick={() => chooseRoot('')}>所有分类</button></div><div className="backup-roots">{snapshot.roots.map(item => <button type="button" key={item.id} className={`backup-root ${rootFilter === item.id ? 'selected' : ''}`} disabled={busy} aria-label={`筛选分类：${item.label}`} aria-pressed={rootFilter === item.id} aria-controls="backup-files" onClick={() => chooseRoot(rootFilter === item.id ? '' : item.id)}><strong>{item.label}</strong><span>{item.archiveCount} 份备份</span><dl><div><dt>目录文件总大小</dt><dd>{bytes(item.sizeBytes)}</dd></div><div><dt>目录总占盘</dt><dd>{bytes(item.diskBytes)}</dd></div><div><dt>其中其他材料占盘</dt><dd>{bytes(item.otherBytes)}</dd></div></dl></button>)}</div></section>}
      <section className="backup-panel backup-files" ref={filesRef} id="backup-files" aria-labelledby="backup-files-title"><div className="backup-panel-heading"><div><h2 id="backup-files-title">备份文件 <span className="backup-count">{visibleArchives.length} / {snapshot.archives.length}</span></h2><p>展开文件查看数据范围。受保护的备份不可删除；每次最多选择 100 份，确认清单后删除。</p></div><button className="backup-btn danger" disabled={!writable || !selection.length} onClick={() => void openDeletion(selection)}><Trash2 size={15} aria-hidden="true" />删除所选{selection.length ? `（${selection.length}）` : ''}</button></div>
        <div className="backup-filters">
          <label>分类<select value={rootFilter} disabled={busy} onChange={event => { clearSelection(); setRootFilter(event.target.value) }}><option value="">所有分类</option>{snapshot.roots.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
          <label className="backup-search">搜索备份<input type="search" placeholder="文件名或备份内容" value={query} disabled={busy} onChange={event => { clearSelection(); setQuery(event.target.value) }} /></label>
          <label>验证状态<select value={statusFilter} disabled={busy} onChange={event => { clearSelection(); setStatusFilter(event.target.value) }}><option value="">全部状态</option><option value="verified">已验证</option><option value="pending">正在读取清单</option><option value="unreadable">无法读取</option><option value="unknown">待确认</option></select></label>
          {filtered && <button className="backup-btn" disabled={busy} onClick={clearFilters}>清除筛选</button>}
        </div>
        <p className="backup-muted" role="status">{root ? `当前分类：${root.label} · ` : ''}显示 {visibleArchives.length} 份，共 {snapshot.archives.length} 份备份。</p>
        {root && snapshot.archives.some(archive => !archive.rootId && archive.rootLabel === root.label) && snapshot.roots.filter(item => item.label === root.label).length > 1 && <p className="backup-muted">部分旧记录缺少分类标识，无法区分同名分类；请更新备份服务后查看，或清除分类筛选。</p>}
        {!!selection.length && <div className="backup-selection" role="status">已选择 {selection.length} 份 · 文件大小 {bytes(selectedArchives.reduce((sum, item) => sum + item.sizeBytes, 0))} · 磁盘占用 {bytes(selectedArchives.reduce((sum, item) => sum + item.diskBytes, 0))}<button className="backup-link" disabled={busy} onClick={() => select([])}>取消选择</button></div>}
        {indexing && <p className="backup-muted" role="status">正在读取备份内容清单，每 5 秒更新一次。清单尚未确认的文件会保留其保护状态。</p>}
        <div className="backup-table-wrap"><table className="backup-table"><thead><tr><th className="backup-select-cell"><input type="checkbox" aria-label={available.length > 100 ? '选择前 100 份可删除备份' : '选择所有可删除备份'} disabled={!writable || !available.length} checked={!!selectAllIds.length && selectAllIds.every(id => selection.includes(id))} onChange={event => select(event.target.checked ? selectAllIds : [])} /></th><th>备份文件与内容</th><th>文件 / 磁盘占用</th><th>操作</th></tr></thead><tbody>{visibleArchives.map(archive => <ArchiveRow key={archive.id} archive={archive} disabled={!writable} selected={selection.includes(archive.id)} onSelect={checked => select(checked ? [...selection, archive.id] : selection.filter(id => id !== archive.id))} onDelete={() => void openDeletion([archive.id])} />)}</tbody></table></div>{!visibleArchives.length && <div className="backup-empty" role="status"><p>{filtered ? root && !query && !statusFilter ? `“${root.label}”分类暂无备份文件。` : '没有符合筛选条件的备份文件。' : '还没有可确认的备份文件。'}</p>{filtered && <button className="backup-btn" disabled={busy} onClick={clearFilters}>查看全部备份</button>}</div>}
      </section>
      <section className="backup-panel"><div className="backup-panel-heading"><div><h2>删除记录</h2><p>记录实际删除结果，操作失败的文件不会计入已删除数量。</p></div></div><div className="backup-deletions">{snapshot.deletions.map(receipt => <article key={receipt.id}><div><strong>{statusText(receipt.status)}</strong><span>已删除 {receipt.deletedCount} 份 · {bytes(receipt.deletedBytes)}</span></div><small>{date(receipt.createdAt)} · 操作人：{receipt.actor}</small>{receipt.error && <p className="backup-error">{receipt.error}</p>}</article>)}{!snapshot.deletions.length && <p className="backup-muted">暂无删除记录。</p>}</div></section>
      <p className="backup-muted backup-updated">状态更新时间：{date(snapshot.generatedAt)} · 常规每 30 秒更新，页面隐藏时暂停。记录时间按浏览器当前时区显示。</p>
    </>}
    {dialog && !blocked && <DeleteDialog confirmation={dialog} busy={busy} error={error} onClose={() => setDialog(null)} onSubmit={submitDeletion} onRefresh={() => { const ids = dialog.preview.items.map(item => item.id); setDialog(null); void openDeletion(ids) }} />}
  </div>
}
function PlanEditor({ draft, plan, disabled, busy, onChange, onCancel, onSave }: { draft: PlanRequest; plan: BackupPlan; disabled: boolean; busy: boolean; onChange: (value: PlanRequest) => void; onCancel: () => void; onSave: () => void }) {
  const valid = /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(draft.dailyTime)
  const unchanged = draft.dailyTime === plan.dailyTime && draft.enabled === (plan.status === 'active')
  return <form className="backup-plan-editor" aria-label="编辑每日备份计划" onSubmit={event => { event.preventDefault(); if (!disabled && valid && !unchanged) onSave() }}>
    <div className="backup-plan-fields"><label>每日执行时间<input type="time" required step="60" value={draft.dailyTime} disabled={busy} onChange={event => onChange({ ...draft, dailyTime: event.target.value })} /></label><label className="backup-plan-enabled"><input type="checkbox" checked={draft.enabled} disabled={busy} onChange={event => onChange({ ...draft, enabled: event.target.checked })} />启用每日备份</label></div>
    <p className="backup-muted">时间按 {plan.timezone || '服务器执行时区'} 执行。备份期间可能短暂暂停业务写入，请选择业务空闲时段。</p>
    {!draft.enabled && <p className="backup-error">暂停后不会自动创建每日备份，已有备份仍会保留。</p>}
    <div className="backup-row-actions"><button className="backup-btn primary" type="submit" disabled={disabled || !valid || unchanged || draft.revision !== plan.revision}>{busy ? '正在保存…' : '保存计划'}</button><button className="backup-btn" type="button" disabled={busy} onClick={onCancel}>取消修改</button></div>
  </form>
}
function Metric({ title, value, detail, icon }: { title: string; value: string; detail: string; icon: ReactNode }) { return <section className="backup-panel backup-metric"><div>{icon}<h2>{title}</h2></div><strong>{value}</strong><p>{detail}</p></section> }
function ArchiveRow({ archive, disabled, selected, onSelect, onDelete }: { archive: BackupArchive; disabled: boolean; selected: boolean; onSelect: (value: boolean) => void; onDelete: () => void }) {
  return <tr className={selected ? 'selected' : ''}><td className="backup-select-cell"><input type="checkbox" aria-label={`选择 ${archive.name}`} disabled={disabled || archive.protected} checked={selected} onChange={event => onSelect(event.target.checked)} /></td><td><strong>{archive.name}</strong><small>{archive.rootLabel} · {date(archive.createdAt)}</small><span className={`backup-badge ${archive.status === 'unreadable' ? 'warning' : ''}`}>{statusText(archive.status)}</span>{archive.protected && <span className="backup-protection"><ShieldCheck size={13} aria-hidden="true" />{archive.protectionReason || '该备份受保护，不能删除。'}</span>}<details><summary>查看备份内容{archive.contents.length ? `（${archive.contents.length} 项）` : ''}</summary>{archive.contents.length ? <ul className="backup-contents">{archive.contents.map((item, index) => <li key={index}><span className="backup-badge">{contentKinds[item.kind]}</span><strong>{item.name}</strong><p>{item.detail}</p></li>)}</ul> : <p>{archive.status === 'pending' ? '正在读取清单，请稍后查看。' : '尚无可确认的内容清单，不能据此认定已包含全部业务数据。'}</p>}<p className="backup-muted">验证时间：{date(archive.verifiedAt)}</p></details></td><td className="backup-size-cell"><strong title={`${archive.sizeBytes.toLocaleString('zh-CN')} 字节`}>{bytes(archive.sizeBytes)}</strong><small>占磁盘 {bytes(archive.diskBytes)}</small></td><td><button className="backup-btn danger compact" disabled={disabled || archive.protected} aria-label={`删除 ${archive.name}`} onClick={onDelete}><Trash2 size={14} aria-hidden="true" />删除</button></td></tr>
}
function DeleteDialog({ confirmation: data, busy, error, onClose, onSubmit, onRefresh }: { confirmation: Confirmation; busy: boolean; error: string; onClose: () => void; onSubmit: (confirmation: string) => Promise<void>; onRefresh: () => void }) {
  const [confirmation, setConfirmation] = useState(''), [now, setNow] = useState(Date.now)
  const ref = useRef<HTMLDivElement>(null), required = `删除 ${data.preview.itemCount} 份备份`, expired = now >= Date.parse(data.preview.expiresAt)
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    ref.current?.querySelector<HTMLElement>('input')?.focus()
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => { window.clearInterval(timer); before?.focus() }
  }, [])
  return <div className="backup-modal-shade"><div ref={ref} className="backup-dialog" role="dialog" aria-modal="true" aria-labelledby="backup-confirm-title" onKeyDown={event => {
    if (event.key === 'Escape' && !busy) { event.stopPropagation(); onClose() }
    if (event.key === 'Tab') { const nodes = [...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)') ?? [])]; const first = nodes[0], last = nodes.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() } }
  }}><div className="backup-panel-heading"><h2 id="backup-confirm-title">确认删除备份</h2><button className="backup-btn" aria-label="关闭确认窗口" disabled={busy} onClick={onClose}><X size={16} /></button></div>
    <p>仅删除以下备份文件，不删除当前业务数据。备份文件删除后无法撤销，请核对清单。</p><ul className="backup-delete-list">{data.preview.items.map(item => <li key={item.id}><strong>{item.name}</strong><span>{item.rootLabel}</span><small>文件 {exactBytes(item.sizeBytes)} · 磁盘 {exactBytes(item.diskBytes)}</small></li>)}</ul>
    <div className="backup-delete-total"><strong>共 {data.preview.itemCount} 份备份</strong><span>文件大小：{exactBytes(data.preview.sizeBytes)}</span><span>磁盘占用：{exactBytes(data.preview.diskBytes)}</span></div>
    {error && <p role="alert" className="backup-error">{error}</p>}{expired ? <p role="alert" className="backup-error">删除预览已过期，请重新核对清单后确认。</p> : <p className="backup-muted">本次确认有效至 {date(data.preview.expiresAt)}。</p>}
    <form onSubmit={event => { event.preventDefault(); if (!busy && !expired && confirmation === required) void onSubmit(confirmation) }}><label className="backup-confirm-field">请输入“{required}”确认<input aria-label="删除确认文字" autoComplete="off" value={confirmation} disabled={busy || expired} onChange={event => setConfirmation(event.target.value)} /></label><div className="backup-row-actions"><button type="button" className="backup-btn" disabled={busy} onClick={onClose}>取消</button>{expired ? <button type="button" className="backup-btn" disabled={busy} onClick={onRefresh}>重新核对清单</button> : <button type="submit" className="backup-btn danger-primary" disabled={busy || confirmation !== required}>{busy ? '正在删除…' : '确认删除'}</button>}</div></form>
  </div></div>
}
