// 项目预算编辑（admin / cmc_lead）：总预算、已承诺、成本结构、财年、备注。
// 「已花费」不在此填写 —— 始终是该项目全部任务实际花费的合计（WBS 中录入），这里只读展示。

import { useEffect, useState, type FormEvent } from 'react'
import { Coins, Loader2, Save, Wallet, X } from 'lucide-react'
import type { Project } from '../../types'
import { Button, Field } from '../ui'
import { FINANCE_CATEGORIES, getProjectTasks, type ProjectFinance } from '../../mock'
import { updateProjectFinanceEntry } from '../../data/bootstrap'
import { asAPIError } from '../../api/client'

const MAX_AMOUNT = 99_999_999
const fmt = (v: number) => `¥${(Math.round(v * 100) / 100).toLocaleString('zh-CN')}万`

type Draft = { totalBudget: string; committed: string; fiscalYear: string; notes: string; breakdown: Record<string, string> }

function toDraft(finance: ProjectFinance | undefined, suggested: number, project: Project): Draft {
  const text = (v: number | undefined) => (v ? String(v) : '')
  return {
    totalBudget: finance ? String(finance.totalBudget) : suggested ? String(suggested) : '',
    committed: text(finance?.committed),
    fiscalYear: finance?.fiscalYear ?? `${project.plannedStart.slice(0, 4)}-${project.plannedEnd.slice(0, 4)}`,
    notes: finance?.notes ?? '',
    breakdown: Object.fromEntries(FINANCE_CATEGORIES.map((c) => [c, text(finance?.breakdown?.[c])])),
  }
}

/** 空串按 0；非法返回 null。 */
function amount(value: string): number | null {
  if (!value.trim()) return 0
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 && n <= MAX_AMOUNT ? Math.round(n * 100) / 100 : null
}

