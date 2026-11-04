import { useCallback, useEffect, useRef, useState } from 'react'
import type { Project } from '../../types'
import { Card, CardBody, CardHeader, Button } from '../ui'
import { useDataStore } from '../../store/data'
import { asAPIError } from '../../api/client'
import { progressPolicyApi, type ProgressMethod, type ProgressPolicyRequest, type ProgressPolicyResult } from '../../api/progressPolicy'
import { refreshAllData } from '../../data/bootstrap'

const names: Record<ProgressMethod, string> = { equal: '任务等权', effort: '预计工时加权', custom: '自定义权重' }
const amount = (value: number) => value.toLocaleString('zh-CN', { maximumFractionDigits: 4 })

export function ProgressPolicy({ project }: { project: Project }) {
  const online = useDataStore(s => s.mode) === 'api'
  const [current, setCurrent] = useState<ProgressPolicyResult | null>(null)
  const [method, setMethod] = useState<ProgressMethod>('equal')
  const [weights, setWeights] = useState<Record<string, string>>({})
  const [preview, setPreview] = useState<ProgressPolicyResult | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const generation = useRef(0)
  const cancelRequests = useCallback(() => { generation.current++ }, [])
  const load = useCallback(async () => {
    const request = ++generation.current
    setBusy(true)
    try {
      const value = await progressPolicyApi.get(project.id)
      if (request !== generation.current) return
      setCurrent(value); setMethod(value.method); setPreview(null)
      setWeights(Object.fromEntries(value.rows.map(r => [r.taskId, r.customWeight === null ? '' : String(r.customWeight)])))
    } catch (error) { if (request === generation.current) setMessage(asAPIError(error).detail) }
    finally { if (request === generation.current) setBusy(false) }
  }, [project.id])
  useEffect(() => {
    let active = true
    void Promise.resolve().then(() => { if (active && online) void load() })
    return () => { active = false; cancelRequests() }
  }, [online, load, cancelRequests])
  const invalidate = () => { setPreview(null); setMessage('') }
  const request = (): ProgressPolicyRequest => {
    const changes = current?.rows.filter(row => {
      const raw = weights[row.taskId] ?? ''
      return (raw === '' ? null : Number(raw)) !== row.customWeight
    }).map(row => {
      const raw = weights[row.taskId] ?? ''
      if (raw !== '' && (!/^\d+(\.\d{1,4})?$/.test(raw) || !Number.isFinite(Number(raw)) || Number(raw) > 999999.9999)) throw new Error('权重须为 0–999999.9999 的数字，最多 4 位小数；留空使用默认权重。')
      return { taskId: row.taskId, value: raw === '' ? null : Number(raw) }
    }) ?? []
    return { method, weights: changes }
  }
  const run = async (save: boolean) => {
    if (!online || !current?.editable) return
    const epoch = ++generation.current
    setBusy(true); setMessage('')
    try {
      const value = request()
      if (save) {
        await progressPolicyApi.save(project.id, { ...value, fingerprint: preview?.fingerprint, reason })
        if (epoch !== generation.current) return
        await refreshAllData()
        if (epoch !== generation.current) return
        setReason(''); await load(); setMessage('进度计算规则已保存，项目与子项目进度已重新汇总。')
      } else {
        const result = await progressPolicyApi.preview(project.id, value)
        if (epoch === generation.current) setPreview(result)
      }
    } catch (error) {
      if (epoch === generation.current) { setMessage(error instanceof Error && !('response' in error) ? error.message : asAPIError(error).detail); if (save) setPreview(null) }
    } finally { if (epoch === generation.current) setBusy(false) }
  }
  const shown = preview ?? current
  return <Card><CardHeader title="进度计算规则" subtitle="查看每项任务对项目进度的贡献。修改规则先预览，再填写原因保存。" /><CardBody className="space-y-4">
    {!online && <p className="text-sm text-ink-500">连接后端后可查看并配置真实项目的计算规则。</p>}
    {online && !current && <Button disabled={busy} onClick={() => void load()}>{busy ? '正在载入…' : '重新载入计算规则'}</Button>}
    {current && online && <>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">计算方式<select aria-label="进度计算方式" className="input mt-1" value={method} disabled={!current.editable || busy} onChange={e => { setMethod(e.target.value as ProgressMethod); invalidate() }}>{Object.entries(names).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
        {current.editable && <><Button disabled={busy} onClick={() => void run(false)}>预览计算结果</Button><Button disabled={busy} onClick={() => { setMessage(''); void load() }}>放弃修改并重新载入</Button></>}
      </div>
      <p className="text-sm text-ink-600">{current.rules[method]}</p>
      <p className="text-xs text-ink-500">{current.rules.formula}</p>
      {!current.editable && <p className="text-xs text-ink-500">计算规则由管理员或本项目负责人维护。</p>}
    </>}
    {shown && <>
      <div className="bg-brand-50 rounded-lg p-3 text-sm" aria-live="polite">
        <p className="font-medium">{preview ? `预览：${preview.beforeProgress}% → ${preview.progress}%` : `当前计算：${shown.progress}%`} · {names[shown.method]}</p>
        <p className="mt-1">{amount(shown.numerator)} ÷ {amount(shown.denominator)} = {amount(shown.exactProgress)}%，显示为 {shown.progress}%</p>
        {!shown.denominator && <p className="mt-1 text-amber-800">总权重为 0，当前规则下进度为 0%。可补充预计工时或自定义权重。</p>}
        {!!current?.hiddenTaskCount && <p className="mt-1">项目汇总包含 {current.hiddenTaskCount} 项当前账号不可查看的任务，下表仅显示有权访问的任务。</p>}
      </div>
      <div className="overflow-auto max-h-[32rem] rounded border"><table className="w-full text-sm min-w-[650px]"><thead className="bg-ink-50 sticky top-0"><tr><th className="p-2 text-left">任务</th><th className="p-2 text-right">任务进度</th>{method === 'custom' && <th className="p-2 text-right">自定义权重</th>}<th className="p-2 text-right">{preview ? '预览' : '当前'}有效权重</th><th className="p-2 text-right">占比</th><th className="p-2 text-right">进度贡献</th></tr></thead><tbody>{shown.rows.map(row => <tr className="border-t" key={row.taskId}>
        <td className="p-2 max-w-80 truncate" title={`${row.code} · ${row.name}`}>{row.isMilestone ? '◇ ' : ''}{row.name}<span className="text-xs text-ink-400 ml-2">{row.code}</span></td>
        <td className="p-2 text-right">{row.progress}%</td>
        {method === 'custom' && <td className="p-2 text-right"><input aria-label={`${row.name}的进度权重`} type="number" min="0" max="999999.9999" step="0.0001" className="input w-28 text-right" placeholder={row.isMilestone ? '默认 0' : '默认 1'} value={weights[row.taskId] ?? ''} disabled={!current?.editable || busy} onChange={e => { setWeights({ ...weights, [row.taskId]: e.target.value }); invalidate() }} /></td>}
        <td className="p-2 text-right">{amount(row.effectiveWeight)}</td><td className="p-2 text-right">{amount(row.share * 100)}%</td><td className="p-2 text-right">{amount(row.contribution)} 个百分点</td>
      </tr>)}</tbody></table></div>
      {!!shown.subprojects.length && <details className="text-sm"><summary className="cursor-pointer">子项目汇总</summary><div className="mt-2 space-y-1">{shown.subprojects.map(sub => <p key={sub.id}>{sub.name}：{sub.progress}%（{amount(sub.numerator)} ÷ {amount(sub.denominator)}）</p>)}</div></details>}
    </>}
    {preview && current?.editable && <div className="space-y-3"><label className="block text-sm">计算规则修改原因<input aria-label="计算规则修改原因" maxLength={2000} className="input mt-1" value={reason} onChange={e => setReason(e.target.value)} disabled={busy} placeholder="例如：按各阶段预计投入反映真实完成比例" /></label><Button variant="primary" disabled={busy || !preview.changed || !reason.trim()} onClick={() => void run(true)}>{busy ? '正在保存…' : '确认保存计算规则'}</Button></div>}
    {message && <p role="status" className="text-sm rounded bg-brand-50 p-3">{message}</p>}
  </CardBody></Card>
}
