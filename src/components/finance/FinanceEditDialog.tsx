// 项目预算编辑（admin / cmc_lead）：总预算、已承诺、成本结构、财年、备注。
// 「已花费」不在此填写 —— 始终是该项目全部任务实际花费的合计（WBS 中录入），这里只读展示。

import { useEffect, useState, type FormEvent } from 'react'
import { Loader2, Save, Wallet, X } from 'lucide-react'
import type { Project } from '../../types'
import { Button } from '../ui'
import { getProjectSpan, getProjectTasks, type ProjectFinance } from '../../mock'
import { updateProjectFinanceEntry } from '../../data/bootstrap'
import { asAPIError } from '../../api/client'
import { FinanceFields } from './FinanceFields'
import { toFinanceDraft, financeDraftState, type FinanceDraft } from '../../lib/financeDraft'

export function FinanceEditDialog({ project, finance, onClose }: {
  project: Project
  finance?: ProjectFinance
  onClose: () => void
}) {
  // 已花费 / 任务预算合计：优先用后端汇总（含当前用户看不到的任务），离线或无预算记录时按可见任务计算
  const projTasks = getProjectTasks(project.id)
  const spent = finance?.spent ?? projTasks.reduce((a, t) => a + (t.actualCost ?? 0), 0)
  const taskBudget = finance?.taskBudget ?? projTasks.reduce((a, t) => a + (t.costBudget ?? 0), 0)
  const [draft, setDraft] = useState<FinanceDraft>(() => toFinanceDraft(finance, taskBudget, `${getProjectSpan(project).start.slice(0, 4)}-${getProjectSpan(project).end.slice(0, 4)}`))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !saving) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, saving])

  const { invalid, value } = financeDraftState(draft, spent)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (invalid || saving) return
    setSaving(true)
    setError('')
    try {
      await updateProjectFinanceEntry(project.id, value)
      onClose()
    } catch (e) {
      setError(asAPIError(e).status === 403 ? '当前账号没有修改该项目预算的权限。' : `保存失败：${asAPIError(e).detail}`)
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="finance-edit-title">
      <div className="absolute inset-0 bg-black/40" onClick={() => { if (!saving) onClose() }} />
      <form onSubmit={submit} noValidate className="relative w-full max-w-[600px] max-h-[90vh] bg-white rounded-xl shadow-2xl overflow-y-auto">
        <div className="flex items-center gap-2.5 px-5 py-4 border-b border-ink-300/40 sticky top-0 bg-white z-10">
          <Wallet className="w-5 h-5 text-brand-600" />
          <div className="min-w-0 flex-1">
            <h2 id="finance-edit-title" className="font-semibold text-ink-900">{finance ? '编辑项目预算' : '设置项目预算'}</h2>
            <p className="text-xs text-ink-500 truncate">{project.code} · {project.name} · 金额单位：万元</p>
          </div>
          <button type="button" aria-label="关闭" className="p-1 rounded hover:bg-ink-100 text-ink-500" onClick={onClose} disabled={saving}><X className="w-4 h-4" /></button>
        </div>

        <div className="p-5 space-y-5">
          <FinanceFields draft={draft} onChange={(d) => { setDraft(d); setError('') }} spent={spent} taskBudget={taskBudget} disabled={saving} />
          {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-ink-300/40 sticky bottom-0 bg-white">
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>取消</Button>
          <Button type="submit" variant="primary" disabled={invalid || saving} icon={saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}>
            {saving ? '正在保存…' : '保存预算'}
          </Button>
        </div>
      </form>
    </div>
  )
}