export function FinanceEditDialog({ project, finance, onClose }: {
  project: Project
  finance?: ProjectFinance
  onClose: () => void
}) {
  // 已花费 / 任务预算合计：优先用后端汇总（含当前用户看不到的任务），离线或无预算记录时按可见任务计算
  const projTasks = getProjectTasks(project.id)
  const spent = finance?.spent ?? projTasks.reduce((a, t) => a + (t.actualCost ?? 0), 0)
  const taskBudget = finance?.taskBudget ?? projTasks.reduce((a, t) => a + (t.costBudget ?? 0), 0)
  const [draft, setDraft] = useState<Draft>(() => toDraft(finance, taskBudget, project))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !saving) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, saving])

  const total = amount(draft.totalBudget)
  const committed = amount(draft.committed)
  const parts = Object.fromEntries(FINANCE_CATEGORIES.map((c) => [c, amount(draft.breakdown[c] ?? '')]))
  const partsInvalid = Object.values(parts).some((v) => v === null)
  const partsTotal = Object.values(parts).reduce<number>((a, v) => a + (v ?? 0), 0)
  const totalMissing = !draft.totalBudget.trim()
  const invalid = totalMissing || total === null || committed === null || partsInvalid
    || draft.fiscalYear.trim().length > 20 || draft.notes.trim().length > 200
  const remaining = (total ?? 0) - spent - (committed ?? 0)
  const set = (patch: Partial<Draft>) => { setDraft((d) => ({ ...d, ...patch })); setError('') }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (invalid || saving) return
    setSaving(true)
    setError('')
    try {
      await updateProjectFinanceEntry(project.id, {
        totalBudget: total ?? 0,
        committed: committed ?? 0,
        breakdown: Object.fromEntries(FINANCE_CATEGORIES.map((c) => [c, parts[c] ?? 0])),
        fiscalYear: draft.fiscalYear.trim() || null,
        notes: draft.notes.trim() || null,
      })
      onClose()
    } catch (e) {
      setError(asAPIError(e).status === 403 ? '只有系统管理员或 CMC 负责人可以修改项目预算。' : `保存失败：${asAPIError(e).detail}`)
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

        <fieldset disabled={saving} className="p-5 space-y-5">
          <div className="grid sm:grid-cols-2 gap-4">
            <Field label="项目总预算（万元）" error={totalMissing ? '请填写总预算' : total === null ? '请输入 0–99,999,999 之间的金额' : null}>
              <input className="input tabular-nums" inputMode="decimal" value={draft.totalBudget} onChange={(e) => set({ totalBudget: e.target.value })} autoFocus />
            </Field>
            <Field label="已承诺（万元）" hint="已签合同 / 已下单、尚未支付的金额" error={committed === null ? '请输入 0–99,999,999 之间的金额' : null}>
              <input className="input tabular-nums" inputMode="decimal" value={draft.committed} onChange={(e) => set({ committed: e.target.value })} placeholder="0" />
            </Field>
          </div>

          <div className="rounded-lg bg-ink-100/70 p-3 text-sm grid sm:grid-cols-3 gap-3">
            <div>
              <div className="text-xs text-ink-500">已花费（自动）</div>
              <div className="font-semibold text-ink-900 tabular-nums">{fmt(spent)}</div>
              <div className="text-[11px] text-ink-500 mt-0.5">任务实际花费合计</div>
            </div>
            <div>
              <div className="text-xs text-ink-500 flex items-center gap-1"><Coins className="w-3 h-3 text-amber-500" />任务预算合计</div>
              <div className="font-semibold text-ink-900 tabular-nums">{fmt(taskBudget)}</div>
              {taskBudget > 0 && total !== taskBudget && (
                <button type="button" className="text-[11px] text-brand-700 hover:underline mt-0.5" onClick={() => set({ totalBudget: String(taskBudget) })}>填入为总预算</button>
              )}
            </div>
            <div>
              <div className="text-xs text-ink-500">剩余（保存后）</div>
              <div className={`font-semibold tabular-nums ${remaining < 0 ? 'text-red-600' : 'text-emerald-700'}`}>{total === null || committed === null ? '—' : fmt(remaining)}</div>
              <div className="text-[11px] text-ink-500 mt-0.5">总预算 − 已花费 − 已承诺</div>
            </div>
          </div>
          <p className="text-[11px] text-ink-500 -mt-2">任务成本只含外包、耗材、CRO 等，不含内部人力；总预算口径建议与之一致，便于对比执行率。</p>

          <div>
            <div className="flex items-baseline justify-between mb-2">
              <span className="text-sm font-medium text-ink-900">成本结构（可选，手工填报）</span>
              <span className="text-xs text-ink-500 tabular-nums">合计 {fmt(partsTotal)}</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              {FINANCE_CATEGORIES.map((c) => (
                <label key={c} className="text-xs text-ink-600 space-y-1">
                  <span>{c}</span>
                  <input
                    className={`input tabular-nums ${parts[c] === null ? 'border-red-400' : ''}`}
                    inputMode="decimal"
                    aria-label={`成本结构：${c}（万元）`}
                    value={draft.breakdown[c] ?? ''}
                    placeholder="0"
                    onChange={(e) => set({ breakdown: { ...draft.breakdown, [c]: e.target.value } })}
                  />
                </label>
              ))}
            </div>
            {partsInvalid && <p className="text-xs text-red-600 mt-1">请输入 0–99,999,999 之间的金额</p>}
          </div>

          <div className="grid sm:grid-cols-[160px_1fr] gap-4">
            <Field label="财年" error={draft.fiscalYear.trim().length > 20 ? '最多 20 个字符' : null}>
              <input className="input" value={draft.fiscalYear} onChange={(e) => set({ fiscalYear: e.target.value })} placeholder="如 2026-2028" maxLength={20} />
            </Field>
            <Field label="备注" error={draft.notes.trim().length > 200 ? '最多 200 个字符' : null}>
              <input className="input" value={draft.notes} onChange={(e) => set({ notes: e.target.value })} maxLength={200} />
            </Field>
          </div>
          {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        </fieldset>

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
