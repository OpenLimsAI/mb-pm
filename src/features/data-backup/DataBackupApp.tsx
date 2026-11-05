import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Archive, CheckCircle2, Clock3, HardDrive, LoaderCircle, RefreshCw, ShieldCheck, Trash2, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import PortalLayout from '../../components/portal/PortalLayout'
import { usePortalContext } from '../../components/portal/context'
import { accessLost, backupApi, BackupApiError, previewSnapshot, type BackupArchive, type BackupSnapshot, type DeletePreview } from './api'
import './data-backup.css'

function bytes(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value) || value < 0) return '待确认'
  if (value < 1024) return `${value} B`
  const power = Math.min(4, Math.floor(Math.log(value) / Math.log(1024)))
  return `${(value / 1024 ** power).toFixed(1)} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][power]}`
}
function exactBytes(value: number) { return `${bytes(value)}（${value.toLocaleString('zh-CN')} 字节）` }
function date(value?: string | null) { return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未记录' }
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
  const life = useRef<AbortController | null>(null), polling = useRef(false), mutation = useRef(false), sequence = useRef(0), revoked = useRef(false)
  const catalog = useRef<BackupSnapshot | null>(null), selected = useRef<string[]>([]), previewGeneration = useRef(0)
  function select(ids: string[]) { if (ids.length > 100) { setNotice('每次最多选择 100 份备份，请分批操作。'); return }; selected.current = ids; setSelection(ids) }
  const handleFailure = useCallback((failure: unknown) => {
    if (accessLost(failure)) {
      revoked.current = true; life.current?.abort(); catalog.current = null; selected.current = []; sequence.current++; previewGeneration.current++
      setBlocked(true); setSnapshot(null); setDialog(null); setSelection([]); setNotice('')
    }
    setError(errorText(failure))
  }, [])
  const refresh = useCallback(async () => {
    const controller = life.current
    if (preview || !allowed || revoked.current || !controller || controller.signal.aborted || polling.current) return
    polling.current = true
    const generation = ++sequence.current
    try {
      const data = await backupApi.snapshot(identity, controller.signal)
      if (!controller.signal.aborted && !revoked.current && sequence.current === generation) {
        if (catalog.current && catalog.current.catalogRevision !== data.catalogRevision) {
          if (selected.current.length) setNotice('备份目录已更新，请重新选择文件并确认删除清单。')
          selected.current = []; setSelection([]); setDialog(null); previewGeneration.current++
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
  async function openDeletion(ids: string[]) {
    const controller = life.current, current = catalog.current
    if (!connected || busy || mutation.current || !controller || !current || controller.signal.aborted || !ids.length) return
    if (ids.some(id => !current.archives.some(archive => archive.id === id && !archive.protected))) return
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
    if (!connected || mutation.current || !controller || controller.signal.aborted || !dialog || dialog.revision !== catalog.current?.catalogRevision || Date.parse(dialog.preview.expiresAt) <= Date.now() || confirmation !== `删除 ${dialog.preview.itemCount} 份备份`) return
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
  const available = snapshot?.archives.filter(archive => !archive.protected).map(archive => archive.id) || []
  const selectAllIds = available.slice(0, 100)
  const selectedArchives = snapshot?.archives.filter(archive => selection.includes(archive.id)) || []
  const latest = snapshot?.archives.filter(archive => archive.status === 'verified').sort((a, b) => (Date.parse(b.createdAt || '') || 0) - (Date.parse(a.createdAt || '') || 0))[0]
  return <div className="backup-app">
    <div className="backup-heading"><div><div className="workspace-section-label">DATA MANAGEMENT</div><h1><Archive aria-hidden="true" />数据备份</h1><p>查看实际备份计划、文件内容和磁盘占用，按需清理已确认的备份。</p></div><button className="backup-btn" disabled={preview || !allowed || blocked || loading || busy} onClick={() => void refresh()}><RefreshCw size={16} aria-hidden="true" />刷新状态</button></div>
    {preview && <div className="backup-banner" role="status">界面预览 · 下方文件均为虚构示例，不是服务器备份。预览不读取实际计划和容量，也不能执行删除。</div>}
    {error && <div className="backup-banner warning" role="alert">{error}{blocked ? <Link to="/">返回应用工作台</Link> : <button className="backup-btn" disabled={busy} onClick={() => void refresh()}>重新读取状态</button>}</div>}
    {notice && <p role="status" className="backup-banner">{notice}</p>}
    {!preview && (!allowed || blocked) ? <section className="backup-panel backup-empty"><ShieldCheck aria-hidden="true" /><h2>仅系统管理员可管理数据备份</h2><p>请返回工作台刷新当前账号权限。</p><Link to="/">返回应用工作台</Link></section> : loading ? <section className="backup-panel backup-empty" aria-busy="true"><LoaderCircle aria-hidden="true" /><p>正在读取服务器备份状态…</p></section> : !snapshot ? <section className="backup-panel backup-empty"><h2>尚未获取备份状态</h2><p>当前无法确认备份是否成功，请恢复连接后重新读取。</p></section> : <>
      {!!snapshot.alerts.length && <section className="backup-banner warning" aria-label="备份提醒"><strong>需要关注</strong><ul>{snapshot.alerts.map((item, index) => <li key={index}>{item}</li>)}</ul></section>}
      <div className="backup-metrics">
        <Metric icon={<HardDrive aria-hidden="true" />} title="备份总磁盘占用" value={bytes(snapshot.storage.backupBytes)} detail={`备份归档 ${bytes(snapshot.storage.archiveBytes)} · 其他备份材料 ${bytes(snapshot.storage.otherBytes)}`} />
        <Metric icon={<HardDrive aria-hidden="true" />} title="服务器剩余空间" value={bytes(snapshot.storage.freeBytes)} detail={`磁盘总容量 ${bytes(snapshot.storage.totalBytes)}`} />
        <Metric icon={<CheckCircle2 aria-hidden="true" />} title="最近已验证备份" value={preview ? '预览未读取' : latest ? date(latest.createdAt) : '暂无已验证记录'} detail={latest && !preview ? `文件大小 ${bytes(latest.sizeBytes)}` : '以服务器的验证记录为准'} />
      </div>
      <section className="backup-panel backup-plan" aria-labelledby="backup-plan-title"><div className="backup-panel-heading"><div><h2 id="backup-plan-title"><Clock3 size={18} aria-hidden="true" />实际备份计划</h2><p>根据服务器当前计划读取，只在此查看。</p></div><span className={`backup-badge ${['unknown', 'conflict'].includes(snapshot.plan.status) ? 'warning' : ''}`}>{statusText(snapshot.plan.status)}</span></div><p className="backup-plan-summary">{snapshot.plan.summary || '未获取到可确认的计划，请检查服务器配置。'}</p><p>{snapshot.plan.retentionSummary || '保留规则尚未确认。'}</p><div className="backup-plan-meta"><span>来源：{snapshot.plan.source === 'cron' ? '服务器定时任务（Cron）' : snapshot.plan.source || '待确认'}</span><span>执行时区：{snapshot.plan.timezone || '待确认'}</span><span>检查时间：{date(snapshot.plan.checkedAt)}</span></div></section>
      {!!snapshot.roots.length && <section className="backup-panel"><div className="backup-panel-heading"><div><h2>备份存储分布</h2><p>磁盘占用包含文件实际分配的空间；其他材料仅统计，不在此删除。</p></div></div><div className="backup-roots">{snapshot.roots.map(root => <article key={root.id}><strong>{root.label}</strong><span>{root.archiveCount} 份备份</span><dl><div><dt>归档文件大小</dt><dd>{bytes(root.sizeBytes)}</dd></div><div><dt>归档磁盘占用</dt><dd>{bytes(root.diskBytes)}</dd></div><div><dt>其他材料占用</dt><dd>{bytes(root.otherBytes)}</dd></div></dl></article>)}</div></section>}
      <section className="backup-panel"><div className="backup-panel-heading"><div><h2>备份文件 <span className="backup-count">{snapshot.archives.length}</span></h2><p>展开文件查看数据范围。受保护的备份不可删除；每次最多选择 100 份，确认清单后删除。</p></div><button className="backup-btn danger" disabled={!writable || !selection.length} onClick={() => void openDeletion(selection)}><Trash2 size={15} aria-hidden="true" />删除所选{selection.length ? `（${selection.length}）` : ''}</button></div>
        {!!selection.length && <div className="backup-selection" role="status">已选择 {selection.length} 份 · 文件大小 {bytes(selectedArchives.reduce((sum, item) => sum + item.sizeBytes, 0))} · 磁盘占用 {bytes(selectedArchives.reduce((sum, item) => sum + item.diskBytes, 0))}<button className="backup-link" disabled={busy} onClick={() => select([])}>取消选择</button></div>}
        {indexing && <p className="backup-muted" role="status">正在读取备份内容清单，每 5 秒更新一次。清单尚未确认的文件会保留其保护状态。</p>}
        <div className="backup-table-wrap"><table className="backup-table"><thead><tr><th className="backup-select-cell"><input type="checkbox" aria-label={available.length > 100 ? '选择前 100 份可删除备份' : '选择所有可删除备份'} disabled={!writable || !available.length} checked={!!selectAllIds.length && selectAllIds.every(id => selection.includes(id))} onChange={event => select(event.target.checked ? selectAllIds : [])} /></th><th>备份文件与内容</th><th>文件 / 磁盘占用</th><th>操作</th></tr></thead><tbody>{snapshot.archives.map(archive => <ArchiveRow key={archive.id} archive={archive} disabled={!writable} selected={selection.includes(archive.id)} onSelect={checked => select(checked ? [...selection, archive.id] : selection.filter(id => id !== archive.id))} onDelete={() => void openDeletion([archive.id])} />)}</tbody></table></div>{!snapshot.archives.length && <p className="backup-empty">还没有可确认的备份文件。</p>}
      </section>
      <section className="backup-panel"><div className="backup-panel-heading"><div><h2>删除记录</h2><p>记录实际删除结果，操作失败的文件不会计入已删除数量。</p></div></div><div className="backup-deletions">{snapshot.deletions.map(receipt => <article key={receipt.id}><div><strong>{statusText(receipt.status)}</strong><span>已删除 {receipt.deletedCount} 份 · {bytes(receipt.deletedBytes)}</span></div><small>{date(receipt.createdAt)} · 操作人：{receipt.actor}</small>{receipt.error && <p className="backup-error">{receipt.error}</p>}</article>)}{!snapshot.deletions.length && <p className="backup-muted">暂无删除记录。</p>}</div></section>
      <p className="backup-muted backup-updated">状态更新时间：{date(snapshot.generatedAt)} · 常规每 30 秒更新，页面隐藏时暂停。记录时间按浏览器当前时区显示。</p>
    </>}
    {dialog && !blocked && <DeleteDialog confirmation={dialog} busy={busy} error={error} onClose={() => setDialog(null)} onSubmit={submitDeletion} onRefresh={() => { const ids = dialog.preview.items.map(item => item.id); setDialog(null); void openDeletion(ids) }} />}
  </div>
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
