import { useEffect, useRef, useState } from 'react'
import { api, asAPIError } from '../../api/client'
import { Button } from '../ui'

const actionLabels: Record<string, string> = {
  schedule: '调整排期', create_task: '新增任务', update_progress: '更新任务进展',
  reassign_task: '调整负责人', register_risk: '登记项目风险',
  attach_deliverable: '关联交付物', submit_acceptance: '提交人工验收',
}
const stateLabels: Record<string, string> = {
  pending_confirmation: '等待确认', applied: '已执行', cancelled: '已撤销',
  expired: '已过期，请创建新提案', stale: '项目数据已变化，请重新预览',
}

type Change = { title: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null }
type Proposal = {
  id: string; kind: string; reason: string; state: string; reviewKey?: string | null
  changes: Change[]; result?: { receiptId?: string; url?: string } | null; error?: string | null
}

function values(fields: Record<string, unknown> | null) {
  if (!fields || !Object.keys(fields).length) return <span className="text-ink-500">无</span>
  return <dl className="space-y-1">{Object.entries(fields).map(([name, value]) => <div key={name} className="break-words">
    <dt className="inline font-medium">{name}：</dt>
    <dd className="inline whitespace-pre-wrap">{value == null ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value)}</dd>
  </div>)}</dl>
}

export function AgentProposalReview({ projectId, proposalId, onClose, onApplied }: {
  projectId: string; proposalId: string; onClose: () => void; onApplied: () => void
}) {
  const endpoint = `/project-ai/projects/${encodeURIComponent(projectId)}/agent-proposals/${encodeURIComponent(proposalId)}`
  const [proposal, setProposal] = useState<Proposal | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)
  const checkingCommit = useRef(false)

  useEffect(() => {
    const controller = new AbortController()
    api.get<Proposal>(endpoint, { signal: controller.signal }).then(({ data }) => {
      if (!controller.signal.aborted) {
        setProposal(data)
        if (checkingCommit.current && data.state === 'applied') onApplied()
        checkingCommit.current = false
      }
    }).catch(cause => {
      if (!controller.signal.aborted) setError(asAPIError(cause).detail)
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => controller.abort()
  }, [endpoint, attempt, onApplied])

  async function confirm() {
    if (submitting.current || proposal?.state !== 'pending_confirmation' || !proposal.reviewKey) return
    submitting.current = true
    setBusy(true)
    setError('')
    try {
      const { data } = await api.post<Proposal>(endpoint, { reviewKey: proposal.reviewKey })
      setProposal(data)
      if (data.state === 'applied') onApplied()
    } catch (cause) {
      setError(asAPIError(cause).detail)
      // A lost connection can also mean a successful commit. Check the stored result first.
      checkingCommit.current = true
      setProposal(null)
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  const resultUrl = proposal?.result?.url
  const localResultUrl = resultUrl?.startsWith(`/projects/${encodeURIComponent(projectId)}?`) && !resultUrl.includes('\\')
    ? resultUrl : null

  return <section className="card p-5 space-y-4" aria-label="核对 Agent 提案">
    <h2 className="font-semibold">核对 Agent 提案{proposal && ` · ${actionLabels[proposal.kind] ?? '项目操作'}`}</h2>
    {loading && <p role="status" className="text-sm text-ink-500">正在读取提案…</p>}
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    {proposal && <>
      <p className="text-sm font-medium" role="status">{stateLabels[proposal.state] ?? proposal.state}</p>
      <p className="text-sm whitespace-pre-wrap break-words">提案原因：{proposal.reason}</p>
      {proposal.error && <p className="text-sm text-red-700">{proposal.error}</p>}
      {proposal.result?.receiptId && <p className="text-sm">执行回执：{proposal.result.receiptId}</p>}
      {localResultUrl && <a className="text-sm text-brand-700 underline" href={localResultUrl}>查看更新后的记录</a>}
      <ul className="max-h-[28rem] overflow-auto space-y-2 text-sm" aria-label="提案影响">
        {proposal.changes.map((change, index) => <li key={index} className="rounded border border-ink-200 p-3">
          <h3 className="font-medium mb-2">{change.title}</h3>
          <div className="grid sm:grid-cols-2 gap-3">
            <div><p className="font-medium mb-1 text-ink-500">变更前</p>{values(change.before)}</div>
            <div><p className="font-medium mb-1 text-ink-500">变更后</p>{values(change.after)}</div>
          </div>
        </li>)}
      </ul>
    </>}
    <div className="flex flex-wrap gap-2">
      <Button onClick={onClose} disabled={busy}>关闭提案</Button>
      {error && !proposal && <Button onClick={() => { setLoading(true); setError(''); setAttempt(n => n + 1) }}>重新查询状态</Button>}
      {proposal?.state === 'pending_confirmation' && proposal.reviewKey && <Button variant="primary" disabled={busy}
        onClick={() => void confirm()}>{busy ? '正在执行…' : '确认执行提案'}</Button>}
    </div>
  </section>
}
