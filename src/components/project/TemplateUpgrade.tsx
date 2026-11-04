import { useEffect, useState } from 'react'
import type { Project } from '../../types'
import { Card, CardHeader, CardBody, Button } from '../ui'
import { useDataStore } from '../../store/data'
import { refreshAllData } from '../../data/bootstrap'
import { asAPIError } from '../../api/client'
import { templateUpgradeApi, type TemplateUpgradeCatalog, type TemplateUpgradePreview, type TemplateMapping, type TemplateSubMapping, type TemplateOwnerOverride, type TemplateUpgradeChange } from '../../api/templateUpgrade'

const operation = (field: string, label: string) => field === 'add' ? '新增' : field === 'delete' ? '移除' : label

export function TemplateUpgrade({ project }: { project: Project }) {
  const online = useDataStore(s => s.mode) === 'api'
  const [catalog, setCatalog] = useState<TemplateUpgradeCatalog | null>(null)
  const [source, setSource] = useState('')
  const [target, setTarget] = useState('')
  const [mappings, setMappings] = useState<TemplateMapping[]>([])
  const [subMappings, setSubMappings] = useState<TemplateSubMapping[]>([])
  const [owners, setOwners] = useState<TemplateOwnerOverride[]>([])
  const [preview, setPreview] = useState<TemplateUpgradePreview | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [reason, setReason] = useState('')
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState('')
  const [reload, setReload] = useState(0)
  useEffect(() => {
    if (!online) return
    let live = true
    templateUpgradeApi.catalog(project.id).then(value => {
      if (!live) return
      setCatalog(value); setSource(value.sourceVersion ?? ''); setTarget(value.versions[0]?.version ?? '')
      setMappings(value.mappings ?? []); setSubMappings(value.subMappings ?? []); setOwners([])
    }).catch(error => { if (live) setMessage(asAPIError(error).detail) })
    return () => { live = false }
  }, [project.id, online, reload])
  const invalidate = () => { setPreview(null); setSelected([]); setMessage('') }
  const sourceVersion = catalog?.versions.find(v => v.version === source)
  const targetVersion = catalog?.versions.find(v => v.version === target)
  const request = { sourceVersion: source, targetVersion: target, mappings, subMappings, ownerOverrides: owners }
  const show = (value: unknown, change: TemplateUpgradeChange): string => {
    if (value == null) return '—'
    if (change.field === 'owner_id') return catalog?.members.find(m => m.id === value)?.name ?? '原负责人'
    if (change.field === 'sub_project_id' && typeof value === 'string') return catalog?.subProjects.find(s => s.id === value)?.name ?? targetVersion?.subs.find(s => `new:${s.nodeId}` === value)?.name ?? '目标子项目'
    if (change.field === 'dependencies' && Array.isArray(value)) return value.map(p => {
      if (!Array.isArray(p)) return ''
      const node = targetVersion?.nodes.find(n => n.nodeId === p[0]) ?? sourceVersion?.nodes.find(n => n.nodeId === p[0])
      return `${node?.name ?? '现有前置任务'} · ${p[1]} · 滞后 ${p[2]} 工作日`
    }).join('；') || '无前置任务'
    if (typeof value === 'object' && !Array.isArray(value)) {
      const v = value as Record<string, unknown>
      if (change.field === 'delete') return String(v.name ?? change.name)
      if (change.kind === 'sub') return `${v.name} · ${v.module} · ${v.stage}`
      return `${v.name} · ${v.code}\n${v.plannedStart} → ${v.plannedEnd}\n预计 ${v.estimatedEffort} 人日 · 预算 ${v.costBudget ?? '未填'} 万元`
    }
    if (typeof value === 'boolean') return value ? '是' : '否'
    return String(value)
  }
  const run = async (apply: boolean) => {
    setPending(true); setMessage('')
    try {
      if (apply && preview) {
        const result = await templateUpgradeApi.apply(project.id, { ...request, fingerprint: preview.fingerprint, selectedIds: selected, reason })
        await refreshAllData()
        setPreview(null); setSelected([]); setReload(v => v + 1)
        setMessage(`已应用 ${result.applied} 项，仍有 ${result.remaining} 项待选择。实际进度、工时、费用和交付记录均已保留。`)
      } else {
        const value = await templateUpgradeApi.preview(project.id, request)
        setPreview(value)
        setSelected(value.changes.filter(c => !c.blocked && c.field !== 'delete').map(c => c.id))
      }
    } catch (error) { setMessage(asAPIError(error).detail); if (apply) setPreview(null) }
    finally { setPending(false) }
  }
  if (!online) return <Card><CardBody>连接后端后可对比模板版本并升级真实项目。</CardBody></Card>
  return <Card><CardHeader title="模板版本升级" subtitle="选择要同步的变更，先核对差异再应用。项目执行记录保留；未采纳的差异下次仍可继续处理。" /><CardBody className="space-y-4">
    {!catalog && <p className="text-sm">{message || '正在读取模板与项目…'}</p>}
    {catalog && !catalog.templateId && <p className="text-sm text-ink-500">该项目从空白创建，未关联模板，不能直接升级。</p>}
    {catalog?.templateId && <>
      <p className="text-sm">关联模板：{catalog.templateName} · 项目当前版本：{catalog.sourceVersion ?? '未记录'}</p>
      {!catalog.editable && <p className="text-sm text-ink-500">模板升级由项目负责人或管理员处理。你可以查看各版本说明。</p>}
      <fieldset disabled={pending || !catalog.editable} className="space-y-3 disabled:opacity-60">
        <div className="flex flex-wrap gap-3">
          <label className="text-sm">来源版本<select aria-label="模板来源版本" className="input mt-1" value={source} onChange={e => { setSource(e.target.value); setMappings([]); setSubMappings([]); invalidate() }}><option value="">请选择项目最初使用的版本</option>{catalog.versions.map(v => <option key={v.version} value={v.version}>{v.version} · {v.summary}</option>)}</select></label>
          <label className="text-sm">目标版本<select aria-label="模板目标版本" className="input mt-1" value={target} onChange={e => { setTarget(e.target.value); setOwners([]); invalidate() }}>{catalog.versions.map(v => <option key={v.version} value={v.version}>{v.version} · {v.summary}</option>)}</select></label>
        </div>
        <details className="border rounded p-3" open={!!preview?.unmapped.length}><summary className="cursor-pointer text-sm">核对来源节点绑定及负责人（历史项目需要明确绑定）</summary>
          <p className="text-xs text-ink-500 mt-2">请按模板节点与项目实际任务的对应关系选择；系统只沿用准确的来源标识，不按名称猜测。目标新增任务默认由项目负责人负责，可在下方改派。</p>
          <div className="mt-2 max-h-80 overflow-auto space-y-2">
            {sourceVersion?.subs.map(node => <label className="grid grid-cols-2 items-center gap-2 text-sm" key={node.nodeId}><span className="truncate" title={node.name}>子项目 · {node.name}</span><select aria-label={`绑定子项目 ${node.name}`} className="input" value={subMappings.find(m => m.nodeId === node.nodeId)?.subProjectId ?? ''} onChange={e => { setSubMappings([...subMappings.filter(m => m.nodeId !== node.nodeId), ...(e.target.value ? [{ nodeId: node.nodeId, subProjectId: e.target.value }] : [])]); invalidate() }}><option value="">请选择对应子项目</option>{catalog.subProjects.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>)}
            {sourceVersion?.nodes.filter(node => !(catalog.removedNodes ?? []).includes(node.nodeId)).map(node => <label className="grid grid-cols-2 items-center gap-2 text-sm" key={node.nodeId}><span className="truncate" title={`${node.code} · ${node.name}`}>{node.code} · {node.name}</span><select aria-label={`绑定任务 ${node.name}`} className="input" value={mappings.find(m => m.nodeId === node.nodeId)?.taskId ?? ''} onChange={e => { setMappings([...mappings.filter(m => m.nodeId !== node.nodeId), ...(e.target.value ? [{ nodeId: node.nodeId, taskId: e.target.value }] : [])]); invalidate() }}><option value="">请选择对应任务</option>{catalog.tasks.map(t => <option key={t.id} value={t.id}>{t.code} · {t.name}</option>)}</select></label>)}
          </div>
          <details className="mt-3"><summary className="text-sm cursor-pointer">本次负责人调整</summary><div className="mt-2 max-h-64 overflow-auto space-y-2">{targetVersion?.nodes.map(node => <label key={node.nodeId} className="grid grid-cols-2 items-center gap-2 text-sm"><span className="truncate" title={node.name}>{node.name}</span><select aria-label={`升级负责人 ${node.name}`} className="input" value={owners.find(o => o.nodeId === node.nodeId)?.ownerId ?? ''} onChange={e => { setOwners([...owners.filter(o => o.nodeId !== node.nodeId), ...(e.target.value ? [{ nodeId: node.nodeId, ownerId: e.target.value }] : [])]); invalidate() }}><option value="">现有任务保留原负责人／新增由项目负责人负责</option>{catalog.members.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>)}</div></details>
        </details>
        <Button variant="primary" disabled={pending || !source || !target} onClick={() => void run(false)}>{pending ? '正在处理…' : '对比并预览升级'}</Button>
      </fieldset>
      {preview && <div className="space-y-3">
        {preview.unmapped.length > 0 && <p role="alert" className="text-sm bg-amber-50 text-amber-900 p-3 rounded">还有 {preview.unmapped.length} 个来源节点未绑定，请在上方核对后重新预览。</p>}
        {!preview.changes.length && !preview.unmapped.length && <div className="space-y-3"><p className="text-sm">该版本没有待同步的变更。</p>{catalog.sourceVersion !== target && <><label className="block text-sm">关联版本原因<input aria-label="关联版本原因" className="input mt-1" maxLength={2000} value={reason} onChange={e => setReason(e.target.value)} /></label><Button variant="primary" disabled={pending || !reason.trim() || !catalog.editable} onClick={() => void run(true)}>确认关联目标版本</Button></>}</div>}
        {preview.changes.length > 0 && <>
          <div className="flex items-center gap-3 text-sm"><span>差异 {preview.changes.length} 项 · 已选 {selected.length} 项</span><Button size="sm" disabled={pending} onClick={() => setSelected(preview.changes.filter(c => !c.blocked && c.field !== 'delete').map(c => c.id))}>选择全部非删除项</Button><Button size="sm" disabled={pending} onClick={() => setSelected([])}>清空选择</Button></div>
          <div className="max-h-96 overflow-auto rounded border"><table className="w-full text-xs"><thead className="sticky top-0 bg-ink-100"><tr><th className="p-2">选择</th><th className="p-2 text-left">节点 / 变更</th><th className="p-2 text-left">当前项目</th><th className="p-2 text-left">目标值</th></tr></thead><tbody>{preview.changes.map(c => <tr key={c.id} className="border-t"><td className="p-2"><input type="checkbox" aria-label={`选择 ${c.name} ${operation(c.field, c.label)}`} disabled={pending || !!c.blocked} checked={selected.includes(c.id)} onChange={e => setSelected(e.target.checked ? [...selected, c.id] : selected.filter(id => id !== c.id))} /></td><td className="p-2 min-w-40"><div className="max-w-64 truncate font-medium" title={c.name}>{c.kind === 'sub' ? '子项目 · ' : ''}{c.name}</div><div>{operation(c.field, c.label)}</div>{c.blocked && <div className="text-amber-800">{c.blocked}</div>}{c.requires.length > 0 && <div className="text-ink-500">需同时选择相关新增节点</div>}</td><td className="p-2 max-w-72 break-words whitespace-pre-wrap">{show(c.before, c)}</td><td className="p-2 max-w-72 break-words whitespace-pre-wrap text-brand-700">{show(c.after, c)}</td></tr>)}</tbody></table></div>
          <label className="block text-sm">升级原因<textarea aria-label="模板升级原因" className="input mt-1" maxLength={2000} value={reason} onChange={e => setReason(e.target.value)} /></label>
          <p className="text-xs text-ink-500">移除任务需单独勾选；已开始、已录实际工时或费用、已有讨论与交付记录的任务受保护。移除后空子项目保留。全部差异处理后才更新项目模板版本。</p>
          <Button variant="primary" disabled={pending || !selected.length || !reason.trim() || !!preview.unmapped.length || !catalog.editable} onClick={() => void run(true)}>确认应用 {selected.length} 项变更</Button>
        </>}
      </div>}
    </>}
    {message && catalog && <p role="status" className="text-sm bg-brand-50 p-3 rounded">{message}</p>}
  </CardBody></Card>
}
