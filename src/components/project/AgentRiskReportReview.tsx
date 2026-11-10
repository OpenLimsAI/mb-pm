import { useEffect, useState } from 'react'
import { api, asAPIError } from '../../api/client'
import SafeMarkdown from '../SafeMarkdown'
import { Button } from '../ui'

interface RiskReportReview {
  content: string
  reviewKey: string
}

export function AgentRiskReportReview({ projectId, expectedKey, onClose, onSaved }: {
  projectId: string
  expectedKey: string
  onClose: () => void
  onSaved: (reportId: string) => void
}) {
  const endpoint = `/project-ai/projects/${encodeURIComponent(projectId)}/agent-risk-report`
  const [preview, setPreview] = useState<RiskReportReview | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    api.get<RiskReportReview>(endpoint, { signal: controller.signal }).then(({ data }) => {
      if (!controller.signal.aborted) setPreview(data)
    }).catch(cause => {
      if (!controller.signal.aborted) setError(asAPIError(cause).detail)
    })
    return () => controller.abort()
  }, [endpoint, attempt])

  const refresh = () => {
    setError('')
    setPreview(null)
    setAttempt(value => value + 1)
  }

  async function save() {
    if (!preview || saving) return
    setSaving(true)
    setError('')
    try {
      const { data } = await api.post<{ reportId: string }>(endpoint, { reviewKey: preview.reviewKey })
      onSaved(data.reportId)
    } catch (cause) {
      const failure = asAPIError(cause)
      setError(failure.detail)
      if (failure.status === 409) setPreview(null)
    } finally {
      setSaving(false)
    }
  }

  return <section className="card p-5 space-y-3" aria-label="核对逾期任务报告">
    <h2 className="font-semibold">核对逾期任务报告</h2>
    {error && <p role="alert" className="text-red-700 text-sm">{error}</p>}
    {!preview && !error && <p role="status" className="text-sm text-ink-500">正在读取项目任务…</p>}
    {preview && <>
      {preview.reviewKey !== expectedKey && <p className="text-sm text-amber-800">
        当前可见数据与原链接中的快照不同，请核对这份报告后再保存。
      </p>}
      <div className="ai-report"><SafeMarkdown>{preview.content}</SafeMarkdown></div>
    </>}
    <div className="flex flex-wrap gap-2">
      <Button onClick={onClose} disabled={saving}>关闭预览</Button>
      {error && !preview && <Button onClick={refresh}>重新读取</Button>}
      <Button variant="primary" onClick={() => void save()} disabled={!preview || saving}>
        {saving ? '正在保存…' : '确认保存到分析记录'}
      </Button>
    </div>
  </section>
}
